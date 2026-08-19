/**
 * Deterministic Weighted Scorer v2 — final_probability = f(features)
 *
 * Changes v2:
 *  - Rebalanced weights: market 35%, form 30%, injury 25%, sentiment 10%
 *    (market signal is the most efficient — sharpest books price this first)
 *  - Kelly Criterion output (full + fractional)
 *  - Accuracy gate: flags picks below minimum EV threshold
 *  - Asian handicap and DNB market scoring
 *  - Bookmaker overround removal for true implied probability
 *  - Calibration factor based on data completeness
 */

import type { MCResult } from './monte-carlo.js';

// ─── Category weights (sum = 1.0) ─────────────────────────────────────────────

const WEIGHTS = {
  market:    0.35,   // sharp money is the most efficient signal available
  form:      0.30,   // xG, H2H, recent results — high predictive validity
  injury:    0.25,   // squad availability directly affects expected goals
  sentiment: 0.10,   // motivation, weather, refs — real but noisier signal
} as const;

// ─── Minimum thresholds for a recommended pick ────────────────────────────────

export const ACCURACY_GATE = {
  MIN_EV_PCT:                  3.0,   // minimum EV% to recommend a bet
  MIN_DATA_COMPLETENESS:      40.0,   // minimum data completeness %
  MIN_CONFIDENCE_FOR_MAX_STAKE: 70,   // confidence % required for 4-5 star rating
  MIN_STAR_FOR_STANDARD_STAKE:   3,   // stars required for standard stake
} as const;

// ─── Input types ──────────────────────────────────────────────────────────────

export interface MarketSignals {
  impliedProbHome: number;
  reverseLM: boolean;
  lineMovement: number;
  oddsDataQuality: number;
  openingOddsHome?: number;    // opening decimal odds
  currentOddsHome?: number;    // current decimal odds
  pinnacleOdds?: number;       // Pinnacle (sharpest market) as reference
  overround?: number;          // bookmaker margin (1 - sum of true probs)
}

export interface FormSignals {
  xgHome: number;
  xgAway: number;
  xgConcededHome: number;    // avg xG conceded per game (defensive quality)
  xgConcededAway: number;
  formPtsHome: number;
  formPtsAway: number;
  h2hWinRateHome: number;
  formDataQuality: number;
  homeWinPctVenue: number;   // home team win % at this stadium
  awayWinPctVenue: number;   // away team win % in away games
  streakHome: number;        // -3 to +3 (negative = losing streak)
  streakAway: number;
  restDaysHome: number;      // days since last match
  restDaysAway: number;
}

export interface InjurySignals {
  injuryIndexHome: number;
  injuryIndexAway: number;
  gtdRiskHome: number;
  gtdRiskAway: number;
  injuryDataQuality: number;
  absentPlayerRatingHome?: number;  // 0-10 quality of absent players
  absentPlayerRatingAway?: number;
}

export interface SentimentSignals {
  motivationHome: number;
  motivationAway: number;
  weatherImpact: number;
  refBias: number;
  sentimentDataQuality: number;
  crowdFactor?: number;    // 0-1 crowd advantage factor (attendance, atmosphere)
}

export interface ScorerInput {
  market: string;
  mcResult: MCResult;
  marketSignals: Partial<MarketSignals>;
  formSignals: Partial<FormSignals>;
  injurySignals: Partial<InjurySignals>;
  sentimentSignals: Partial<SentimentSignals>;
  targetOdds?: number;    // the odds we want to bet at (for EV and Kelly)
}

export interface KellyCriterion {
  fullKelly: number;     // % of bankroll (full Kelly)
  halfKelly: number;     // % of bankroll (half Kelly — safer)
  quarterKelly: number;  // % of bankroll (quarter Kelly — conservative)
  recommendation: string;
}

