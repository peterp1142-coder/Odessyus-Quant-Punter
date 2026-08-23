import type { ReActStep } from '../react-engine.js';
import type { SubAgentResult } from './base.js';
import { buildSystemPrompt } from '../prompts.js';
import { mistralPool } from '../mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../checkpoint.js';
import { runMonteCarlo } from '../monte-carlo.js';
import { score, calcKelly } from '../scorer.js';
import { extractFeatures } from '../feature-extractor.js';
import { getCalibrationStatus } from '../calibration.js';

export interface SelectedBet {
  status: 'BET' | 'NO_BET' | 'CONSIDER' | 'SKIP' | 'UNVALIDATED' | string;
  market: string;
  selection: string;
  probability_pct: number | null;
  odds: number | null;
  ev_pct: number | null;
  confidence_pct: number;
  reason?: string;
  validation?: 'VALIDATED' | 'UNVALIDATED' | 'UNVERIFIED' | string;
}

export interface QuantResult {
  finalAnswer: string;
  steps: ReActStep[];
  success: boolean;
  error?: string;
  monteCarlo: { home: number; draw: number; away: number; stdDev: number; simCount: number };
  trueProb: number;
  impliedProb: number;
  expectedValue: number;
  starRating: number;
  dataCompletenessScore: number;
  isValueBet: boolean;
  recommendedStake: string;
  recommendedOdds: number;
  confidence: number;
  goalStatement: string;
  categoryProbabilities: { market: number; form: number; injury: number; sentiment: number; tactical: number };
  primaryBet?: SelectedBet;
  alternativePicks?: SelectedBet[];
}

function statusLabel(market: string): string {
  const c = getCalibrationStatus(market);
  if (!c) return 'UNVALIDATED';
  if (c.samples < 50) return `WARMING (${c.samples} samples)`;
  return c.edgeValidated ? 'VALIDATED' : 'CALIBRATED / NOT VALIDATED';
}

function evidenceText(result?: SubAgentResult): string {
  if (!result) return '';
  return result.rawOutput || JSON.stringify(result.data || {});
}

function buildEvidenceSummary(args: {
  oddsResult: SubAgentResult;
  formResult: SubAgentResult;
  injuryResult: SubAgentResult;
  sentimentResult: SubAgentResult;
  lineupResult?: SubAgentResult;
  advancedText: string;
}): string {
  return [
    '=== ODDS ===', evidenceText(args.oddsResult).slice(0, 4500),
    '=== FORM ===', evidenceText(args.formResult).slice(0, 4500),
    '=== INJURY ===', evidenceText(args.injuryResult).slice(0, 3500),
    '=== SENTIMENT ===', evidenceText(args.sentimentResult).slice(0, 3500),
    '=== LINEUP ===', evidenceText(args.lineupResult).slice(0, 3500),
    '=== ADVANCED ===', args.advancedText.slice(0, 4500),
  ].join('\n');
}

