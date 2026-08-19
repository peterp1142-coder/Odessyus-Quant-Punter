/**
 * Feature Extractor v2 — converts scout text into structured numbers
 * for the Monte Carlo engine and deterministic scorer.
 *
 * Upgrades:
 *  - Extracts new FormSignals fields: xgConcededHome/Away, homeWinPctVenue,
 *    streakHome/Away, restDaysHome/Away
 *  - Extracts new MarketSignals: openingOddsHome, currentOddsHome, pinnacleOdds, overround
 *  - Extracts new InjurySignals: absentPlayerRatingHome/Away
 *  - Uses mistral-small-latest (fast/cheap extraction — math not LLM-driven)
 */

import { mistralPool } from './mistral-pool.js';
import type { MarketSignals, FormSignals, InjurySignals, SentimentSignals } from './scorer.js';

export interface ExtractedFeatures {
  form:      FormSignals;
  market:    MarketSignals;
  injury:    InjurySignals;
  sentiment: SentimentSignals;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const FORM_DEFAULTS: FormSignals = {
  xgHome: 1.3, xgAway: 1.1,
  xgConcededHome: 1.1, xgConcededAway: 1.3,
  formPtsHome: 7, formPtsAway: 7,
  h2hWinRateHome: 0.40,
  formDataQuality: 0.1,
  homeWinPctVenue: 0.45, awayWinPctVenue: 0.30,
  streakHome: 0, streakAway: 0,
  restDaysHome: 4, restDaysAway: 4,
};

const MARKET_DEFAULTS: MarketSignals = {
  impliedProbHome: 0.45,
  reverseLM: false,
  lineMovement: 0,
  oddsDataQuality: 0.1,
  openingOddsHome: 0,
  currentOddsHome: 0,
  pinnacleOdds: 0,
  overround: 0.05,
};

const INJURY_DEFAULTS: InjurySignals = {
  injuryIndexHome: 0, injuryIndexAway: 0,
  gtdRiskHome: 0, gtdRiskAway: 0,
  injuryDataQuality: 0.1,
  absentPlayerRatingHome: 0,
  absentPlayerRatingAway: 0,
};

const SENTIMENT_DEFAULTS: SentimentSignals = {
  motivationHome: 0.5, motivationAway: 0.5,
  weatherImpact: 0, refBias: 0,
  sentimentDataQuality: 0.1,
  crowdFactor: 0.1,
};

function clamp(v: number, lo: number, hi: number): number {
  if (!isFinite(v)) return (lo + hi) / 2;
  return Math.max(lo, Math.min(hi, v));
}

function orDefault(v: unknown, def: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return isFinite(n) ? n : def;
}

// ─── Main extractor ───────────────────────────────────────────────────────────

export async function extractFeatures(opts: {
  formText:      string;
  oddsText:      string;
  injuryText:    string;
  sentimentText: string;
  fixture:       string;
  market:        string;
}): Promise<ExtractedFeatures> {
  const { formText, oddsText, injuryText, sentimentText, fixture, market } = opts;

  const prompt = `You are a sports data parser. Extract numeric signals from the scout reports below.
Return ONLY valid JSON. Use null for any value you cannot find.

FIXTURE: ${fixture}
MARKET: ${market}

=== FORM SCOUT ===
${formText.substring(0, 3000)}

=== ODDS SCOUT ===
${oddsText.substring(0, 2000)}

=== INJURY/LINEUP SCOUT ===
${injuryText.substring(0, 2500)}

=== SENTIMENT SCOUT ===
${sentimentText.substring(0, 1500)}

Extract and return this exact JSON (numbers only, no strings for numeric fields):
{
  "xgHome": <home xG per game, e.g. 1.4>,
  "xgAway": <away xG per game>,
  "xgConcededHome": <home xG conceded per game>,
  "xgConcededAway": <away xG conceded per game>,
  "formPtsHome": <recent form points out of 15>,
  "formPtsAway": <same for away>,
  "h2hWinRateHome": <home H2H win rate 0-1>,
  "homeWinPctVenue": <home team win % at their own stadium 0-1>,
  "awayWinPctVenue": <away team win % in away games 0-1>,
  "streakHome": <current streak -3 to +3, positive=winning>,
  "streakAway": <same for away>,
  "restDaysHome": <days since home team's last match>,
  "restDaysAway": <days since away team's last match>,
  "formDataQuality": <0-1 how complete was form data>,
  "impliedProbHome": <bookmaker implied probability for home 0-1>,
  "openingOddsHome": <opening decimal odds for home>,
  "currentOddsHome": <current decimal odds for home>,
  "pinnacleOdds": <pinnacle odds for home if available>,
  "overround": <bookmaker margin 0-0.15, e.g. 0.05>,
  "reverseLM": <1 if reverse line movement detected else 0>,
  "lineMovement": <-1 to +1, positive=toward home>,
  "oddsDataQuality": <0-1>,
  "injuryIndexHome": <0-10 injury severity>,
  "injuryIndexAway": <0-10>,
  "absentPlayerRatingHome": <0-10 quality of absent players>,
  "absentPlayerRatingAway": <0-10>,
  "gtdRiskHome": <0-1>,
  "gtdRiskAway": <0-1>,
  "injuryDataQuality": <0-1>,
  "motivationHome": <0-1>,
  "motivationAway": <0-1>,
  "weatherImpact": <-0.5 to 0.5>,
  "refBias": <-0.3 to 0.3>,
  "crowdFactor": <0-1 crowd advantage>,
  "sentimentDataQuality": <0-1>
}`;

  try {
    const resp = await mistralPool.call(client =>
      client.chat.complete({
        model: 'mistral-small-latest',
        messages: [
          { role: 'system', content: 'Extract numeric features from sports scout reports. Return only valid JSON.' },
          { role: 'user',   content: prompt },
        ] as any,
        temperature: 0,
        maxTokens: 700,
      })
    );

    const raw  = resp.choices?.[0]?.message?.content ?? '';
    const text = typeof raw === 'string' ? raw : '';
    const m    = text.match(/\{[\s\S]+\}/);
    if (!m) throw new Error('No JSON found');

    const j = JSON.parse(m[0]) as Record<string, unknown>;

    // ── Programmatic data-quality checks ──────────────────────────────────
    // Instead of trusting the LLM's self-reported quality scores, we verify
    // whether the scout actually returned non-default values for key fields.
    // A field counts as "present" if the LLM provided a real value (not null)
    // AND the value differs from the hardcoded default.

    const formFieldsPresent = [
      j.xgHome != null && orDefault(j.xgHome, -999) !== FORM_DEFAULTS.xgHome,
      j.xgAway != null && orDefault(j.xgAway, -999) !== FORM_DEFAULTS.xgAway,
      j.xgConcededHome != null && orDefault(j.xgConcededHome, -999) !== FORM_DEFAULTS.xgConcededHome,
      j.xgConcededAway != null && orDefault(j.xgConcededAway, -999) !== FORM_DEFAULTS.xgConcededAway,
      j.formPtsHome != null && orDefault(j.formPtsHome, -999) !== FORM_DEFAULTS.formPtsHome,
      j.formPtsAway != null && orDefault(j.formPtsAway, -999) !== FORM_DEFAULTS.formPtsAway,
      j.h2hWinRateHome != null && orDefault(j.h2hWinRateHome, -999) !== FORM_DEFAULTS.h2hWinRateHome,
      j.homeWinPctVenue != null && orDefault(j.homeWinPctVenue, -999) !== FORM_DEFAULTS.homeWinPctVenue,
      j.awayWinPctVenue != null && orDefault(j.awayWinPctVenue, -999) !== FORM_DEFAULTS.awayWinPctVenue,
      j.streakHome != null && orDefault(j.streakHome, -999) !== FORM_DEFAULTS.streakHome,
      j.streakAway != null && orDefault(j.streakAway, -999) !== FORM_DEFAULTS.streakAway,
      j.restDaysHome != null && orDefault(j.restDaysHome, -999) !== FORM_DEFAULTS.restDaysHome,
      j.restDaysAway != null && orDefault(j.restDaysAway, -999) !== FORM_DEFAULTS.restDaysAway,
    ];
    // Also boost if the raw form text was substantial (not empty/truncated)
    const formTextBonus = formText.length > 500 ? 0.15 : 0;
    const formDataQuality = clamp(
      (formFieldsPresent.filter(Boolean).length / formFieldsPresent.length) * 0.85 + formTextBonus,
      0, 1,
    );

    const marketFieldsPresent = [
      j.impliedProbHome != null && orDefault(j.impliedProbHome, -999) !== MARKET_DEFAULTS.impliedProbHome,
      j.openingOddsHome != null && orDefault(j.openingOddsHome, -999) !== 0,
      j.currentOddsHome != null && orDefault(j.currentOddsHome, -999) !== 0,
      j.pinnacleOdds != null && orDefault(j.pinnacleOdds, -999) !== 0,
      j.reverseLM === 1 || j.reverseLM === true,
      j.lineMovement != null && orDefault(j.lineMovement, -999) !== 0,
      j.overround != null && orDefault(j.overround, -999) !== 0.05,
    ];
    const oddsTextBonus = oddsText.length > 500 ? 0.15 : 0;
    const oddsDataQuality = clamp(
      (marketFieldsPresent.filter(Boolean).length / marketFieldsPresent.length) * 0.85 + oddsTextBonus,
      0, 1,
    );

    const injuryFieldsPresent = [
      j.injuryIndexHome != null && orDefault(j.injuryIndexHome, -999) !== 0,
      j.injuryIndexAway != null && orDefault(j.injuryIndexAway, -999) !== 0,
      j.absentPlayerRatingHome != null && orDefault(j.absentPlayerRatingHome, -999) !== 0,
      j.absentPlayerRatingAway != null && orDefault(j.absentPlayerRatingAway, -999) !== 0,
      j.gtdRiskHome != null && orDefault(j.gtdRiskHome, -999) !== 0,
      j.gtdRiskAway != null && orDefault(j.gtdRiskAway, -999) !== 0,
    ];
    const injuryTextBonus = injuryText.length > 500 ? 0.2 : 0;
    const injuryDataQuality = clamp(
      (injuryFieldsPresent.filter(Boolean).length / injuryFieldsPresent.length) * 0.8 + injuryTextBonus,
      0, 1,
    );

    const sentimentFieldsPresent = [
      j.motivationHome != null && orDefault(j.motivationHome, -999) !== 0.5,
      j.motivationAway != null && orDefault(j.motivationAway, -999) !== 0.5,
      j.weatherImpact != null && orDefault(j.weatherImpact, -999) !== 0,
      j.refBias != null && orDefault(j.refBias, -999) !== 0,
      j.crowdFactor != null && orDefault(j.crowdFactor, -999) !== 0.1,
    ];
    const sentimentTextBonus = sentimentText.length > 300 ? 0.2 : 0;
    const sentimentDataQuality = clamp(
      (sentimentFieldsPresent.filter(Boolean).length / sentimentFieldsPresent.length) * 0.8 + sentimentTextBonus,
      0, 1,
    );

    const form: FormSignals = {
      xgHome:            clamp(orDefault(j.xgHome,            FORM_DEFAULTS.xgHome),            0.1, 5),
      xgAway:            clamp(orDefault(j.xgAway,            FORM_DEFAULTS.xgAway),            0.1, 5),
      xgConcededHome:    clamp(orDefault(j.xgConcededHome,    FORM_DEFAULTS.xgConcededHome),    0.1, 5),
      xgConcededAway:    clamp(orDefault(j.xgConcededAway,    FORM_DEFAULTS.xgConcededAway),    0.1, 5),
      formPtsHome:       clamp(orDefault(j.formPtsHome,       FORM_DEFAULTS.formPtsHome),       0, 15),
      formPtsAway:       clamp(orDefault(j.formPtsAway,       FORM_DEFAULTS.formPtsAway),       0, 15),
      h2hWinRateHome:    clamp(orDefault(j.h2hWinRateHome,    FORM_DEFAULTS.h2hWinRateHome),    0, 1),
      homeWinPctVenue:   clamp(orDefault(j.homeWinPctVenue,   FORM_DEFAULTS.homeWinPctVenue),   0, 1),
      awayWinPctVenue:   clamp(orDefault(j.awayWinPctVenue,   FORM_DEFAULTS.awayWinPctVenue),   0, 1),
      streakHome:        clamp(orDefault(j.streakHome,        FORM_DEFAULTS.streakHome),        -5, 5),
      streakAway:        clamp(orDefault(j.streakAway,        FORM_DEFAULTS.streakAway),        -5, 5),
      restDaysHome:      clamp(orDefault(j.restDaysHome,      FORM_DEFAULTS.restDaysHome),      0, 21),
      restDaysAway:      clamp(orDefault(j.restDaysAway,      FORM_DEFAULTS.restDaysAway),      0, 21),
      formDataQuality,
    };

    const marketS: MarketSignals = {
      impliedProbHome:   clamp(orDefault(j.impliedProbHome,   MARKET_DEFAULTS.impliedProbHome), 0.05, 0.95),
      reverseLM:         !!j.reverseLM,
      lineMovement:      clamp(orDefault(j.lineMovement,      0),                               -1, 1),
      oddsDataQuality,
      openingOddsHome:   clamp(orDefault(j.openingOddsHome,   0),                               0, 50),
      currentOddsHome:   clamp(orDefault(j.currentOddsHome,   0),                               0, 50),
      pinnacleOdds:      clamp(orDefault(j.pinnacleOdds,      0),                               0, 50),
      overround:         clamp(orDefault(j.overround,         0.05),                            0, 0.20),
    };

    const injury: InjurySignals = {
      injuryIndexHome:         clamp(orDefault(j.injuryIndexHome,         0),  0, 10),
      injuryIndexAway:         clamp(orDefault(j.injuryIndexAway,         0),  0, 10),
      absentPlayerRatingHome:  clamp(orDefault(j.absentPlayerRatingHome,  0),  0, 10),
      absentPlayerRatingAway:  clamp(orDefault(j.absentPlayerRatingAway,  0),  0, 10),
      gtdRiskHome:             clamp(orDefault(j.gtdRiskHome,             0),  0, 1),
      gtdRiskAway:             clamp(orDefault(j.gtdRiskAway,             0),  0, 1),
      injuryDataQuality,
    };

    const sentiment: SentimentSignals = {
      motivationHome:       clamp(orDefault(j.motivationHome,       0.5), 0, 1),
      motivationAway:       clamp(orDefault(j.motivationAway,       0.5), 0, 1),
      weatherImpact:        clamp(orDefault(j.weatherImpact,        0),   -0.5, 0.5),
      refBias:              clamp(orDefault(j.refBias,              0),   -0.3, 0.3),
      crowdFactor:          clamp(orDefault(j.crowdFactor,          0.1), 0, 1),
      sentimentDataQuality,
    };

    return { form, market: marketS, injury, sentiment };

  } catch {
    // Extraction failed entirely — all quality scores reflect zero data
    return {
      form:      { ...FORM_DEFAULTS,      formDataQuality: formText.length > 500 ? 0.2 : 0.05 },
      market:    { ...MARKET_DEFAULTS,    oddsDataQuality: oddsText.length > 500 ? 0.2 : 0.05 },
      injury:    { ...INJURY_DEFAULTS,    injuryDataQuality: injuryText.length > 500 ? 0.2 : 0.05 },
      sentiment: { ...SENTIMENT_DEFAULTS, sentimentDataQuality: sentimentText.length > 300 ? 0.2 : 0.05 },
    };
  }
}
