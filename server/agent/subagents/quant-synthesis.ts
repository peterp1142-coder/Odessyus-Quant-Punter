import type { ReActStep } from '../react-engine.js';
import type { SubAgentResult } from './base.js';
import { buildSystemPrompt } from '../prompts.js';
import { mistralPool } from '../mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../checkpoint.js';
import { runMonteCarlo } from '../monte-carlo.js';
import { score, calcKelly } from '../scorer.js';
import { extractFeatures } from '../feature-extractor.js';
import { getCalibrationStatus } from '../calibration.js';

export interface QuantResult {
  finalAnswer: string;
  steps: ReActStep[];
  success: boolean;
  error?: string;
  monteCarlo: { home: number; draw: number; away: number; stdDev: number };
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
}

const emptyMC = { home: 0, draw: 0, away: 0, stdDev: 0 };

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

export async function runQuantSynthesis(opts: {
  userQuery: string;
  fixture: string;
  sport: string;
  market: string;
  sessionId?: string;
  oddsResult: SubAgentResult;
  formResult: SubAgentResult;
  injuryResult: SubAgentResult;
  sentimentResult: SubAgentResult;
  lineupResult?: SubAgentResult;
  advancedText?: string;
  onStep: (step: ReActStep) => void;
  isMultiFixture?: boolean;
  discoveredFixtures?: string[];
}): Promise<QuantResult> {
  const {
    userQuery,
    fixture,
    sport,
    market = 'Match Result',
    sessionId = 'default',
    oddsResult,
    formResult,
    injuryResult,
    sentimentResult,
    lineupResult,
    advancedText = '',
    onStep,
  } = opts;

  const steps: ReActStep[] = [];
  const emit = (step: ReActStep) => {
    const stamped = { ...step, timestamp: new Date().toISOString() };
    steps.push(stamped);
    onStep(stamped);
  };

  const existing = await loadCheckpoint(sessionId, 'QuantSynthesis');
  if (existing) await clearCheckpoint(sessionId, 'QuantSynthesis');

  emit({ type: 'status', content: `⚡ QuantSynthesis: scoring ${fixture} from all available evidence…` });

  const lineupText = evidenceText(lineupResult);
  const features = await extractFeatures({
    formText: evidenceText(formResult),
    oddsText: evidenceText(oddsResult),
    injuryText: [evidenceText(injuryResult), lineupText].filter(Boolean).join('\n=== LINEUP ===\n'),
    sentimentText: evidenceText(sentimentResult),
    advancedText,
    fixture,
    market,
  });

  // IMPORTANT: evidenceReady is a quality flag, not a kill switch.
  // We always score using whatever numeric evidence was successfully extracted.
  // Missing prices/calibration reduce confidence and prevent value-bet promotion.
  if (!features.evidenceReady) {
    emit({
      type: 'thought',
      content: `⚠️ Partial evidence for ${fixture}; proceeding with available data. Missing fields reduce confidence and disable validated-edge promotion.`,
    });
  }

  const injuryAdjustHome = Math.min(
    0.5,
    (features.injury.injuryIndexHome / 10) * 0.4 + ((features.injury.absentPlayerRatingHome ?? 0) / 10) * 0.1,
  );
  const injuryAdjustAway = Math.min(
    0.5,
    (features.injury.injuryIndexAway / 10) * 0.4 + ((features.injury.absentPlayerRatingAway ?? 0) / 10) * 0.1,
  );

  const mc = runMonteCarlo({
    xgHome: features.form.xgHome,
    xgAway: features.form.xgAway,
    homeAdvantage: 0.15,
    dixonColesRho: -0.1,
    injuryAdjustHome,
    injuryAdjustAway,
  });

  const selectionOdds = features.market.selectionOdds;
  const impliedProb = features.market.selectionImpliedProb ?? (selectionOdds && selectionOdds > 1 ? 1 / selectionOdds : 0);
  const scored = score({
    market,
    mcResult: mc,
    marketSignals: features.market,
    formSignals: features.form,
    injurySignals: features.injury,
    sentimentSignals: features.sentiment,
    advancedSignals: features.advanced,
    targetOdds: selectionOdds,
  });

  const trueProb = scored.finalProbability;
  const ev = scored.expectedValue;
  const kelly = calcKelly(trueProb, selectionOdds ?? 0);
  const calibration = statusLabel(market);

  emit({
    type: 'thought',
    content: `📐 ${fixture}: model ${(trueProb * 100).toFixed(1)}% | data ${scored.dataCompletenessScore}% | calibration ${calibration} | odds ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}`,
  });

  const evidenceSummary = buildEvidenceSummary({
    oddsResult,
    formResult,
    injuryResult,
    sentimentResult,
    lineupResult,
    advancedText,
  });

  const prompt = `${buildSystemPrompt()}

CURRENT EVIDENCE PREDICTION MODE
The system MUST produce a prediction for the requested fixture whenever there is usable evidence. Missing calibration, missing exact odds, incomplete form, missing lineup data, or unavailable advanced fields are NOT fatal errors.
Use the deterministic values below exactly. Do not invent missing evidence.

FIXTURE: ${fixture}
SPORT: ${sport}
TARGET MARKET: ${market}
TRUE PROBABILITY: ${(trueProb * 100).toFixed(1)}%
IMPLIED PROBABILITY: ${impliedProb > 0 ? `${(impliedProb * 100).toFixed(1)}%` : 'UNVERIFIED'}
ODDS: ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}
EXPECTED VALUE: ${(ev * 100).toFixed(2)}%
DATA COMPLETENESS: ${scored.dataCompletenessScore}%
CONFIDENCE: ${Math.round(scored.dataCompletenessScore)}%
STARS: ${scored.starRating}/5
RECOMMENDED STAKE: ${scored.recommendedStake}
KELLY HALF: ${kelly.halfKelly}%
CALIBRATION: ${calibration}
CALIBRATION NOTE: ${scored.calibrationNote}
VALUE-BET STATUS: ${scored.isValueBet ? 'VALIDATED VALUE BET' : 'NOT A VALIDATED VALUE BET'}
GATE NOTE: ${scored.gateFailReason || 'No blocking gate'}

MONTE CARLO:
Home ${(mc.homeWin * 100).toFixed(1)}%
Draw ${(mc.draw * 100).toFixed(1)}%
Away ${(mc.awayWin * 100).toFixed(1)}%
BTTS ${(mc.btts * 100).toFixed(1)}%
Over 2.5 ${(mc.over25 * 100).toFixed(1)}%
Under 2.5 ${(mc.under25 * 100).toFixed(1)}%

AVAILABLE RESEARCH:
${evidenceSummary}

WRITING RULES
1. Always return a prediction when the fixture is real and some evidence exists.
2. Clearly distinguish model prediction from validated value-bet status.
3. Never invent an odds price, calibration sample, lineup, injury or statistic that is absent.
4. When evidence is sparse, explicitly say the confidence/data completeness is reduced.
5. Do not output 'NO QUALIFIED ANALYSIS' merely because calibration or exact-market odds are missing.
6. Use the deterministic probabilities above; do not replace them with guesses.

Write FINAL_ANSWER with the prediction, probability, confidence/data completeness, Monte Carlo summary, available evidence, missing evidence, calibration status, and whether the selection is a validated value bet.`;

  try {
    const response = await mistralPool.call(c => c.chat.complete({
      model: 'mistral-large-latest',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `Produce the prediction for ${fixture}.` },
      ] as any,
      temperature: 0.02,
      maxTokens: 4200,
    }));

    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Empty synthesis response');

    const finalAnswer = content.includes('FINAL_ANSWER:')
      ? content.slice(content.indexOf('FINAL_ANSWER:') + 13).trim()
      : content.trim();

    await saveCheckpoint({
      sessionId,
      agentName: 'QuantSynthesis',
      messages: [],
      iteration: 1,
      steps: [...steps],
      rawOutput: finalAnswer,
      accumulatedData: {
        trueProb,
        impliedProb,
        expectedValue: ev,
        starRating: scored.starRating,
        dataCompletenessScore: scored.dataCompletenessScore,
        isValueBet: scored.isValueBet,
        recommendedStake: scored.recommendedStake,
        recommendedOdds: selectionOdds ?? 0,
      },
      savedAt: Date.now(),
      version: 4,
    });

    return {
      finalAnswer,
      steps,
      success: true,
      monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev },
      trueProb,
      impliedProb,
      expectedValue: ev,
      starRating: scored.starRating,
      dataCompletenessScore: scored.dataCompletenessScore,
      isValueBet: scored.isValueBet,
      recommendedStake: scored.recommendedStake,
      recommendedOdds: selectionOdds ?? 0,
      confidence: Math.round(scored.dataCompletenessScore),
      goalStatement: `${fixture} — ${market} — ${(trueProb * 100).toFixed(1)}% model probability`,
      categoryProbabilities: scored.categoryProbabilities,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: 'error', content: `⚠️ Synthesis model failed; deterministic prediction retained: ${message}` });

    return {
      finalAnswer: `Prediction for ${fixture}\n\nModel probability: ${(trueProb * 100).toFixed(1)}%\nConfidence/data completeness: ${Math.round(scored.dataCompletenessScore)}%\nCalibration: ${calibration}\nOdds: ${selectionOdds && selectionOdds > 1 ? selectionOdds.toFixed(2) : 'UNVERIFIED'}\nExpected value: ${(ev * 100).toFixed(2)}%\nValidated value bet: ${scored.isValueBet ? 'YES' : 'NO'}\n\n${scored.gateFailReason || 'Prediction generated from available evidence.'}`,
      steps,
      success: true,
      monteCarlo: { home: mc.homeWin, draw: mc.draw, away: mc.awayWin, stdDev: mc.stdDev },
      trueProb,
      impliedProb,
      expectedValue: ev,
      starRating: scored.starRating,
      dataCompletenessScore: scored.dataCompletenessScore,
      isValueBet: scored.isValueBet,
      recommendedStake: scored.recommendedStake,
      recommendedOdds: selectionOdds ?? 0,
      confidence: Math.round(scored.dataCompletenessScore),
      goalStatement: `${fixture} — ${market} — ${calibration}`,
      categoryProbabilities: scored.categoryProbabilities,
      error: message,
    };
  }
}
