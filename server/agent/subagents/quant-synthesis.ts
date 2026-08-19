/**
 * QuantSynthesisAgent v2 — Category 6: Meta-Modeling & Ensemble Logic
 *
 * Upgrades:
 *  1. Mistral-large-latest for highest accuracy narration
 *  2. 50,000-iteration Poisson Monte Carlo with Dixon-Coles correction
 *  3. Kelly Criterion output embedded in final answer
 *  4. Accuracy gate — only outputs picks that clear EV threshold
 *  5. Asian handicap and DNB market coverage
 *  6. Extended feature extractor including new FormSignals fields
 *  7. Data completeness guard — degrades confidence, never silently fails
 */
import type { ReActStep } from '../react-engine.js';
import type { SubAgentResult } from './base.js';
import { buildSystemPrompt } from '../prompts.js';
import { mistralPool } from '../mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../checkpoint.js';
import { runMonteCarlo } from '../monte-carlo.js';
import { score, calcKelly, ACCURACY_GATE } from '../scorer.js';
import { extractFeatures } from '../feature-extractor.js';

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
  categoryProbabilities: { market: number; form: number; injury: number; sentiment: number };
}

// ─── Multi-fixture shortlist synthesiser ──────────────────────────────────────

async function synthesiseMultiFixture(args: {
  userQuery: string;
  fixture: string;
  sport: string;
  market: string;
  sessionId: string;
  oddsResult: SubAgentResult;
  formResult: SubAgentResult;
  injuryResult: SubAgentResult;
  sentimentResult: SubAgentResult;
  discoveredFixtures: string[];
  emit: (step: ReActStep) => void;
  steps: ReActStep[];
}): Promise<QuantResult> {
  const { userQuery, fixture, sport, oddsResult, formResult, injuryResult, sentimentResult, discoveredFixtures, emit, steps } = args;

  emit({ type: 'status', content: `Generating ranked value-bet shortlist across ${discoveredFixtures.length} fixtures…` });

  // Parse OddsScout's multi-pick JSON from rawOutput
  let oddsPicksText = '';
  try {
    const raw = oddsResult.rawOutput || '';
    // OddsScout outputs a JSON block — extract it
    const jsonMatch = raw.match(/```json\s*([\s\S]+?)```/) || raw.match(/(\{[\s\S]*"picks"[\s\S]*\})/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]) as { picks?: unknown[] };
      if (Array.isArray(parsed.picks) && parsed.picks.length > 0) {
        oddsPicksText = JSON.stringify(parsed.picks, null, 2);
      }
    }
    if (!oddsPicksText) oddsPicksText = raw.substring(0, 3000);
  } catch {
    oddsPicksText = (oddsResult.rawOutput || '').substring(0, 3000);
  }

  const formSummary      = formResult.success      ? (formResult.rawOutput      || '').substring(0, 1000) : `FAILED: ${formResult.error}`;
  const injurySummary    = injuryResult.success     ? (injuryResult.rawOutput    || '').substring(0, 800)  : `FAILED: ${injuryResult.error}`;
  const sentimentSummary = sentimentResult.success  ? (sentimentResult.rawOutput || '').substring(0, 600)  : `FAILED: ${sentimentResult.error}`;

  const today = new Date().toISOString().split('T')[0];

  const prompt = `${buildSystemPrompt()}

You are the QuantSynthesisAgent. OddsScout has already ranked today's fixtures by expected value.
Your job is to produce a clean, ranked value-bet shortlist for the user.

USER QUERY: "${userQuery}"
DATE: ${today}
SPORT: ${sport}
TOTAL FIXTURES SCANNED: ${discoveredFixtures.length}

=== ODDS SCOUT RANKED PICKS (sorted by EV, highest first) ===
${oddsPicksText}

=== FORM SCOUT CONTEXT (trends, xG, BTTS across today's schedule) ===
${formSummary}

=== INJURY / SUSPENSION CONTEXT ===
${injurySummary}

=== SENTIMENT / NEWS CONTEXT ===
${sentimentSummary}

INSTRUCTIONS:
1. List the top value bets in a ranked table (best EV first). Include only picks with value_tier A or B (skip C and skip).
2. For each pick include: Fixture | Market | Odds | EV% | Sharp signal | Star rating (1-5) | Stake advice
3. Add a 1-sentence rationale for each pick drawing on form/injury/sentiment context where relevant.
4. Flag any injury/suspension risks or news that could invalidate a pick.
5. If no picks pass the value threshold, honestly say so and suggest monitoring.
6. End with a brief executive summary paragraph.

Use FINAL_ANSWER: format. Be concise but complete.`;

  try {
    const resp = await mistralPool.call(client =>
      client.chat.complete({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user',   content: `Produce the ranked value-bet shortlist for ${today}.` },
        ] as any,
        temperature: 0.1,
        maxTokens: 4000,
      })
    );

    const content = resp.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) throw new Error('Empty multi-fixture synthesis response');

    const finalAnswer = content.includes('FINAL_ANSWER:')
      ? content.substring(content.indexOf('FINAL_ANSWER:') + 13).trim()
      : content;

    emit({ type: 'synthesis', content: `Ranked shortlist complete — ${discoveredFixtures.length} fixtures scanned.` });

    return {
      finalAnswer, steps, success: true,
      monteCarlo: { home: 0, draw: 0, away: 0, stdDev: 0 },
      trueProb: 0, impliedProb: 0, expectedValue: 0,
      starRating: 0, dataCompletenessScore: 70,
      isValueBet: true, recommendedStake: 'SEE SHORTLIST',
      recommendedOdds: 0, confidence: 70,
      goalStatement: `Ranked value-bet shortlist — ${discoveredFixtures.length} ${sport} fixtures on ${today}`,
      categoryProbabilities: { market: 0, form: 0, injury: 0, sentiment: 0 },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', content: `Multi-fixture synthesis error: ${msg}` });
    // Fallback: return the raw OddsScout picks as the answer
    const fallback = oddsResult.rawOutput
      ? `⚠️ Synthesis error (${msg}). Raw OddsScout picks:\n\n${oddsResult.rawOutput.substring(0, 2000)}`
      : `⚠️ Synthesis failed: ${msg}`;
    return {
      finalAnswer: fallback, steps, success: false, error: msg,
      monteCarlo: { home: 0, draw: 0, away: 0, stdDev: 0 },
      trueProb: 0, impliedProb: 0, expectedValue: 0,
      starRating: 0, dataCompletenessScore: 30,
      isValueBet: false, recommendedStake: 'SKIP',
      recommendedOdds: 0, confidence: 30,
      goalStatement: `Multi-fixture shortlist — synthesis failed`,
      categoryProbabilities: { market: 0, form: 0, injury: 0, sentiment: 0 },
    };
  }
}