function balancedJsonCandidates(raw: string): string[] {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const out: string[] = [];
  for (const open of ['{', '[']) {
    let start = -1, depth = 0, str = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (start < 0) { if (c === open) { start = i; depth = 1; } continue; }
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') { str = true; continue; }
      if (c === open) depth++;
      else if ((open === '{' && c === '}') || (open === '[' && c === ']')) depth--;
      if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

const PLACEHOLDER_SELECTIONS = new Set([
  'model lead', 'model-lead', 'model_lead', 'n/a', 'na', 'none', 'unknown', 'unavailable',
  'no bet', 'skip', 'unvalidated', 'unverified', 'null', 'undefined', 'tbc', 'tbd', '-', '—', ''
]);
const PLACEHOLDER_MARKETS = new Set([
  'n/a', 'na', 'none', 'unknown', 'unavailable', 'no bet', 'model lead', 'model-lead', 'model_lead', ''
]);

function cleanText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isConcreteSelection(market: unknown, selection: unknown): boolean {
  const m = cleanText(market).toLowerCase();
  const s = cleanText(selection).toLowerCase();
  if (PLACEHOLDER_MARKETS.has(m) || PLACEHOLDER_SELECTIONS.has(s)) return false;
  if (!m || !s) return false;
  if (/^(model\s*lead|model prediction|prediction lead)$/i.test(s)) return false;
  if (/^(n\/a|none|unknown|unavailable|no bet)$/i.test(m)) return false;
  if (/^(?:match result|1x2|result)$/i.test(m) && !/^(home|away|draw|[12])$/i.test(s)) {
    return !/^(model|prediction|lead|home team|away team)$/i.test(s);
  }
  if (/under\s*2\.5/i.test(m) || /under\s*2\.5/i.test(s)) return /under\s*2\.5/i.test(s) || /under\s*2\.5/i.test(m);
  if (/over\s*2\.5/i.test(m) || /over\s*2\.5/i.test(s)) return /over\s*2\.5/i.test(s) || /over\s*2\.5/i.test(m);
  if (/under\s*3\.5/i.test(m) || /under\s*3\.5/i.test(s)) return /under\s*3\.5/i.test(s) || /under\s*3\.5/i.test(m);
  if (/over\s*3\.5/i.test(m) || /over\s*3\.5/i.test(s)) return /over\s*3\.5/i.test(s) || /over\s*3\.5/i.test(m);
  if (/btts|both teams/i.test(m)) return /^(yes|no|btts\s+(yes|no)|both teams to score\s+(yes|no))$/i.test(s);
  if (/double chance/i.test(m)) return /^(1x|x2|12)$/i.test(s);
  if (/asian\s*handicap|handicap/i.test(m)) return /(?:home|away|\+|-)\s*(?:0|0\.5|1|1\.5|2|2\.5|3)(?:\b|\.0\b)/i.test(s);
  return !/^(model|prediction|lead|placeholder|candidate)$/i.test(s);
}

function normalizeConcreteSelection(market: string, selection: string): string {
  const m = cleanText(market);
  const s = cleanText(selection);
  if (/under\s*2\.5/i.test(m) && !/under\s*2\.5/i.test(s)) return 'Under 2.5';
  if (/over\s*2\.5/i.test(m) && !/over\s*2\.5/i.test(s)) return 'Over 2.5';
  if (/under\s*3\.5/i.test(m) && !/under\s*3\.5/i.test(s)) return 'Under 3.5';
  if (/over\s*3\.5/i.test(m) && !/over\s*3\.5/i.test(s)) return 'Over 3.5';
  if (/double chance/i.test(m)) return s.toUpperCase();
  return s;
}

function noBetFallback(confidence: number, reason: string): SelectedBet {
  return {
    status: 'NO_BET', market: 'N/A', selection: 'N/A', probability_pct: null, odds: null, ev_pct: null,
    confidence_pct: confidence, reason, validation: 'UNVERIFIED'
  };
}

function sanitizeBet(input: any, fallbackConfidence: number): SelectedBet {
  const market = cleanText(input?.market);
  const rawSelection = cleanText(input?.selection);
  const status = cleanText(input?.status || 'NO_BET') || 'NO_BET';
  if (!isConcreteSelection(market, rawSelection)) {
    return noBetFallback(fallbackConfidence, `No concrete betting selection was produced. Model output was rejected as non-bettable: ${market || 'missing market'} / ${rawSelection || 'missing selection'}.`);
  }
  const selection = normalizeConcreteSelection(market, rawSelection);
  return {
    status,
    market,
    selection,
    probability_pct: Number.isFinite(Number(input?.probability_pct)) ? Number(input.probability_pct) : null,
    odds: Number.isFinite(Number(input?.odds)) ? Number(input.odds) : null,
    ev_pct: Number.isFinite(Number(input?.ev_pct)) ? Number(input.ev_pct) : null,
    confidence_pct: Number(input?.confidence_pct) || fallbackConfidence,
    reason: typeof input?.reason === 'string' ? input.reason : undefined,
    validation: typeof input?.validation === 'string' ? input.validation : 'UNVERIFIED',
  };
}

function parseSelectionPayload(answer: string, fallback: SelectedBet): { primary: SelectedBet; alternatives: SelectedBet[]; primaryBet: SelectedBet; alternativePicks: SelectedBet[] } {
  let primary = sanitizeBet(fallback, fallback.confidence_pct);
  let alternatives: SelectedBet[] = [];
  try {
    const pm = answer.match(/PRIMARY_BET\s*:\s*([\s\S]*?)(?=\n\s*ALTERNATIVE_PICKS\s*:|$)/i);
    if (pm) {
      for (const candidate of balancedJsonCandidates(pm[1])) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && typeof parsed.market === 'string' && typeof parsed.selection === 'string') {
            const next = sanitizeBet(parsed, fallback.confidence_pct);
            if (next.market !== 'N/A' && next.selection !== 'N/A') {
              primary = next;
              break;
            }
            if (next.status === 'NO_BET') primary = next;
          }
        } catch {}
      }
    }
    const am = answer.match(/ALTERNATIVE_PICKS\s*:\s*([\s\S]*?)(?=\n\s*(?:FINAL_ANSWER|WRITING RULES|AVAILABLE EVIDENCE|$))/i);
    if (am) {
      for (const candidate of balancedJsonCandidates(am[1])) {
        try {
          const parsed = JSON.parse(candidate);
          if (!Array.isArray(parsed)) continue;
          alternatives = parsed.filter((p: any) => p && typeof p.market === 'string' && typeof p.selection === 'string')
            .map((p: any) => sanitizeBet({ ...p, status: p.status || 'UNVALIDATED' }, fallback.confidence_pct))
            .filter((p: SelectedBet) => p.market !== 'N/A' && p.selection !== 'N/A')
            .slice(0, 3);
          if (alternatives.length) break;
        } catch {}
      }
    }
  } catch {}
  return { primary, alternatives, primaryBet: primary, alternativePicks: alternatives };
}

