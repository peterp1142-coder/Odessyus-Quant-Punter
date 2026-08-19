/**
 * Odessyus Orchestrator v4 — Parallel Handoff Pipeline
 *
 * Pipeline:
 *  Phase 0:  Parse query → extract fixture, sport, market, date
 *  Phase 0b: Discover real fixtures for open-ended queries
 *  Phase 1:  PLAN — decide agent roster and execution strategy
 *  Phase 2:  PARALLEL TIER 1 — OddsScout + FormScout run simultaneously
 *  Phase 3:  PARALLEL TIER 2 — InjuryIntel + SentimentAgent run simultaneously
 *            LineupScout always runs after InjuryIntel (uses injury context)
 *  Phase 4:  QuantSynthesis — anchored in deterministic math
 *
 * Accuracy improvements:
 *  - Parallel execution cuts latency and gets fresher data
 *  - LineupScout added as 5th specialist agent
 *  - Minimum data completeness gate before outputting picks
 *  - EV accuracy gate in QuantSynthesis
 */
import { runOddsScout, runOddsScoutMulti } from './subagents/odds-scout.js';
import { runFormScout } from './subagents/form-scout.js';
import { runInjuryIntel } from './subagents/injury-intel.js';
import { runSentimentAgent } from './subagents/sentiment-agent.js';
import { runLineupScout } from './subagents/lineup-scout.js';
import { runQuantSynthesis } from './subagents/quant-synthesis.js';
import { mistralPool } from './mistral-pool.js';
import { logPrediction } from './airtable-logger.js';
// ─── Phase 0b: Discover real fixtures for open-ended queries ──────────────
async function discoverFixtures(userQuery, sport, matchDate, onStep) {
    const { fetchMatchesToday } = await import('./tools.js');
    onStep({ type: 'status', content: '🔍 Fetching today\'s real fixtures from live sources…', timestamp: new Date().toISOString() });
    const result = await fetchMatchesToday(sport, matchDate);
    if (!result.success || !result.data) {
        onStep({ type: 'error', content: '⚠️ Could not fetch live fixture list — agents will search independently.', timestamp: new Date().toISOString() });
        return { fixtures: [], rawSchedule: '' };
    }
    onStep({ type: 'observation', content: `📅 Fixture data retrieved (${result.data.length} chars) — extracting matches…`, timestamp: new Date().toISOString() });
    try {
        const resp = await mistralPool.call(client => client.chat.complete({
            model: 'mistral-small-latest',
            messages: [
                { role: 'system', content: 'Extract football fixture names from raw schedule text. Return JSON only.' },
                {
                    role: 'user',
                    content: `User query: "${userQuery}"
Date: ${matchDate}

Raw schedule:
${result.data.substring(0, 7000)}

Extract 6-10 specific football matches happening on ${matchDate} most relevant to the user's query.
Return ONLY: {"fixtures": ["Team A vs Team B", "Team C vs Team D", ...]}
Use exact team names. Skip matches from wrong dates.`,
                },
            ],
            temperature: 0,
            maxTokens: 500,
        }));
        const raw = resp.choices?.[0]?.message?.content || '';
        const text = typeof raw === 'string' ? raw : '';
        const m = text.match(/\{[\s\S]+\}/);
        if (m) {
            const parsed = JSON.parse(m[0]);
            const fixtures = Array.isArray(parsed.fixtures) ? parsed.fixtures.filter(f => f && f.includes(' ')) : [];
            if (fixtures.length > 0) {
                onStep({
                    type: 'thought',
                    content: `✅ Discovered ${fixtures.length} real fixtures: ${fixtures.slice(0, 5).join(' | ')}${fixtures.length > 5 ? ` +${fixtures.length - 5} more` : ''}`,
                    timestamp: new Date().toISOString(),
                });
                return { fixtures, rawSchedule: result.data };
            }
        }
    }
    catch { /* fall through */ }
    onStep({ type: 'status', content: '⚠️ Fixture extraction inconclusive — using raw schedule as context.', timestamp: new Date().toISOString() });
    return { fixtures: [], rawSchedule: result.data };
}
// ─── Phase 0: Parse query ─────────────────────────────────────────────────
async function parseQuery(userQuery) {
    try {
        const resp = await mistralPool.call(client => client.chat.complete({
            model: 'mistral-small-latest',
            messages: [
                { role: 'system', content: 'Extract match info from the user query. Return JSON only, no prose.' },
                {
                    role: 'user',
                    content: `Extract from: "${userQuery}"
Return exactly: {"fixture":"Team A vs Team B or 'multiple/open'","sport":"football","market":"Match Result","matchDate":"today or YYYY-MM-DD"}`,
                },
            ],
            temperature: 0,
            maxTokens: 200,
        }));
        const raw = resp.choices?.[0]?.message?.content || '';
        const text = typeof raw === 'string' ? raw : '';
        const m = text.match(/\{[\s\S]+\}/);
        if (m) {
            const p = JSON.parse(m[0]);
            return {
                fixture: p.fixture || userQuery,
                sport: p.sport || 'football',
                market: p.market || 'Match Result',
                matchDate: p.matchDate || new Date().toISOString().split('T')[0],
            };
        }
    }
    catch { /* fall through */ }
    return { fixture: userQuery, sport: 'football', market: 'Match Result', matchDate: new Date().toISOString().split('T')[0] };
}
// ─── Phase 1: Plan ────────────────────────────────────────────────────────
async function buildPlan(userQuery, fixture, sport, market) {
    const AGENT_DESCRIPTIONS = `
Available agents (assign to tier 1, 2, or 3 — agents in same tier run in PARALLEL):
- OddsScout (tier 1): Finds opening/current odds, line movement, sharp money (RLM), CLV, arbitrage.
- FormScout (tier 1): Gathers last-5 form, H2H, xG, BTTS%, over/under trends, key player stats.
- InjuryIntel (tier 2): Finds injury reports, suspensions, GTD players, lineup volatility.
- SentimentAgent (tier 2): Gathers team news, manager quotes, weather, referee tendencies, motivational factors.
- LineupScout (tier 3): Confirmed/predicted starting lineups from sofascore, fotmob, BBC. Always runs after InjuryIntel.
`;
    const planPrompt = `You are the Odessyus orchestrator. Decide which agents to dispatch for this betting query.

${AGENT_DESCRIPTIONS}

RULES:
- OddsScout and FormScout ALWAYS run (tier 1, parallel).
- LineupScout ALWAYS runs (tier 3) — confirmed lineups are critical for accuracy.
- InjuryIntel and SentimentAgent run in tier 2 (parallel). Both required for Match Result markets.
- For BTTS/over markets: FormScout is critical (xG), SentimentAgent less critical.
- Set required:true for agents whose failure would make synthesis unreliable.

USER QUERY: "${userQuery}"
FIXTURE: ${fixture}
SPORT: ${sport}
MARKET: ${market}

Return JSON only:
{
  "reasoning": "one sentence",
  "agents": [
    {"name": "AgentName", "focus": "specific task", "required": true|false, "tier": 1|2|3}
  ]
}`;
    try {
        const resp = await mistralPool.call(client => client.chat.complete({
            model: 'mistral-small-latest',
            messages: [
                { role: 'system', content: planPrompt },
                { role: 'user', content: 'Build the agent plan now.' },
            ],
            temperature: 0,
            maxTokens: 600,
        }));
        const raw = resp.choices?.[0]?.message?.content || '';
        const text = typeof raw === 'string' ? raw : '';
        const m = text.match(/\{[\s\S]+\}/);
        if (m) {
            const plan = JSON.parse(m[0]);
            if (Array.isArray(plan.agents) && plan.agents.length > 0)
                return plan;
        }
    }
    catch (e) {
        console.warn('[Orchestrator] Plan build failed, using default:', e);
    }
    // Default: all 5 agents, parallelised
    return {
        reasoning: 'Default: full 5-agent pipeline — OddsScout+FormScout parallel, InjuryIntel+SentimentAgent parallel, then LineupScout.',
        agents: [
            { name: 'OddsScout', focus: `Find current odds, sharp money, and line movement for: ${fixture}`, required: true, tier: 1 },
            { name: 'FormScout', focus: `Gather form, H2H, xG, and statistical data for: ${fixture}`, required: true, tier: 1 },
            { name: 'InjuryIntel', focus: `Find injury reports, suspensions, GTD players for: ${fixture}`, required: true, tier: 2 },
            { name: 'SentimentAgent', focus: `Gather team news, weather, motivation, referee data for: ${fixture}`, required: false, tier: 2 },
            { name: 'LineupScout', focus: `Find confirmed or predicted starting lineups for: ${fixture}`, required: true, tier: 3 },
        ],
    };
}
// ─── Dispatch a named agent ────────────────────────────────────────────────
async function dispatchAgent(task, fixture, sport, matchDate, sessionId, priorContext, onStep, discoveredFixtures) {
    const focusedTask = task.focus + (priorContext ? `\n\n${priorContext}` : '');
    switch (task.name) {
        case 'OddsScout':
            // Use multi-fixture variant when we have a real fixtures list from discovery
            if (discoveredFixtures && discoveredFixtures.length > 1) {
                return runOddsScoutMulti(discoveredFixtures, sport, matchDate, sessionId, onStep);
            }
            return runOddsScout(fixture, sport, sessionId, onStep, focusedTask);
        case 'FormScout': return runFormScout(fixture, sport, sessionId, onStep, focusedTask);
        case 'InjuryIntel': return runInjuryIntel(fixture, sport, sessionId, onStep, focusedTask);
        case 'SentimentAgent': return runSentimentAgent(fixture, sport, matchDate, sessionId, onStep, focusedTask);
        case 'LineupScout': return runLineupScout(fixture, sport, sessionId, onStep, focusedTask);
    }
}
// ─── Build prior-context summary ─────────────────────────────────────────────
function buildPriorContext(accumulated) {
    const entries = Object.entries(accumulated);
    if (entries.length === 0)
        return '';
    const lines = ['=== PRIOR CONTEXT FROM COMPLETED AGENTS ==='];
    for (const [name, result] of entries) {
        if (result.success) {
            const summary = result.rawOutput
                ? result.rawOutput.substring(0, 1000) + (result.rawOutput.length > 1000 ? '…' : '')
                : JSON.stringify(result.data).substring(0, 800);
            lines.push(`\n[${name} — SUCCESS]\n${summary}`);
        }
        else {
            lines.push(`\n[${name} — FAILED: ${result.error || 'unknown'}]`);
        }
    }
    lines.push('\nBuild on the above findings. Do not re-gather data already collected.');
    return lines.join('\n');
}
// ─── Main orchestrator ────────────────────────────────────────────────────
export async function runOrchestrator(userQuery, sessionId, onStep) {
    const allSteps = [];
    const now = () => new Date().toISOString();
    const ts = () => ({ timestamp: now() });
    const emit = (step) => {
        const s = { ...step, ...ts() };
        allSteps.push(s);
        onStep(s);
    };
    const collectSteps = (step) => {
        allSteps.push({ ...step, timestamp: step.timestamp || now() });
        onStep(step);
    };
    // ── Phase 0: Parse ────────────────────────────────────────────────────
    const poolStatus = mistralPool.status();
    emit({ type: 'status', content: `🧠 Odessyus v4 initializing — ${poolStatus.total} key(s) in pool (${poolStatus.available} available)…` });
    const parsed = await parseQuery(userQuery);
    let { fixture, sport, market, matchDate } = parsed;
    emit({ type: 'thought', content: `Fixture: "${fixture}" | Sport: ${sport} | Market: ${market} | Date: ${matchDate}` });
    // ── Phase 0b: Discover real fixtures for open-ended queries ───────────
    let discoveredSchedule = '';
    let discoveredFixtures = [];
    if (!fixture || fixture === 'multiple/open' || fixture === userQuery) {
        const discovery = await discoverFixtures(userQuery, sport, matchDate, emit);
        discoveredFixtures = discovery.fixtures;
        discoveredSchedule = discovery.rawSchedule;
        if (discoveredFixtures.length > 0) {
            fixture = discoveredFixtures.join(' | ');
            emit({ type: 'thought', content: `🗓️ Using ${discoveredFixtures.length} real fixtures as context for all agents.` });
        }
        else if (discoveredSchedule) {
            fixture = 'multiple — see schedule context below';
        }
    }
    const scheduleContext = discoveredSchedule
        ? `\n\n=== TODAY'S REAL FIXTURE SCHEDULE (${matchDate}) ===\n${discoveredSchedule.substring(0, 4000)}\n=== END SCHEDULE ===\n\nIMPORTANT: Only analyse matches from the above schedule. Do NOT invent fixtures.`
        : '';
    // ── Phase 1: Plan ─────────────────────────────────────────────────────
    emit({ type: 'status', content: '🗺️ Building task-specific agent plan…' });
    const plan = await buildPlan(userQuery, fixture, sport, market);
    emit({
        type: 'thought',
        content: `📋 Plan (${plan.agents.length} agents): ${plan.agents.map(a => `${a.name}(T${a.tier})`).join(' | ')} | ${plan.reasoning}`,
    });
    // ── Phase 2+3: Tiered parallel execution ─────────────────────────────
    const accumulated = {};
    const agentsRun = [];
    // Group agents by tier
    const byTier = {};
    for (const agent of plan.agents) {
        if (!byTier[agent.tier])
            byTier[agent.tier] = [];
        byTier[agent.tier].push(agent);
    }
    const tiers = Object.keys(byTier).map(Number).sort();
    for (const tier of tiers) {
        const tierAgents = byTier[tier];
        emit({ type: 'status', content: `🚀 Tier ${tier}: Running ${tierAgents.map(a => a.name).join(' + ')} in parallel…` });
        // Build prior context from completed tiers
        const priorContext = buildPriorContext(accumulated);
        const fullContext = scheduleContext + (priorContext ? `\n\n${priorContext}` : '');
        // Run all agents in this tier simultaneously
        // Pass discoveredFixtures so OddsScout can use the multi-fixture variant when available
        const tierResults = await Promise.allSettled(tierAgents.map(task => dispatchAgent(task, fixture, sport, matchDate, `${sessionId}-${task.name}`, fullContext, collectSteps, discoveredFixtures.length > 1 ? discoveredFixtures : undefined)));
        for (let i = 0; i < tierAgents.length; i++) {
            const task = tierAgents[i];
            const result = tierResults[i];
            if (result.status === 'fulfilled') {
                accumulated[task.name] = result.value;
                agentsRun.push(task.name);
                if (result.value.success) {
                    emit({ type: 'thought', content: `✅ ${task.name} (Tier ${tier}): completed successfully.` });
                }
                else {
                    emit({ type: 'error', content: `⚠️ ${task.name}: ${result.value.error}` });
                }
            }
            else {
                // Promise rejection
                const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
                emit({ type: 'error', content: `💥 ${task.name} crashed: ${errMsg}` });
                accumulated[task.name] = {
                    agentName: task.name,
                    success: false,
                    data: {},
                    steps: [],
                    rawOutput: '',
                    error: errMsg,
                };
                agentsRun.push(task.name);
            }
        }
    }
    const successCount = Object.values(accumulated).filter(r => r.success).length;
    emit({
        type: 'status',
        content: `✅ All tiers complete — ${successCount}/${agentsRun.length} agents succeeded. Starting QuantSynthesis…`,
    });
    // ── Phase 4: QuantSynthesis ───────────────────────────────────────────
    const oddsResult = accumulated['OddsScout'] || { agentName: 'OddsScout', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
    const formResult = accumulated['FormScout'] || { agentName: 'FormScout', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
    const injuryResult = accumulated['InjuryIntel'] || { agentName: 'InjuryIntel', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
    const sentimentResult = accumulated['SentimentAgent'] || { agentName: 'SentimentAgent', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
    const lineupResult = accumulated['LineupScout'] || { agentName: 'LineupScout', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
    // Wrap in try/catch — a thrown error here must never kill the entire pipeline
    // without returning something to the client.
    let quantResult;
    try {
        quantResult = await runQuantSynthesis({
            userQuery, fixture, sport, market, sessionId,
            oddsResult, formResult, injuryResult, sentimentResult, lineupResult,
            onStep: collectSteps,
            isMultiFixture: discoveredFixtures.length > 1,
            discoveredFixtures: discoveredFixtures.length > 1 ? discoveredFixtures : undefined,
        });
    }
    catch (synthErr) {
        const synthMsg = synthErr instanceof Error ? synthErr.message : String(synthErr);
        emit({ type: 'error', content: `QuantSynthesis threw unexpectedly: ${synthMsg}` });
        // Build a best-effort plain-text answer from raw subagent outputs so the
        // user still gets something rather than a blank response.
        const fallbackParts = Object.entries(accumulated)
            .filter(([, r]) => r.success && r.rawOutput)
            .map(([name, r]) => `### ${name}\n${r.rawOutput.substring(0, 600)}`);
        const fallbackAnswer = fallbackParts.length
            ? `⚠️ Synthesis engine encountered an error (${synthMsg}). Partial scout data:\n\n${fallbackParts.join('\n\n')}`
            : `⚠️ Synthesis failed: ${synthMsg}. No scout data available.`;
        return {
            finalAnswer: fallbackAnswer,
            steps: allSteps,
            success: false,
            error: synthMsg,
            metadata: {
                fixture, sport, market,
                predictionId: `${sessionId}-err-${Date.now()}`,
                probability: 0, confidence: 0, starRating: 0, expectedValue: 0,
                recommendedOdds: 0, goalStatement: '',
                monteCarlo: { home: 0, draw: 0, away: 0, stdDev: 0 },
                dataCompletenessScore: 0, impliedProb: 0, trueProb: 0,
                isValueBet: false, recommendedStake: 'SKIP',
                categoryProbabilities: { market: 0, form: 0, injury: 0, sentiment: 0 },
                agentPlan: plan.agents, agentsRun,
                subagentResults: Object.fromEntries(Object.entries(accumulated).map(([k, v]) => [k, v.success])),
                poolStatus: mistralPool.status(),
            },
        };
    }
    if (!quantResult.success) {
        emit({ type: 'error', content: `Synthesis failed: ${quantResult.error}` });
        // Still return partial scout data rather than an empty string
        const fallbackParts = Object.entries(accumulated)
            .filter(([, r]) => r.success && r.rawOutput)
            .map(([name, r]) => `### ${name}\n${r.rawOutput.substring(0, 600)}`);
        const fallbackAnswer = fallbackParts.length
            ? `⚠️ Prediction synthesis did not complete (${quantResult.error}). Partial scout data:\n\n${fallbackParts.join('\n\n')}`
            : `⚠️ Synthesis failed: ${quantResult.error}`;
        return {
            finalAnswer: fallbackAnswer,
            steps: allSteps,
            success: false,
            error: quantResult.error,
            metadata: {
                fixture, sport, market,
                predictionId: `${sessionId}-err-${Date.now()}`,
                probability: 0, confidence: 0, starRating: 0, expectedValue: 0,
                recommendedOdds: 0, goalStatement: '',
                monteCarlo: { home: 0, draw: 0, away: 0, stdDev: 0 },
                dataCompletenessScore: 0, impliedProb: 0, trueProb: 0,
                isValueBet: false, recommendedStake: 'SKIP',
                categoryProbabilities: { market: 0, form: 0, injury: 0, sentiment: 0 },
                agentPlan: plan.agents, agentsRun,
                subagentResults: Object.fromEntries(Object.entries(accumulated).map(([k, v]) => [k, v.success])),
                poolStatus: mistralPool.status(),
            },
        };
    }
    emit({
        type: 'synthesis',
        content: `🏆 Complete | ⭐${quantResult.starRating}/5 | EV: ${quantResult.expectedValue >= 0 ? '+' : ''}${(quantResult.expectedValue * 100).toFixed(2)}% | Gate: ${quantResult.isValueBet ? '✅ VALUE BET' : '⚠️ MONITOR'}`,
    });
    const predictionId = `${sessionId}-${Date.now()}`;
    logPrediction({
        predictionId,
        fixture,
        sport,
        market,
        predictedProb: quantResult.trueProb,
        impliedProb: quantResult.impliedProb,
        evPct: quantResult.expectedValue,
        starRating: quantResult.starRating,
        recommendedOdds: quantResult.recommendedOdds,
        dataCompleteness: quantResult.dataCompletenessScore,
        isValueBet: quantResult.isValueBet,
        recommendedStake: quantResult.recommendedStake,
        categoryProbabilities: quantResult.categoryProbabilities,
        monteCarlo: quantResult.monteCarlo,
        isCombo: false,
        goalStatement: quantResult.goalStatement,
    }).catch(err => console.error('[Orchestrator] Airtable log error:', err instanceof Error ? err.message : String(err)));
    return {
        finalAnswer: quantResult.finalAnswer,
        steps: allSteps,
        success: true,
        metadata: {
            fixture,
            sport,
            market,
            predictionId,
            probability: quantResult.trueProb * 100,
            confidence: quantResult.confidence,
            starRating: quantResult.starRating,
            expectedValue: quantResult.expectedValue,
            recommendedOdds: quantResult.recommendedOdds,
            goalStatement: quantResult.goalStatement,
            monteCarlo: quantResult.monteCarlo,
            dataCompletenessScore: quantResult.dataCompletenessScore,
            impliedProb: quantResult.impliedProb,
            trueProb: quantResult.trueProb,
            isValueBet: quantResult.isValueBet,
            recommendedStake: quantResult.recommendedStake,
            categoryProbabilities: quantResult.categoryProbabilities,
            agentPlan: plan.agents,
            agentsRun,
            subagentResults: Object.fromEntries(Object.entries(accumulated).map(([k, v]) => [k, v.success])),
            poolStatus: mistralPool.status(),
        },
    };
}
//# sourceMappingURL=orchestrator.js.map