// ─── Main synthesis function ───────────────────────────────────────────────────

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
  onStep: (step: ReActStep) => void;
  /** Multi-fixture mode: OddsScout has already ranked all fixtures by EV */
  isMultiFixture?: boolean;
  discoveredFixtures?: string[];
}): Promise<QuantResult> {
  const {
    userQuery, fixture, sport, market = 'Match Result', sessionId = 'default',
    oddsResult, formResult, injuryResult, sentimentResult, lineupResult, onStep,
    isMultiFixture = false, discoveredFixtures = [],
  } = opts;
  const steps: ReActStep[] = [];
  const now = () => new Date().toISOString();
  const tag = '[⚡ QUANT]';

  const emit = (step: ReActStep) => {
    const s = { ...step, content: `${tag} ${step.content}`, timestamp: now() };
    steps.push(s);
    onStep(s);
  };

  const agentName = 'QuantSynthesis';

  // ── Checkpoint restore ─────────────────────────────────────────────────
  const existing = await loadCheckpoint(sessionId, agentName);
  if (existing?.rawOutput) {
    emit({ type: 'status', content: 'Restoring synthesis from checkpoint…' });
    const finalAnswer = existing.rawOutput;
    const cd = existing.accumulatedData as Record<string, unknown>;
    const monteCarlo = (cd?.monteCarlo as QuantResult['monteCarlo']) || { home: 0.4, draw: 0.28, away: 0.32, stdDev: 0.05 };
    await clearCheckpoint(sessionId, agentName);
    return {
      finalAnswer, steps, success: true, monteCarlo,
      trueProb:    (cd?.trueProb    as number) || 0.5,
      impliedProb: (cd?.impliedProb as number) || 0.45,
      expectedValue: (cd?.expectedValue as number) || 0,
      starRating:  (cd?.starRating  as number) || 1,
      dataCompletenessScore: (cd?.dataCompletenessScore as number) || 50,
      isValueBet:  (cd?.isValueBet  as boolean) ?? false,
      recommendedStake: (cd?.recommendedStake as string) || 'MONITOR',
      recommendedOdds: (cd?.recommendedOdds as number) || 2.0,
      confidence: (cd?.confidence as number) || 50,
      goalStatement: (cd?.goalStatement as string) || `${fixture} — ${market}`,
      categoryProbabilities: (cd?.categoryProbabilities as QuantResult['categoryProbabilities']) || { market: 0, form: 0, injury: 0, sentiment: 0 },
    };
  }

  // ── Multi-fixture shortlist mode ──────────────────────────────────────────
  // When OddsScout ran across ALL fixtures, we skip single-match Monte Carlo
  // and instead generate a ranked value-bet shortlist from the picks array.
  if (isMultiFixture && oddsResult.success && oddsResult.rawOutput) {
    return await synthesiseMultiFixture({
      userQuery, fixture, sport, market, sessionId,
      oddsResult, formResult, injuryResult, sentimentResult,
      discoveredFixtures, emit, steps,
    });
  }

  emit({ type: 'status', content: 'Extracting numeric features from all scout reports…' });

  // Merge lineup data into injury text for feature extraction
  const lineupText = lineupResult?.success
    ? (lineupResult.rawOutput || JSON.stringify(lineupResult.data))
    : '';
  const combinedInjuryText = [
    injuryResult.success ? (injuryResult.rawOutput || JSON.stringify(injuryResult.data)) : '',
    lineupText,
  ].filter(Boolean).join('\n\n=== LINEUP DATA ===\n');

  // ── Step 1: Extract structured numeric features ─────────────────────────
  const features = await extractFeatures({
    formText:      formResult.success      ? (formResult.rawOutput      || JSON.stringify(formResult.data))      : '',
    oddsText:      oddsResult.success      ? (oddsResult.rawOutput      || JSON.stringify(oddsResult.data))      : '',
    injuryText:    combinedInjuryText,
    sentimentText: sentimentResult.success ? (sentimentResult.rawOutput || JSON.stringify(sentimentResult.data)) : '',
    fixture,
    market,
  });

  emit({ type: 'thought', content:
    `Features extracted — ` +
    `xG: ${features.form.xgHome.toFixed(2)} vs ${features.form.xgAway.toFixed(2)} | ` +
    `Implied: ${(features.market.impliedProbHome * 100).toFixed(1)}% | ` +
    `Injury: H=${features.injury.injuryIndexHome.toFixed(1)} A=${features.injury.injuryIndexAway.toFixed(1)}`
  });

  // ── Step 2: Poisson Monte Carlo (50,000 iterations + Dixon-Coles) ──────
  emit({ type: 'status', content: 'Running Poisson Monte Carlo simulation (50,000 iterations + Dixon-Coles correction)…' });

  const injuryAdjustHome = Math.min(0.5, (features.injury.injuryIndexHome / 10) * 0.4 + ((features.injury.absentPlayerRatingHome ?? 0) / 10) * 0.1);
  const injuryAdjustAway = Math.min(0.5, (features.injury.injuryIndexAway / 10) * 0.4 + ((features.injury.absentPlayerRatingAway ?? 0) / 10) * 0.1);

  const mcResult = runMonteCarlo({
    xgHome: features.form.xgHome,
    xgAway: features.form.xgAway,
    homeAdvantage: 0.15,
    dixonColesRho: 0.10,
    injuryAdjustHome,
    injuryAdjustAway,
  });

  emit({ type: 'thought', content:
    `Monte Carlo (${mcResult.simCount.toLocaleString()} sims) — ` +
    `P(Home): ${(mcResult.homeWin * 100).toFixed(1)}% | ` +
    `P(Draw): ${(mcResult.draw * 100).toFixed(1)}% | ` +
    `P(Away): ${(mcResult.awayWin * 100).toFixed(1)}% | ` +
    `BTTS: ${(mcResult.btts * 100).toFixed(1)}% | ` +
    `O/U2.5: ${(mcResult.over25 * 100).toFixed(1)}%/${(mcResult.under25 * 100).toFixed(1)}% | ` +
    `AH(-0.5): ${(mcResult.ahHome05 * 100).toFixed(1)}% home | ` +
    `95% CI: [${(mcResult.confidenceInterval.low * 100).toFixed(1)}%, ${(mcResult.confidenceInterval.high * 100).toFixed(1)}%] | ` +
    `stdDev: ±${(mcResult.stdDev * 100).toFixed(2)}%`
  });

  // ── Step 3: Deterministic weighted scorer ──────────────────────────────
  emit({ type: 'status', content: 'Applying weighted feature scorer (market 35% | form 30% | injury 25% | sentiment 10%)…' });

  const targetOddsFromData = features.market.impliedProbHome > 0.05
    ? 1 / features.market.impliedProbHome
    : 2.0;

  const scored = score({
    market,
    mcResult,
    marketSignals:    features.market,
    formSignals:      features.form,
    injurySignals:    features.injury,
    sentimentSignals: features.sentiment,
    targetOdds:       targetOddsFromData,
  });

  const trueProb    = scored.finalProbability;
  const impliedProb = features.market.impliedProbHome;
  const dataCompletenessScore = scored.dataCompletenessScore;

  emit({ type: 'thought', content: scored.calibrationNote });

  // ── Step 4: Kelly Criterion ────────────────────────────────────────────
  const targetOdds = targetOddsFromData;
  const kellyResult = calcKelly(trueProb, targetOdds);

  const evPct       = scored.expectedValuePct;
  const expectedValue = scored.expectedValue;
  const starRating  = scored.starRating;
  const isValueBet  = scored.isValueBet;
  const recommendedStake = scored.recommendedStake;

  emit({ type: 'thought', content:
    `Gate: ${isValueBet ? '✅ PASS' : `❌ FAIL — ${scored.gateFailReason}`} | ` +
    `EV: ${evPct >= 0 ? '+' : ''}${evPct.toFixed(2)}% | ` +
    `Kelly: ${kellyResult.halfKelly}% bankroll (half-Kelly) | ` +
    `⭐${starRating}/5 — ${recommendedStake}`
  });

  // Compile scout data for LLM narrative
  const lineupSummary = lineupResult?.success
    ? `\n=== LINEUP SCOUT DATA ===\n${(lineupResult.rawOutput || JSON.stringify(lineupResult.data, null, 2)).substring(0, 1000)}`
    : '';

  const scoutBrief = `
=== ODDS SCOUT DATA ===
${oddsResult.success ? (oddsResult.rawOutput || JSON.stringify(oddsResult.data, null, 2)).substring(0, 1800) : `FAILED: ${oddsResult.error}`}

=== FORM SCOUT DATA ===
${formResult.success ? (formResult.rawOutput || JSON.stringify(formResult.data, null, 2)).substring(0, 1800) : `FAILED: ${formResult.error}`}

=== INJURY INTEL DATA ===
${injuryResult.success ? (injuryResult.rawOutput || JSON.stringify(injuryResult.data, null, 2)).substring(0, 1200) : `FAILED: ${injuryResult.error}`}
${lineupSummary}

=== SENTIMENT DATA ===
${sentimentResult.success ? (sentimentResult.rawOutput || JSON.stringify(sentimentResult.data, null, 2)).substring(0, 1000) : `FAILED: ${sentimentResult.error}`}
`;

  // ── Step 5: LLM narrates the prediction ───────────────────────────────
  emit({ type: 'status', content: 'Generating expert prediction narrative (math anchored — LLM writes analysis)…' });

  // Top correct scores for inclusion in narrative
  const topScores = Object.entries(mcResult.correctScoreDistribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([s, p]) => `${s} (${(p * 100).toFixed(1)}%)`)
    .join(', ');

  const gateWarning = !isValueBet
    ? `\n⚠️ ACCURACY GATE: This pick did NOT pass the value threshold (${scored.gateFailReason}). ` +
      `Report this honestly in the recommendation — label it PASS/MONITOR, NOT a confident bet.\n`
    : `\n✅ ACCURACY GATE: PASSED — EV ${evPct.toFixed(1)}% clears minimum threshold.\n`;

  const synthesisPrompt = `${buildSystemPrompt()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOU ARE THE QUANTITATIVE SYNTHESIS AGENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

THE MATH IS ALREADY DONE. Do NOT recalculate probabilities. Use these exact values:

▶ MONTE CARLO (${mcResult.simCount.toLocaleString()} Poisson sims + Dixon-Coles correction):
  P(Home Win):  ${(mcResult.homeWin * 100).toFixed(1)}%
  P(Draw):      ${(mcResult.draw    * 100).toFixed(1)}%
  P(Away Win):  ${(mcResult.awayWin * 100).toFixed(1)}%
  BTTS Yes:     ${(mcResult.btts    * 100).toFixed(1)}%
  Over 2.5:     ${(mcResult.over25  * 100).toFixed(1)}%
  Under 2.5:    ${(mcResult.under25 * 100).toFixed(1)}%
  Over 3.5:     ${(mcResult.over35  * 100).toFixed(1)}%
  AH Home -0.5: ${(mcResult.ahHome05 * 100).toFixed(1)}%
  DNB Home:     ${(mcResult.dnbHome * 100).toFixed(1)}%
  Avg Goals:    ${mcResult.avgGoalsHome.toFixed(2)} – ${mcResult.avgGoalsAway.toFixed(2)}
  Total Goals:  ${mcResult.avgTotalGoals.toFixed(2)} avg
  Std Dev:      ±${(mcResult.stdDev * 100).toFixed(2)}%
  95% CI:       [${(mcResult.confidenceInterval.low  * 100).toFixed(1)}%, ${(mcResult.confidenceInterval.high * 100).toFixed(1)}%]
  Top Scores:   ${topScores}

▶ WEIGHTED SCORER (market 35% | form 30% | injury 25% | sentiment 10%):
  Final True Probability: ${(trueProb * 100).toFixed(1)}%
  Bookmaker Implied:      ${(impliedProb * 100).toFixed(1)}%
  Expected Value:         ${evPct >= 0 ? '+' : ''}${evPct.toFixed(2)}%
  Star Rating:            ${starRating}/5
  Stake Level:            ${recommendedStake}
  Data Completeness:      ${dataCompletenessScore}%
  Calibration:            ${scored.calibrationNote}

▶ KELLY CRITERION:
  Full Kelly:    ${kellyResult.fullKelly}% of bankroll
  Half-Kelly:    ${kellyResult.halfKelly}% of bankroll (recommended)
  Quarter-Kelly: ${kellyResult.quarterKelly}% of bankroll (conservative)
  Advice:        ${kellyResult.recommendation}
${gateWarning}

Your job is ONLY to:
1. Write a rigorous, expert-level narrative explaining the math's verdict
2. Highlight key qualitative factors from the scout data that support or challenge the numbers
3. Flag any risks or conditions that would INVALIDATE this pick
4. Output the complete FINAL_ANSWER structure with ALL exact numbers embedded

USER QUERY: ${userQuery}
FIXTURE: ${fixture}
SPORT: ${sport}
MARKET: ${market}

SCOUT DATA:
${scoutBrief}

Use FINAL_ANSWER: format. Embed every exact probability number above. Be honest — if data quality is low, say so.`;

  try {
    const resp = await mistralPool.call(client =>
      client.chat.complete({
        model: 'mistral-large-latest',
        messages: [
          { role: 'system', content: synthesisPrompt },
          { role: 'user',   content: `Write the complete FINAL_ANSWER prediction narrative for: ${fixture}` },
        ] as any,
        temperature: 0.1,
        maxTokens: 5000,
      })
    );

    const content = resp.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content) {
      throw new Error('Empty synthesis response');
    }

    emit({ type: 'synthesis', content: 'Narrative synthesis complete.' });

    const finalAnswer = content.includes('FINAL_ANSWER:')
      ? content.substring(content.indexOf('FINAL_ANSWER:') + 13).trim()
      : content;

    const monteCarlo = {
      home:   mcResult.homeWin,
      draw:   mcResult.draw,
      away:   mcResult.awayWin,
      stdDev: mcResult.stdDev,
    };

    emit({ type: 'thought', content:
      `✅ Final: True ${(trueProb * 100).toFixed(1)}% | Implied ${(impliedProb * 100).toFixed(1)}% | ` +
      `EV ${evPct >= 0 ? '+' : ''}${evPct.toFixed(2)}% | ⭐${starRating}/5 | ` +
      `Data: ${dataCompletenessScore}% | Gate: ${isValueBet ? 'PASS' : 'FAIL'}`
    });

    await saveCheckpoint({
      sessionId, agentName, messages: [], iteration: 1,
      steps: [...steps], rawOutput: finalAnswer,
      accumulatedData: { monteCarlo, trueProb, impliedProb, expectedValue, starRating, dataCompletenessScore, isValueBet, recommendedStake },
      savedAt: Date.now(), version: 3,
    });

    return {
      finalAnswer, steps, success: true, monteCarlo,
      trueProb, impliedProb, expectedValue, starRating, dataCompletenessScore, isValueBet, recommendedStake,
      recommendedOdds: targetOdds,
      confidence: Math.round(dataCompletenessScore),
      goalStatement: `${fixture} — ${market} — True ${(trueProb * 100).toFixed(1)}% vs implied ${(impliedProb * 100).toFixed(1)}%`,
      categoryProbabilities: scored.categoryProbabilities,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', content: `Synthesis error: ${msg}` });
    return {
      finalAnswer: '', steps, success: false, error: msg,
      monteCarlo: { home: mcResult.homeWin, draw: mcResult.draw, away: mcResult.awayWin, stdDev: mcResult.stdDev },
      trueProb, impliedProb, expectedValue, starRating, dataCompletenessScore, isValueBet, recommendedStake,
      recommendedOdds: targetOdds,
      confidence: Math.round(dataCompletenessScore),
      goalStatement: `${fixture} — ${market} — True ${(trueProb * 100).toFixed(1)}% vs implied ${(impliedProb * 100).toFixed(1)}%`,
      categoryProbabilities: scored.categoryProbabilities,
    };
  }
}
