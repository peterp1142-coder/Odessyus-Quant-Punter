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

function balancedJsonCandidates(raw: string): string[] {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const out: string[] = [];
  for (const open of ['{', '[']) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (start < 0) {
        if (c === open) { start = i; depth = 1; }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) depth++;
      else if ((open === '{' && c === '}') || (open === '[' && c === ']')) depth--;
      if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

const PLACEHOLDER_SELECTIONS = new Set([
  '', 'n/a', 'na', 'none', 'unknown', 'model lead', 'model target', 'no bet', 'no_bet', 'skip', 'unavailable', 'not available'
]);

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_SELECTIONS.has(value.trim().toLowerCase()) || /^(?:model\s+(?:lead|target)|n\/?a|unknown|no\s*bet)$/i.test(value.trim());
}

function isConcreteSelection(market: string, selection: string): boolean {
  const m = market.trim().toLowerCase();
  const s = selection.trim();
  if (!m || isPlaceholder(s)) return false;
  if (/under\s*\d+(?:\.\d+)?/.test(m)) return /^under\s*\d+(?:\.\d+)?(?:\s*goals?)?$/i.test(s);
  if (/over\s*\d+(?:\.\d+)?/.test(m)) return /^over\s*\d+(?:\.\d+)?(?:\s*goals?)?$/i.test(s);
  if (m.includes('btts') || m.includes('both teams')) return /^(yes|no)$/i.test(s);
  if (m.includes('asian') || m.includes('handicap')) return /^(?:home|away)\s*\([+-]?\d+(?:\.\d+)?\)|(?:home|away)\s*[+-]\d+(?:\.\d+)?$/i.test(s);
  if (m.includes('double chance')) return /^(1x|x2|12)$/i.test(s);
  if (m.includes('dnb') || m.includes('draw no bet')) return /^(home|away|.+\s+dnb)$/i.test(s);
  if (m.includes('match result') || m.includes('1x2') || m === 'result') return /^(home|away|draw|home win|away win|1|2|x)$/i.test(s) || s.length >= 3;
  return s.length >= 2;
}

function noBetFallback(confidence: number, reason: string, probability: number | null = null, odds: number | null = null): SelectedBet {
  return { status: 'NO_BET', market: 'N/A', selection: 'N/A', probability_pct: probability, odds, ev_pct: null, confidence_pct: confidence, reason, validation: 'UNVERIFIED' };
}

function parseSelectionPayload(answer: string, fallback: SelectedBet) {
  let primary = fallback;
  let alternatives: SelectedBet[] = [];
  const pm = answer.match(/PRIMARY_BET\s*:\s*([\s\S]*?)(?=\n\s*ALTERNATIVE_PICKS\s*:|$)/i);
  if (pm) {
    for (const candidate of balancedJsonCandidates(pm[1])) {
      try {
        const p = JSON.parse(candidate);
        if (!p || typeof p !== 'object' || typeof p.market !== 'string' || typeof p.selection !== 'string') continue;
        primary = {
          status: String(p.status || 'NO_BET'),
          market: p.market,
          selection: p.selection,
          probability_pct: Number.isFinite(Number(p.probability_pct)) ? Number(p.probability_pct) : null,
          odds: Number.isFinite(Number(p.odds)) ? Number(p.odds) : null,
          ev_pct: Number.isFinite(Number(p.ev_pct)) ? Number(p.ev_pct) : null,
          confidence_pct: Number.isFinite(Number(p.confidence_pct)) ? Number(p.confidence_pct) : fallback.confidence_pct,
          reason: typeof p.reason === 'string' ? p.reason : undefined,
          validation: typeof p.validation === 'string' ? p.validation : 'UNVERIFIED',
        };
        break;
      } catch { /* continue */ }
    }
  }
  const am = answer.match(/ALTERNATIVE_PICKS\s*:\s*([\s\S]*?)(?=\n\s*(?:FINAL_ANSWER|WRITING RULES|AVAILABLE EVIDENCE|$))/i);
  if (am) {
    for (const candidate of balancedJsonCandidates(am[1])) {
      try {
        const p = JSON.parse(candidate);
        if (!Array.isArray(p)) continue;
        alternatives = p.filter((x: any) => x && typeof x.market === 'string' && typeof x.selection === 'string' && !isPlaceholder(x.selection))
          .slice(0, 3)
          .map((x: any): SelectedBet => ({
            status: String(x.status || 'CONSIDER'),
            market: x.market,
            selection: x.selection,
            probability_pct: Number.isFinite(Number(x.probability_pct)) ? Number(x.probability_pct) : null,
            odds: Number.isFinite(Number(x.odds)) ? Number(x.odds) : null,
            ev_pct: Number.isFinite(Number(x.ev_pct)) ? Number(x.ev_pct) : null,
            confidence_pct: fallback.confidence_pct,
            validation: typeof x.validation === 'string' ? x.validation : 'UNVERIFIED',
          }));
        break;
      } catch { /* continue */ }
    }
  }
  if (primary.status === 'BET' && (!primary.odds || primary.odds <= 1 || !isConcreteSelection(primary.market, primary.selection))) {
    primary = noBetFallback(primary.confidence_pct, !isConcreteSelection(primary.market, primary.selection)
      ? 'Model returned BET without a concrete deterministic selection.'
      : 'Model returned BET without a verified positive betting price.', primary.probability_pct, primary.odds);
  }
  return { primary, alternatives };
}