export interface ScorerOutput {
  finalProbability: number;
  categoryProbabilities: {
    market: number;
    form: number;
    injury: number;
    sentiment: number;
  };
  dataCompletenessScore: number;
  completenessBreakdown: Record<string, number>;
  appliedWeights: typeof WEIGHTS;
  calibrationNote: string;
  expectedValue: number;           // as decimal (e.g. 0.08 = 8%)
  expectedValuePct: number;        // as percentage
  kelly: KellyCriterion;
  isValueBet: boolean;             // passes accuracy gate
  gateFailReason?: string;         // why it failed the gate, if it did
  starRating: number;              // 1-5
  recommendedStake: string;        // "SKIP" | "MONITOR" | "SMALL" | "STANDARD" | "CONFIDENT" | "MAX"
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const D = {
  impliedProbHome: 0.45, reverseLM: false, lineMovement: 0, oddsDataQuality: 0,
  openingOddsHome: 0, currentOddsHome: 0, pinnacleOdds: 0, overround: 0.05,
  xgHome: 1.3, xgAway: 1.1, xgConcededHome: 1.1, xgConcededAway: 1.3,
  formPtsHome: 7, formPtsAway: 7, h2hWinRateHome: 0.40, formDataQuality: 0,
  homeWinPctVenue: 0.45, awayWinPctVenue: 0.30,
  streakHome: 0, streakAway: 0, restDaysHome: 4, restDaysAway: 4,
  injuryIndexHome: 0, injuryIndexAway: 0, gtdRiskHome: 0, gtdRiskAway: 0, injuryDataQuality: 0,
  absentPlayerRatingHome: 0, absentPlayerRatingAway: 0,
  motivationHome: 0.5, motivationAway: 0.5, weatherImpact: 0, refBias: 0, sentimentDataQuality: 0,
  crowdFactor: 0.1,
};

function fill<T>(partial: Partial<T>, keys: (keyof typeof D)[]): any {
  const out: any = {};
  for (const k of keys) out[k] = (partial as any)[k] ?? D[k];
  return out;
}

// ─── Category scorers ─────────────────────────────────────────────────────────

function scoreMarket(s: Required<MarketSignals>, mcProb: number): number {
  // Remove overround to get true implied probability from bookmaker
  const adjustedImplied = s.impliedProbHome / (1 + Math.max(0, s.overround - 0.02));

  // Blend: 50% adjusted bookmaker implied + 50% Monte Carlo
  let p = mcProb * 0.50 + adjustedImplied * 0.50;

  // Pinnacle reference (sharpest market) — weight higher if available
  if (s.pinnacleOdds > 1) {
    const pinnacleImplied = 1 / s.pinnacleOdds;
    p = p * 0.60 + pinnacleImplied * 0.40;
  }

  // Reverse line movement = sharp money vs. public → boost probability
  if (s.reverseLM) p += 0.04;

  // Line movement nudge (max ±6%)
  p += s.lineMovement * 0.06;

  // Opening → closing compression: if odds shortened significantly, add confidence
  if (s.openingOddsHome > 1 && s.currentOddsHome > 1) {
    const openImplied = 1 / s.openingOddsHome;
    const curImplied  = 1 / s.currentOddsHome;
    const drift = curImplied - openImplied; // positive = shortened toward home
    p += drift * 0.15;
  }

  return Math.max(0.05, Math.min(0.95, p));
}

function scoreForm(s: Required<FormSignals>, mcProb: number, market: string): number {
  let p = mcProb;

  // Form points differential (each point gap shifts by ~0.6%)
  const formDiff = (s.formPtsHome - s.formPtsAway) / 15;
  p += formDiff * 0.10;

  // Venue-specific win rate
  const venueAdj = (s.homeWinPctVenue - 0.45) * 0.12;
  p += venueAdj;

  // H2H adjustment (max ±6%)
  const h2hAdj = (s.h2hWinRateHome - 0.40) * 0.15;
  p += h2hAdj;

  // Streak momentum (each level of streak = 1.5% adjustment)
  const streakAdj = (s.streakHome - s.streakAway) * 0.015;
  p += streakAdj;

  // Rest advantage (3+ extra days = 2% boost)
  const restDiff = s.restDaysHome - s.restDaysAway;
  if (restDiff >= 3) p += 0.02;
  else if (restDiff <= -3) p -= 0.02;

  // BTTS/over markets: xG sum matters more
  const m = market.toLowerCase();
  if (m.includes('btts') || m.includes('both teams')) {
    const bttsAdj = (s.xgHome + s.xgAway - 2.4) * 0.10;
    p = 0.5 + bttsAdj + formDiff * 0.04;
  } else if (m.includes('over') || m.includes('under')) {
    const goalSum = s.xgHome + s.xgAway;
    if (m.includes('over')) p = 0.50 + (goalSum - 2.5) * 0.12;
    else p = 0.50 - (goalSum - 2.5) * 0.12;
  }

  return Math.max(0.05, Math.min(0.95, p));
}

function scoreInjury(s: Required<InjurySignals>, baseMCProb: number): number {
  // Each unit of home injury reduces home win prob by ~2.2%
  const injAdj = (s.injuryIndexAway - s.injuryIndexHome) * 0.022;
  // GTD risk
  const gtdAdj = (s.gtdRiskAway - s.gtdRiskHome) * 0.03;
  // Absent player quality modifier
  const absentAdj = s.absentPlayerRatingHome && s.absentPlayerRatingAway
    ? (s.absentPlayerRatingAway - s.absentPlayerRatingHome) * 0.01
    : 0;

  return Math.max(0.05, Math.min(0.95, baseMCProb + injAdj + gtdAdj + absentAdj));
}

function scoreSentiment(s: Required<SentimentSignals>, baseMCProb: number): number {
  const motivationAdj = (s.motivationHome - s.motivationAway) * 0.05;
  const weatherAdj   = s.weatherImpact * 0.025;
  const refAdj       = s.refBias * 0.04;
  const crowdAdj     = (s.crowdFactor ?? 0) * 0.02;

  return Math.max(0.05, Math.min(0.95, baseMCProb + motivationAdj + weatherAdj + refAdj + crowdAdj));
}

// ─── Overround removal ────────────────────────────────────────────────────────

export function removeOverround(decimalOdds: number, estimatedMargin = 0.05): number {
  if (decimalOdds <= 1) return 0.5;
  const implied = 1 / decimalOdds;
  return Math.min(0.95, implied / (1 + estimatedMargin));
}

// ─── Kelly Criterion ──────────────────────────────────────────────────────────

export function calcKelly(trueProbability: number, decimalOdds: number): KellyCriterion {
  if (decimalOdds <= 1 || trueProbability <= 0) {
    return { fullKelly: 0, halfKelly: 0, quarterKelly: 0, recommendation: 'NO BET — no edge' };
  }
  const b = decimalOdds - 1;          // net decimal profit per unit
  const q = 1 - trueProbability;
  const fullKelly = Math.max(0, (b * trueProbability - q) / b);

  return {
    fullKelly:     Math.round(fullKelly * 1000) / 10,   // as %
    halfKelly:     Math.round(fullKelly * 500)  / 10,
    quarterKelly:  Math.round(fullKelly * 250)  / 10,
    recommendation: fullKelly <= 0
      ? 'NO BET — negative edge'
      : fullKelly >= 0.20
      ? `MAX STAKE — ${(fullKelly * 100).toFixed(1)}% Kelly, cap at 5% bankroll`
      : `${(fullKelly * 50).toFixed(1)}% bankroll (half-Kelly)`,
  };
}

// ─── Data completeness ────────────────────────────────────────────────────────

function computeCompleteness(
  ms: Required<MarketSignals>,
  fs: Required<FormSignals>,
  is_: Required<InjurySignals>,
  ss: Required<SentimentSignals>,
): { score: number; breakdown: Record<string, number> } {
  const breakdown = {
    market:    ms.oddsDataQuality    * 100,
    form:      fs.formDataQuality    * 100,
    injury:    is_.injuryDataQuality * 100,
    sentiment: ss.sentimentDataQuality * 100,
  };
  const score =
    breakdown.market    * WEIGHTS.market +
    breakdown.form      * WEIGHTS.form +
    breakdown.injury    * WEIGHTS.injury +
    breakdown.sentiment * WEIGHTS.sentiment;

  return { score: Math.round(score * 10) / 10, breakdown };
}

// ─── Star rating & stake recommendation ──────────────────────────────────────

function computeStarRating(evPct: number, completeness: number): { stars: number; stake: string } {
  // Penalise low data completeness
  const penalisedEV = evPct * Math.min(1, completeness / 70);

  if (penalisedEV >= 15) return { stars: 5, stake: 'MAX' };
  if (penalisedEV >= 10) return { stars: 4, stake: 'CONFIDENT' };
  if (penalisedEV >= 5)  return { stars: 3, stake: 'STANDARD' };
  if (penalisedEV >= 2)  return { stars: 2, stake: 'SMALL' };
  if (penalisedEV >= 0)  return { stars: 1, stake: 'MONITOR' };
  return { stars: 1, stake: 'SKIP' };
}

// ─── Main scorer ──────────────────────────────────────────────────────────────

export function score(input: ScorerInput): ScorerOutput {
  const msKeys: (keyof typeof D)[] = ['impliedProbHome','reverseLM','lineMovement','oddsDataQuality','openingOddsHome','currentOddsHome','pinnacleOdds','overround'];
  const fsKeys: (keyof typeof D)[] = ['xgHome','xgAway','xgConcededHome','xgConcededAway','formPtsHome','formPtsAway','h2hWinRateHome','formDataQuality','homeWinPctVenue','awayWinPctVenue','streakHome','streakAway','restDaysHome','restDaysAway'];
  const isKeys: (keyof typeof D)[] = ['injuryIndexHome','injuryIndexAway','gtdRiskHome','gtdRiskAway','injuryDataQuality','absentPlayerRatingHome','absentPlayerRatingAway'];
  const ssKeys: (keyof typeof D)[] = ['motivationHome','motivationAway','weatherImpact','refBias','sentimentDataQuality','crowdFactor'];

  const ms  = fill(input.marketSignals,   msKeys) as Required<MarketSignals>;
  const fs  = fill(input.formSignals,     fsKeys) as Required<FormSignals>;
  const is_ = fill(input.injurySignals,   isKeys) as Required<InjurySignals>;
  const ss  = fill(input.sentimentSignals, ssKeys) as Required<SentimentSignals>;

  // Derive base probability from MC for the target market
  const market = input.market.toLowerCase();
  let mcProb: number;
  if (market.includes('draw'))       mcProb = input.mcResult.draw;
  else if (market.includes('away'))  mcProb = input.mcResult.awayWin;
  else if (market.includes('btts') || market.includes('both teams')) mcProb = input.mcResult.btts;
  else if (market.includes('over 3.5') || market.includes('over3.5')) mcProb = input.mcResult.over35;
  else if (market.includes('under 3.5') || market.includes('under3.5')) mcProb = input.mcResult.under35;
  else if (market.includes('over 2.5') || market.includes('over2.5') || market.includes('over')) mcProb = input.mcResult.over25;
  else if (market.includes('under 2.5') || market.includes('under2.5') || market.includes('under')) mcProb = input.mcResult.under25;
  else if (market.includes('dnb') && market.includes('home')) mcProb = input.mcResult.dnbHome;
  else if (market.includes('dnb') && market.includes('away')) mcProb = input.mcResult.dnbAway;
  else mcProb = input.mcResult.homeWin;

  const catScores = {
    market:    scoreMarket(ms, mcProb),
    form:      scoreForm(fs, mcProb, input.market),
    injury:    scoreInjury(is_, mcProb),
    sentiment: scoreSentiment(ss, mcProb),
  };

  const finalProbability = Math.max(0.05, Math.min(0.95,
    catScores.market    * WEIGHTS.market +
    catScores.form      * WEIGHTS.form +
    catScores.injury    * WEIGHTS.injury +
    catScores.sentiment * WEIGHTS.sentiment,
  ));

  const { score: dataCompletenessScore, breakdown: completenessBreakdown } =
    computeCompleteness(ms, fs, is_, ss);

  // EV calculation using target odds (or implied odds from probability)
  const targetOdds = input.targetOdds && input.targetOdds > 1
    ? input.targetOdds
    : ms.currentOddsHome > 1
    ? ms.currentOddsHome
    : ms.impliedProbHome > 0.05
    ? 1 / ms.impliedProbHome
    : 2.0;

  const expectedValue    = (finalProbability * targetOdds) - 1;
  const expectedValuePct = expectedValue * 100;

  // Kelly Criterion
  const kelly = calcKelly(finalProbability, targetOdds);

  // Star rating
  const { stars: starRating, stake: recommendedStake } =
    computeStarRating(expectedValuePct, dataCompletenessScore);

  // Accuracy gate
  let isValueBet = true;
  let gateFailReason: string | undefined;

  if (expectedValuePct < ACCURACY_GATE.MIN_EV_PCT) {
    isValueBet = false;
    gateFailReason = `EV ${expectedValuePct.toFixed(1)}% < minimum ${ACCURACY_GATE.MIN_EV_PCT}%`;
  } else if (dataCompletenessScore < ACCURACY_GATE.MIN_DATA_COMPLETENESS) {
    isValueBet = false;
    gateFailReason = `Data completeness ${dataCompletenessScore.toFixed(0)}% < minimum ${ACCURACY_GATE.MIN_DATA_COMPLETENESS}%`;
  }

  const calibrationNote = [
    `MC base: ${(mcProb * 100).toFixed(1)}% (${input.mcResult.simCount.toLocaleString()} sims)`,
    `Market: ${(catScores.market * 100).toFixed(1)}% (w=${WEIGHTS.market})`,
    `Form: ${(catScores.form * 100).toFixed(1)}% (w=${WEIGHTS.form})`,
    `Injury: ${(catScores.injury * 100).toFixed(1)}% (w=${WEIGHTS.injury})`,
    `Sentiment: ${(catScores.sentiment * 100).toFixed(1)}% (w=${WEIGHTS.sentiment})`,
    `True prob: ${(finalProbability * 100).toFixed(1)}%`,
    `EV: ${expectedValuePct >= 0 ? '+' : ''}${expectedValuePct.toFixed(2)}%`,
    `Data: ${dataCompletenessScore}%`,
    `Gate: ${isValueBet ? '✅ PASS' : `❌ FAIL — ${gateFailReason}`}`,
  ].join(' | ');

  return {
    finalProbability,
    categoryProbabilities: catScores,
    dataCompletenessScore,
    completenessBreakdown,
    appliedWeights: WEIGHTS,
    calibrationNote,
    expectedValue,
    expectedValuePct,
    kelly,
    isValueBet,
    gateFailReason,
    starRating,
    recommendedStake,
  };
}
