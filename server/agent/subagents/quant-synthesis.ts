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

function parseSelectionPayload(answer: string, fallback: SelectedBet): { primary: SelectedBet; alternatives: SelectedBet[]; primaryBet: SelectedBet; alternativePicks: SelectedBet[] } {
  let primary = fallback;
  let alternatives: SelectedBet[] = [];
  try {
    const pm = answer.match(/PRIMARY_BET\s*:\s*([\s\S]*?)(?=\n\s*ALTERNATIVE_PICKS\s*:|$)/i);
    if (pm) {
      for (const candidate of balancedJsonCandidates(pm[1])) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && typeof parsed.market === 'string' && typeof parsed.selection === 'string') {
            primary = {
              status: String(parsed.status || 'NO_BET'), market: parsed.market, selection: parsed.selection,
              probability_pct: Number.isFinite(Number(parsed.probability_pct)) ? Number(parsed.probability_pct) : null,
              odds: Number.isFinite(Number(parsed.odds)) ? Number(parsed.odds) : null,
              ev_pct: Number.isFinite(Number(parsed.ev_pct)) ? Number(parsed.ev_pct) : null,
              confidence_pct: Number(parsed.confidence_pct) || fallback.confidence_pct,
              reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
              validation: typeof parsed.validation === 'string' ? parsed.validation : 'UNVERIFIED',
            };
            break;
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
          alternatives = parsed.filter((p: any) => p && typeof p.market === 'string' && typeof p.selection === 'string').slice(0, 3).map((p: any) => ({
            status: String(p.status || 'UNVALIDATED'), market: p.market, selection: p.selection,
            probability_pct: Number.isFinite(Number(p.probability_pct)) ? Number(p.probability_pct) : null,
            odds: Number.isFinite(Number(p.odds)) ? Number(p.odds) : null,
            ev_pct: Number.isFinite(Number(p.ev_pct)) ? Number(p.ev_pct) : null,
            confidence_pct: fallback.confidence_pct,
            validation: typeof p.validation === 'string' ? p.validation : 'UNVERIFIED',
          }));
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
    const response = await mistralPool.call(c => c.chat.complete({ model: 'mistral-large-latest', messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Select the single best plausible betting pick for ${fixture}, then write the full analysis.` }] as any, temperature: 0.02, maxTokens: 4500 }));
    const content = response.choices?.[0]?.message?.content; if (typeof content !== 'string' || !content.trim()) throw new Error('Empty synthesis response');
    const finalAnswer = content.includes('FINAL_ANSWER:') ? content.slice(content.indexOf('FINAL_ANSWER:') + 13).trim() : content.trim();
    const fallbackPrimary: SelectedBet = { status: scored.isValueBet ? 'BET' : 'NO_BET', market, selection: 'MODEL TARGET', probability_pct: Number((trueProb * 100).toFixed(2)), odds: selectionOdds && selectionOdds > 1 ? selectionOdds : null, ev_pct: Number((ev * 100).toFixed(4)), confidence_pct: Math.round(scored.dataCompletenessScore), reason: scored.gateFailReason || 'Deterministic model target retained.', validation: calibration.includes('VALIDATED') ? 'VALIDATED' : 'UNVERIFIED' };
    const { primary, alternatives } = parseSelectionPayload(finalAnswer, fallbackPrimary);
    const decisionPayload = JSON.stringify({ primaryBet: primary, alternativePicks: alternatives, fixture });
    await saveCheckpoint({ sessionId, agentName: 'QuantSynthesis', messages: [], iteration: 1, steps: [...steps], rawOutput: finalAnswer, accumulatedData: { trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, primaryBet: primary, alternativePicks: alternatives, monteCarloSimulations: mc.simCount }, savedAt: Date.now(), version: 4 });
    return { finalAnswer, steps, success: true, monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount }, trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, confidence: Math.round(scored.dataCompletenessScore), goalStatement: decisionPayload, categoryProbabilities: scored.categoryProbabilities, primaryBet: primary, alternativePicks: alternatives };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', content: `⚠️ Synthesis model failed; deterministic prediction retained: ${message}` });
    const fallbackPrimary: SelectedBet = { status: 'NO_BET', market, selection: 'NO_BET', probability_pct: Number((trueProb * 100).toFixed(2)), odds: selectionOdds && selectionOdds > 1 ? selectionOdds : null, ev_pct: Number((ev * 100).toFixed(4)), confidence_pct: Math.round(scored.dataCompletenessScore), reason: `Synthesis model failed: ${message}`, validation: 'UNVERIFIED' };
    const decisionPayload = JSON.stringify({ primaryBet: fallbackPrimary, alternativePicks: [], fixture });
    return { finalAnswer: `Prediction for ${fixture}\n\nModel probability: ${(trueProb * 100).toFixed(1)}%\nConfidence/data completeness: ${Math.round(scored.dataCompletenessScore)}%\nCalibration: ${calibration}\nOdds: ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}\nExpected value: ${(ev * 100).toFixed(2)}%\nValidated value bet: ${scored.isValueBet ? 'YES' : 'NO'}\n\nMonte Carlo simulations: ${mc.simCount.toLocaleString()}\n\nPRIMARY_BET:\n${JSON.stringify(fallbackPrimary)}\n\n${scored.gateFailReason || 'Prediction generated from available evidence.'}`, steps, success: true, monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount }, trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, confidence: Math.round(scored.dataCompletenessScore), goalStatement: decisionPayload, categoryProbabilities: scored.categoryProbabilities, primaryBet: fallbackPrimary, alternativePicks: [], error: message };
  }
}