function buildEvidenceSummary(args: { oddsResult: SubAgentResult; formResult: SubAgentResult; injuryResult: SubAgentResult; sentimentResult: SubAgentResult; lineupResult?: SubAgentResult; advancedText: string }): string {
  return [
    '=== ODDS ===', evidenceText(args.oddsResult).slice(0, 4500),
    '=== FORM ===', evidenceText(args.formResult).slice(0, 4500),
    '=== INJURY ===', evidenceText(args.injuryResult).slice(0, 3500),
    '=== SENTIMENT ===', evidenceText(args.sentimentResult).slice(0, 3500),
    '=== LINEUP ===', evidenceText(args.lineupResult).slice(0, 3500),
    '=== ADVANCED ===', args.advancedText.slice(0, 4500),
  ].join('\n');
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
  if (!features.evidenceReady) emit({ type: 'thought', content: `⚠️ Partial evidence for ${fixture}; confidence is reduced.` });

  const injuryAdjustHome = Math.min(0.5, (features.injury.injuryIndexHome / 10) * 0.4 + ((features.injury.absentPlayerRatingHome ?? 0) / 10) * 0.1);
  const injuryAdjustAway = Math.min(0.5, (features.injury.injuryIndexAway / 10) * 0.4 + ((features.injury.absentPlayerRatingAway ?? 0) / 10) * 0.1);
  const mc = runMonteCarlo({ xgHome: features.form.xgHome, xgAway: features.form.xgAway, homeAdvantage: 0.15, dixonColesRho: -0.1, injuryAdjustHome, injuryAdjustAway });
  const selectionOdds = features.market.selectionOdds;
  const impliedProb = features.market.selectionImpliedProb ?? (selectionOdds && selectionOdds > 1 ? 1 / selectionOdds : 0);
  const scored = score({ market, mcResult: mc, marketSignals: features.market, formSignals: features.form, injurySignals: features.injury, sentimentSignals: features.sentiment, advancedSignals: features.advanced, targetOdds: selectionOdds });
  const trueProb = scored.finalProbability;
  const ev = scored.expectedValue;
  const kelly = calcKelly(trueProb, selectionOdds ?? 0);
  const calibration = statusLabel(market);
  emit({ type: 'thought', content: `📐 ${fixture}: model ${(trueProb * 100).toFixed(1)}% | data ${scored.dataCompletenessScore}% | calibration ${calibration} | odds ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'} | Monte Carlo ${mc.simCount.toLocaleString()} simulations` });

  const evidenceSummary = buildEvidenceSummary({ oddsResult, formResult, injuryResult, sentimentResult, lineupResult, advancedText });
  const prompt = `${buildSystemPrompt()}

CURRENT EVIDENCE PREDICTION + BET SELECTION MODE
Select the single best real betting opportunity for the supplied fixture. Do not fabricate a market, price, probability, team, lineup, or calibration value.

SELECTION RULES
1. A primary BET must contain a concrete market and concrete selection.
2. A primary BET must include a verified price greater than 1.00. Without that, return NO_BET.
3. Do not use placeholders such as MODEL LEAD, MODEL TARGET, N/A, NONE, UNKNOWN, or NO BET as selections.
4. Prefer positive risk-adjusted EV, reliable evidence, liquidity, and lower model risk.
5. If no market survives the gates, return NO_BET and provide the strongest watchlist candidate as an alternative.

FIXTURE: ${fixture}
SPORT: ${sport}
USER TARGET MARKET: ${market}
MODEL PROBABILITY: ${(trueProb * 100).toFixed(1)}%
IMPLIED PROBABILITY: ${impliedProb > 0 ? `${(impliedProb * 100).toFixed(1)}%` : 'UNVERIFIED'}
TARGET ODDS: ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}
EXPECTED VALUE: ${(ev * 100).toFixed(2)}%
DATA COMPLETENESS: ${scored.dataCompletenessScore}%
CONFIDENCE: ${Math.round(scored.dataCompletenessScore)}%
STARS: ${scored.starRating}/5
CALIBRATION: ${calibration}
GATE: ${scored.gateFailReason || 'PASS'}

MONTE CARLO:
Home ${(mc.homeWin * 100).toFixed(1)}%
Draw ${(mc.draw * 100).toFixed(1)}%
Away ${(mc.awayWin * 100).toFixed(1)}%
BTTS ${(mc.btts * 100).toFixed(1)}%
Over 2.5 ${(mc.over25 * 100).toFixed(1)}%
Under 2.5 ${(mc.under25 * 100).toFixed(1)}%
Over 3.5 ${(mc.over35 * 100).toFixed(1)}%
Under 3.5 ${(mc.under35 * 100).toFixed(1)}%
Asian Home +0.5 ${(mc.ahHome05 * 100).toFixed(1)}%
Asian Away +0.5 ${(mc.ahAway05 * 100).toFixed(1)}%

AVAILABLE RESEARCH:
${evidenceSummary}

OUTPUT CONTRACT
PRIMARY_BET:
{"status":"BET|NO_BET","market":"...","selection":"...","probability_pct":number|null,"odds":number|null,"ev_pct":number|null,"confidence_pct":number,"reason":"...","validation":"VALIDATED|UNVALIDATED|UNVERIFIED"}
ALTERNATIVE_PICKS:
[{"market":"...","selection":"...","probability_pct":number|null,"odds":number|null,"ev_pct":number|null,"status":"CONSIDER|SKIP|UNVALIDATED"}]

Write the PRIMARY_BET block first, followed by alternatives and the analysis.`;

  try {
    const response = await mistralPool.call(c => c.chat.complete({ model: 'mistral-large-latest', messages: [{ role: 'system', content: prompt }, { role: 'user', content: `Select the best concrete betting decision for ${fixture}.` }] as any, temperature: 0.02, maxTokens: 4500 }));
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty synthesis response');
    const finalAnswer = content.includes('FINAL_ANSWER:') ? content.slice(content.indexOf('FINAL_ANSWER:') + 13).trim() : content.trim();
    const fallbackPrimary: SelectedBet = scored.isValueBet
      ? { status: 'BET', market, selection: market, probability_pct: Number((trueProb * 100).toFixed(2)), odds: selectionOdds && selectionOdds > 1 ? selectionOdds : null, ev_pct: Number((ev * 100).toFixed(4)), confidence_pct: Math.round(scored.dataCompletenessScore), reason: scored.gateFailReason || 'Selected by quantitative gate.', validation: calibration.includes('VALIDATED') ? 'VALIDATED' : 'UNVERIFIED' }
      : noBetFallback(Math.round(scored.dataCompletenessScore), scored.gateFailReason || 'No validated wager survived the deterministic betting gates.', Number((trueProb * 100).toFixed(2)), selectionOdds && selectionOdds > 1 ? selectionOdds : null);
    const { primary, alternatives } = parseSelectionPayload(finalAnswer, fallbackPrimary);
    const decisionPayload = JSON.stringify({ primaryBet: primary, alternativePicks: alternatives, fixture });
    await saveCheckpoint({ sessionId, agentName: 'QuantSynthesis', messages: [], iteration: 1, steps: [...steps], rawOutput: finalAnswer, accumulatedData: { trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, primaryBet: primary, alternativePicks: alternatives, monteCarloSimulations: mc.simCount }, savedAt: Date.now(), version: 5 });
    return { finalAnswer, steps, success: true, monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount }, trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, confidence: Math.round(scored.dataCompletenessScore), goalStatement: decisionPayload, categoryProbabilities: scored.categoryProbabilities, primaryBet: primary, alternativePicks: alternatives };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', content: `⚠️ Synthesis model failed; deterministic result retained: ${message}` });
    const fallbackPrimary = noBetFallback(Math.round(scored.dataCompletenessScore), `Synthesis model failed: ${message}`, Number((trueProb * 100).toFixed(2)), selectionOdds && selectionOdds > 1 ? selectionOdds : null);
    const decisionPayload = JSON.stringify({ primaryBet: fallbackPrimary, alternativePicks: [], fixture });
    return { finalAnswer: `Prediction for ${fixture}\n\nPRIMARY_BET:\n${JSON.stringify(fallbackPrimary)}\n\n${scored.gateFailReason || 'Prediction generated from available evidence.'}`, steps, success: true, monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev, simCount: mc.simCount }, trueProb, impliedProb, expectedValue: ev, starRating: scored.starRating, dataCompletenessScore: scored.dataCompletenessScore, isValueBet: scored.isValueBet, recommendedStake: scored.recommendedStake, recommendedOdds: selectionOdds ?? 0, confidence: Math.round(scored.dataCompletenessScore), goalStatement: decisionPayload, categoryProbabilities: scored.categoryProbabilities, primaryBet: fallbackPrimary, alternativePicks: [], error: message };
  }
}