export async function runQuantSynthesis(opts: {
  userQuery: string; fixture: string; sport: string; market: string; sessionId?: string;
  oddsResult: SubAgentResult; formResult: SubAgentResult; injuryResult: SubAgentResult; sentimentResult: SubAgentResult;
  lineupResult?: SubAgentResult; advancedText?: string; onStep: (step: ReActStep) => void; isMultiFixture?: boolean; discoveredFixtures?: string[];
}): Promise<QuantResult> {
  const { userQuery, fixture, sport, market = 'Match Result', sessionId = 'default', oddsResult, formResult, injuryResult, sentimentResult, lineupResult, advancedText = '', onStep } = opts;
  const steps: ReActStep[] = [];
  const emit = (step: ReActStep) => { const stamped = { ...step, timestamp: new Date().toISOString() }; steps.push(stamped); onStep(stamped); };
  const existing = await loadCheckpoint(sessionId, 'QuantSynthesis');
  if (existing) await clearCheckpoint(sessionId, 'QuantSynthesis');
  emit({ type: 'status', content: `⚡ QuantSynthesis: scoring ${fixture} from all available evidence…` });
  const lineupText = evidenceText(lineupResult);
  const features = await extractFeatures({ formText: evidenceText(formResult), oddsText: evidenceText(oddsResult), injuryText: [evidenceText(injuryResult), lineupText].filter(Boolean).join('\n=== LINEUP ===\n'), sentimentText: evidenceText(sentimentResult), advancedText, fixture, market });
  if (!features.evidenceReady) emit({ type: 'thought', content: `⚠️ Partial evidence for ${fixture}; proceeding with available data. Missing fields reduce confidence and disable validated-edge promotion.` });
  const injuryAdjustHome = Math.min(0.5, (features.injury.injuryIndexHome / 10) * 0.4 + ((features.injury.absentPlayerRatingHome ?? 0) / 10) * 0.1);
  const injuryAdjustAway = Math.min(0.5, (features.injury.injuryIndexAway / 10) * 0.4 + ((features.injury.absentPlayerRatingAway ?? 0) / 10) * 0.1);
  const mc = runMonteCarlo({ xgHome: features.form.xgHome, xgAway: features.form.xgAway, homeAdvantage: 0.15, dixonColesRho: -0.1, injuryAdjustHome, injuryAdjustAway });
  const selectionOdds = features.market.selectionOdds;
  const impliedProb = features.market.selectionImpliedProb ?? (selectionOdds && selectionOdds > 1 ? 1 / selectionOdds : 0);
  const scored = score({ market, mcResult: mc, marketSignals: features.market, formSignals: features.form, injurySignals: features.injury, sentimentSignals: features.sentiment, advancedSignals: features.advanced, targetOdds: selectionOdds });
  const trueProb = scored.finalProbability; const ev = scored.expectedValue; const kelly = calcKelly(trueProb, selectionOdds ?? 0); const calibration = statusLabel(market);
  emit({ type: 'thought', content: `📐 ${fixture}: model ${(trueProb * 100).toFixed(1)}% | data ${scored.dataCompletenessScore}% | calibration ${calibration} | odds ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'} | Monte Carlo ${mc.simCount.toLocaleString()} simulations` });
  const evidenceSummary = buildEvidenceSummary({ oddsResult, formResult, injuryResult, sentimentResult, lineupResult, advancedText });
  const prompt = `${buildSystemPrompt()}\n\nCURRENT EVIDENCE PREDICTION + BET SELECTION MODE\nThe system MUST produce a prediction for the real fixture whenever there is usable evidence. Missing calibration, missing exact odds, incomplete form, missing lineup data, or unavailable advanced fields are NOT fatal errors.\nAfter analyzing the supplied evidence, you must make ONE explicit primary betting decision across ALL markets explicitly supported by the evidence. Do not default to 1X2.\n\nPRIMARY BET SELECTION RULES\n1. The primary decision is the single BEST PLAUSIBLE PICK for this fixture, not the highest raw simulated probability.\n2. Prefer a verified, liquid market with a positive risk-adjusted edge, strong evidence agreement, acceptable data completeness, acceptable model risk, and calibration when available.\n3. A very high model probability by itself is NOT enough. Penalize markets driven by weak/old data, speculative lineups, suspicious odds, missing current prices, or extreme model assumptions.\n4. Never invent odds, probabilities, market names, player props, or calibration data.\n5. A selection may be PRIMARY_BET only when its price is verified and deterministic betting gates allow a real wager. Otherwise use NO_BET and give the strongest watchlist candidate separately.\n6. Do not call an unvalidated market a validated value bet.\n7. If two markets are close, prefer better evidence quality, market liquidity, and lower model risk.\n8. The primary bet must be one concrete selection, such as Man Utd to win, Under 2.5 Goals, BTTS No, Everton +0.5 AH, Over 4.5 Cards, or a specific player prop, with exact verified odds when available.\n\nFIXTURE: ${fixture}\nSPORT: ${sport}\nUSER TARGET MARKET: ${market}\nTRUE PROBABILITY FOR TARGET MARKET: ${(trueProb * 100).toFixed(1)}%\nIMPLIED PROBABILITY FOR TARGET MARKET: ${impliedProb > 0 ? `${(impliedProb * 100).toFixed(1)}%` : 'UNVERIFIED'}\nTARGET ODDS: ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}\nTARGET EXPECTED VALUE: ${(ev * 100).toFixed(2)}%\nDATA COMPLETENESS: ${scored.dataCompletenessScore}%\nCONFIDENCE: ${Math.round(scored.dataCompletenessScore)}%\nSTARS: ${scored.starRating}/5\nTARGET RECOMMENDED STAKE: ${scored.recommendedStake}\nTARGET KELLY HALF: ${kelly.halfKelly}%\nTARGET CALIBRATION: ${calibration}\nTARGET CALIBRATION NOTE: ${scored.calibrationNote}\nTARGET VALUE-BET STATUS: ${scored.isValueBet ? 'VALIDATED VALUE BET' : 'NOT A VALIDATED VALUE BET'}\nTARGET GATE NOTE: ${scored.gateFailReason || 'No blocking gate'}\n\nMONTE CARLO (ACTUAL ${mc.simCount.toLocaleString()} SIMULATIONS):\nHome ${(mc.homeWin * 100).toFixed(1)}%\nDraw ${(mc.draw * 100).toFixed(1)}%\nAway ${(mc.awayWin * 100).toFixed(1)}%\nBTTS ${(mc.btts * 100).toFixed(1)}%\nOver 2.5 ${(mc.over25 * 100).toFixed(1)}%\nUnder 2.5 ${(mc.under25 * 100).toFixed(1)}%\nOver 3.5 ${(mc.over35 * 100).toFixed(1)}%\nUnder 3.5 ${(mc.under35 * 100).toFixed(1)}%\nDNB Home ${(mc.dnbHome * 100).toFixed(1)}%\nDNB Away ${(mc.dnbAway * 100).toFixed(1)}%\nAsian Home +0.5 ${(mc.ahHome05 * 100).toFixed(1)}%\nAsian Away +0.5 ${(mc.ahAway05 * 100).toFixed(1)}%\nAsian Home +1.5 ${(mc.ahHome15 * 100).toFixed(1)}%\nAsian Away +1.5 ${(mc.ahAway15 * 100).toFixed(1)}%\n\nAVAILABLE RESEARCH:\n${evidenceSummary}\n\nFINAL RESPONSE CONTRACT\nAt the top of the detailed analysis include:\nPRIMARY_BET:\n{"status":"BET|NO_BET","market":"...","selection":"...","probability_pct":number|null,"odds":number|null,"ev_pct":number|null,"confidence_pct":number,"reason":"...","validation":"VALIDATED|UNVALIDATED|UNVERIFIED"}\nALTERNATIVE_PICKS:\n[{"market":"...","selection":"...","probability_pct":number|null,"odds":number|null,"ev_pct":number|null,"status":"CONSIDER|SKIP|UNVALIDATED"}]\n\nThe PRIMARY_BET must be the agent's own selected pick among all plausible researched markets. If no market survives the betting gates, use NO_BET and do not force a wager. Give the strongest watchlist candidate as an alternative.\n\nWRITING RULES\n1. Always return a prediction when the fixture is real and some evidence exists.\n2. Clearly distinguish model prediction from the selected betting decision.\n3. Never invent an odds price, calibration sample, lineup, injury or statistic that is absent.\n4. When evidence is sparse, explicitly say confidence/data completeness is reduced.\n5. Do not output NO QUALIFIED ANALYSIS merely because calibration or exact-market odds are missing.\n6. Use deterministic probabilities above; do not replace them with guesses.\n7. Do not describe the largest Monte Carlo probability as the primary bet unless it is actually the best risk-adjusted market.\n8. When referencing Monte Carlo, use exactly ${mc.simCount.toLocaleString()} simulations.\n\nWrite FINAL_ANSWER with the primary bet block first, followed by alternatives and the full fixture analysis.`;
  try {
    const response = await mistralPool.call(c => c.chat.complete({ model: 'mistral-large-latest', messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Select the single best plausible betting pick for ${fixture}, then write the full analysis.` }] as any, temperature: 0.1, maxTokens: 7000 }));
    const answer = String(response.choices?.[0]?.message?.content || '');
    const fallback: SelectedBet = scored.isValueBet
      ? { status: 'BET', market, selection: market, probability_pct: trueProb * 100, odds: selectionOdds, ev_pct: ev * 100, confidence_pct: scored.dataCompletenessScore, reason: scored.gateFailReason || 'Selected by quantitative gate.', validation: calibration }
      : { status: 'NO_BET', market: 'N/A', selection: 'N/A', probability_pct: trueProb * 100, odds: selectionOdds, ev_pct: ev * 100, confidence_pct: scored.dataCompletenessScore, reason: scored.gateFailReason || 'No validated wager survived the deterministic betting gates.', validation: 'UNVERIFIED' };
    const parsed = parseSelectionPayload(answer, fallback);
    if (parsed.primary.status === 'BET' && (!parsed.primary.odds || parsed.primary.odds <= 1)) {
      parsed.primary = noBetFallback(parsed.primary.confidence_pct, 'The model returned BET but did not provide a verified positive betting price.');
    }
    if (parsed.primary.status === 'BET' && !isConcreteSelection(parsed.primary.market, parsed.primary.selection)) {
      parsed.primary = noBetFallback(parsed.primary.confidence_pct, 'The model returned BET without a concrete deterministic selection.');
    }
    return {
      finalAnswer: answer,
      steps,
      success: true,
      monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount },
      trueProb,
      impliedProb,
      expectedValue: ev,
      starRating: scored.starRating,
      dataCompletenessScore: scored.dataCompletenessScore,
      isValueBet: scored.isValueBet,
      recommendedStake: scored.recommendedStake,
      recommendedOdds: selectionOdds || 0,
      confidence: scored.dataCompletenessScore,
      goalStatement: JSON.stringify({ fixture, primaryBet: parsed.primary, alternativePicks: parsed.alternatives }),
      categoryProbabilities: { market: features.categoryProbabilities.market, form: features.categoryProbabilities.form, injury: features.categoryProbabilities.injury, sentiment: features.categoryProbabilities.sentiment, tactical: features.categoryProbabilities.tactical },
      primaryBet: parsed.primary,
      alternativePicks: parsed.alternatives,
    };
  } catch (error) {
    return {
      finalAnswer: `Unable to complete synthesis for ${fixture}: ${error instanceof Error ? error.message : String(error)}`,
      steps,
      success: false,
      error: error instanceof Error ? error.message : String(error),
      monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount },
      trueProb,
      impliedProb,
      expectedValue: ev,
      starRating: scored.starRating,
      dataCompletenessScore: scored.dataCompletenessScore,
      isValueBet: false,
      recommendedStake: '0',
      recommendedOdds: selectionOdds || 0,
      confidence: scored.dataCompletenessScore,
      goalStatement: JSON.stringify({ fixture, primaryBet: noBetFallback(scored.dataCompletenessScore, 'Synthesis failed.') }),
      categoryProbabilities: { market: features.categoryProbabilities.market, form: features.categoryProbabilities.form, injury: features.categoryProbabilities.injury, sentiment: features.categoryProbabilities.sentiment, tactical: features.categoryProbabilities.tactical },
      primaryBet: noBetFallback(scored.dataCompletenessScore, 'Synthesis failed.'),
      alternativePicks: [],
    };
  }
}
