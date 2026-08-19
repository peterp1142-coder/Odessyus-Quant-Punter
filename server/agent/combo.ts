/**
 * Combo / Parlay Engine
 *
 * Builds same-game or cross-game parlays from individual prediction legs.
 * Applies a correlation discount for same-match legs (e.g. Over 2.5 + BTTS Yes
 * + Home Win are highly correlated — naive multiplication overstates the edge).
 *
 * Outputs combo-level EV and Kelly Criterion sizing.
 */

export interface ComboLeg {
  predictionId: string;
  fixture: string;
  market: string;
  selection: string;
  trueProb: number;
  impliedProb: number;
  odds: number;
  ev: number;
  starRating: number;
}

export interface ComboResult {
  comboId: string;
  legs: ComboLeg[];
  combinedOdds: number;
  naiveJointProb: number;
  correlationDiscount: number;
  adjustedJointProb: number;
  combinedImpliedProb: number;
  combinedEV: number;
  combinedEVPct: number;
  kellyFull: number;
  kellyHalf: number;
  isRecommended: boolean;
  gateFailReason?: string;
  sameMatch: boolean;
}

const MIN_COMBO_EV_PCT = 5.0;
const MIN_LEG_STARS = 2;
const MAX_LEGS = 5;
const CORRELATION_PAIRS: Array<{ a: RegExp; b: RegExp; discount: number }> = [
  { a: /over.*2\.5/i, b: /btts.*yes|both teams.*yes/i, discount: 0.15 },
  { a: /over.*2\.5/i, b: /home win|match result.*home/i, discount: 0.10 },
  { a: /over.*2\.5/i, b: /over.*3\.5/i, discount: 0.25 },
  { a: /btts.*yes|both teams.*yes/i, b: /home win/i, discount: 0.08 },
  { a: /over.*2\.5/i, b: /over.*1\.5/i, discount: 0.30 },
  { a: /home win/i, b: /dnb.*home/i, discount: 0.40 },
  { a: /away win/i, b: /dnb.*away/i, discount: 0.40 },
];

export function buildCombo(legs: ComboLeg[]): ComboResult {
  const comboId = `combo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  if (legs.length < 2) {
    return {
      comboId, legs, combinedOdds: 1, naiveJointProb: 1, correlationDiscount: 0,
      adjustedJointProb: 0, combinedImpliedProb: 1, combinedEV: -1, combinedEVPct: -100,
      kellyFull: 0, kellyHalf: 0, isRecommended: false,
      gateFailReason: 'Need at least 2 legs for a combo', sameMatch: false,
    };
  }

  if (legs.length > MAX_LEGS) {
    return {
      comboId, legs: legs.slice(0, MAX_LEGS), combinedOdds: 1, naiveJointProb: 1,
      correlationDiscount: 0, adjustedJointProb: 0, combinedImpliedProb: 1,
      combinedEV: -1, combinedEVPct: -100, kellyFull: 0, kellyHalf: 0,
      isRecommended: false, gateFailReason: `Max ${MAX_LEGS} legs`, sameMatch: false,
    };
  }

  const fixtures = new Set(legs.map(l => l.fixture));
  const sameMatch = fixtures.size === 1;

  let combinedOdds = 1;
  let naiveJointProb = 1;
  let combinedImpliedProb = 1;

  for (const leg of legs) {
    combinedOdds *= leg.odds;
    naiveJointProb *= leg.trueProb;
    combinedImpliedProb *= leg.impliedProb;
  }

  const correlationDiscount = sameMatch ? computeCorrelationDiscount(legs) : 0;
  const adjustedJointProb = naiveJointProb * (1 - correlationDiscount);

  const combinedEV = adjustedJointProb * combinedOdds - 1;
  const combinedEVPct = combinedEV * 100;

  const b = combinedOdds - 1;
  const q = 1 - adjustedJointProb;
  const kellyFull = b > 0 ? Math.max(0, (b * adjustedJointProb - q) / b) : 0;
  const kellyHalf = kellyFull / 2;

  let isRecommended = true;
  let gateFailReason: string | undefined;

  if (combinedEVPct < MIN_COMBO_EV_PCT) {
    isRecommended = false;
    gateFailReason = `Combo EV ${combinedEVPct.toFixed(1)}% < minimum ${MIN_COMBO_EV_PCT}%`;
  }

  for (const leg of legs) {
    if (leg.starRating < MIN_LEG_STARS) {
      isRecommended = false;
      gateFailReason = `Leg "${leg.selection}" has ${leg.starRating} stars < minimum ${MIN_LEG_STARS}`;
      break;
    }
  }

  if (sameMatch && correlationDiscount > 0.25) {
    isRecommended = false;
    gateFailReason = `Same-match correlation discount ${(correlationDiscount * 100).toFixed(0)}% too high — legs too dependent`;
  }

  return {
    comboId,
    legs,
    combinedOdds,
    naiveJointProb,
    correlationDiscount,
    adjustedJointProb,
    combinedImpliedProb,
    combinedEV,
    combinedEVPct,
    kellyFull,
    kellyHalf,
    isRecommended,
    gateFailReason,
    sameMatch,
  };
}

function computeCorrelationDiscount(legs: ComboLeg[]): number {
  let maxDiscount = 0;

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      for (const pair of CORRELATION_PAIRS) {
        const mi = legs[i].market.toLowerCase();
        const mj = legs[j].market.toLowerCase();
        if (
          (pair.a.test(mi) && pair.b.test(mj)) ||
          (pair.a.test(mj) && pair.b.test(mi))
        ) {
          maxDiscount = Math.max(maxDiscount, pair.discount);
        }
      }
    }
  }

  return maxDiscount;
}

export function selectBestCombo(allLegs: ComboLeg[]): ComboResult | null {
  if (allLegs.length < 2) return null;

  const qualifying = allLegs.filter(l => l.starRating >= MIN_LEG_STARS && l.ev > 0);
  if (qualifying.length < 2) return null;

  qualifying.sort((a, b) => b.ev - a.ev);

  const topLegs = qualifying.slice(0, MAX_LEGS);
  const combo = buildCombo(topLegs);

  if (!combo.isRecommended) return combo;

  return combo;
}
