import type { ReActStep } from './react-engine.js';
import { runOddsScout } from './subagents/odds-scout.js';
import { runFormScout } from './subagents/form-scout.js';
import { runInjuryIntel } from './subagents/injury-intel.js';
import { runSentimentAgent } from './subagents/sentiment-agent.js';
import { runLineupScout } from './subagents/lineup-scout.js';
import { runRefereeScout } from './subagents/referee-scout.js';
import { runTacticalScout } from './subagents/tactical-scout.js';
import { runDataQualityScout } from './subagents/data-quality-scout.js';
import { runQuantSynthesis } from './subagents/quant-synthesis.js';
import { mistralPool } from './mistral-pool.js';
import type { SubAgentResult } from './subagents/base.js';
import { logPrediction } from './airtable-logger.js';
import { broadFixtureDiscovery } from './broad-fixture-sources.js';
import { fixtureScheduler } from './fixture-task-scheduler.js';

type AgentName = 'OddsScout' | 'FormScout' | 'InjuryIntel' | 'SentimentAgent' | 'LineupScout' | 'RefereeScout' | 'TacticalScout' | 'DataQualityScout';
interface AgentTask { name: AgentName; focus: string; required: boolean; tier: 1 | 2 | 3 | 4; }
interface AgentPlan { reasoning: string; agents: AgentTask[]; }
export interface OrchestratorResult { finalAnswer: string; steps: ReActStep[]; success: boolean; error?: string; metadata: any; }
interface DiscoveredFixture { fixture: string; kickoff?: string; status?: string; competition?: string; }

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';
const MAX_DISCOVERY_FIXTURES = Number(process.env.MAX_DISCOVERY_FIXTURES || 30);

function marketToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function isTodayOrFuture(kickoff: string | undefined, requestedDate: string): boolean {
  if (!kickoff) return false;
  const d = new Date(kickoff);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now() - 120_000 && d.toLocaleDateString('en-CA', { timeZone: MARKET_TIMEZONE }) === requestedDate;
}

function isCompletedStatus(status: string | undefined): boolean {
  const s = String(status || '').toLowerCase().trim();
  return !!s && /finished|final|ended|ft|aet|after penalties|cancelled|canceled|postponed|abandoned|walkover|live|in.?play|half.?time/.test(s);
}

function balancedJsonCandidates(raw: string): string[] {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates: string[] = [];
  for (const startChar of ['{', '[']) {
    let start = -1, depth = 0, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (start < 0) { if (ch === startChar) { start = i; depth = 1; } continue; }
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === startChar) depth++;
      else if ((startChar === '{' && ch === '}') || (startChar === '[' && ch === ']')) depth--;
      if (depth === 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return candidates.sort((a, b) => b.length - a.length);
}

function parseFixturePayload(raw: string): DiscoveredFixture[] {
  for (const candidate of balancedJsonCandidates(raw)) {
    try {
      const value = JSON.parse(candidate) as any;
      const list = Array.isArray(value) ? value : Array.isArray(value?.fixtures) ? value.fixtures : [];
      if (list.length) return list as DiscoveredFixture[];
    } catch {}
  }
  return [];
}

function normalizeFixtureName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*(?:vs\.?|v\.?|[-–—])\s*/g, ' vs ').trim();
}

function validateFixtures(values: DiscoveredFixture[], requestedDate: string): string[] {
  const seen = new Set<string>(), result: string[] = [];
  for (const value of values) {
    if (!value || typeof value.fixture !== 'string') continue;
    if (isCompletedStatus(value.status)) continue;
    if (!isTodayOrFuture(value.kickoff, requestedDate)) continue;
    const fixture = value.fixture.trim();
    if (fixture.length < 6) continue;
    const key = normalizeFixtureName(fixture);
    if (seen.has(key)) continue;
    seen.add(key); result.push(fixture);
    if (result.length >= MAX_DISCOVERY_FIXTURES) break;
  }
  return result;
}

function extractStructuredFallback(schedule: string): DiscoveredFixture[] {
  const results: DiscoveredFixture[] = [];
  for (const candidate of balancedJsonCandidates(schedule)) {
    try {
      const value = JSON.parse(candidate) as any;
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const item of node) walk(item); return; }
        const home = node.homeTeam?.name || node.home_team?.name || node.home?.name || node.homeTeam || node.home_team || node.home;
        const away = node.awayTeam?.name || node.away_team?.name || node.away?.name || node.awayTeam || node.away_team || node.away;
        const kickoff = node.kickoff || node.startTime || node.start_time || node.date || node.utcDate || node.utc_date;
        const status = node.status?.type?.short || node.status?.short || node.status || node.fixture?.status?.short;
        if (typeof home === 'string' && typeof away === 'string' && typeof kickoff === 'string') {
          results.push({ fixture: `${home} vs ${away}`, kickoff, status: typeof status === 'string' ? status : 'scheduled', competition: node.competition?.name || node.league?.name });
        }
        for (const child of Object.values(node)) walk(child);
      };
      walk(value);
    } catch {}
  }
  return results;
}

async function repairFixturePayload(raw: string, matchDate: string): Promise<DiscoveredFixture[]> {
  try {
    const x = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Repair fixture extraction. Return ONLY valid JSON in the exact shape {"fixtures":[{"fixture":"Home vs Away","kickoff":"ISO-8601","status":"scheduled","competition":"..."}]}. Copy only fixtures explicitly present. Never invent or change kickoff times.' },
      { role: 'user', content: `Requested date: ${matchDate}\nMalformed discovery response:\n${raw.substring(0, 12000)}` }
    ] as any, temperature: 0, maxTokens: 2500 }));
    return parseFixturePayload(String(x.choices?.[0]?.message?.content || ''));
  } catch { return []; }
}

async function discoverFixtures(userQuery: string, sport: string, matchDate: string, onStep: (s: ReActStep) => void) {
  onStep({ type: 'status', content: `🔍 WIDE fixture discovery: scanning ${sport} across the full ${matchDate} schedule in ${MARKET_TIMEZONE}…`, timestamp: new Date().toISOString() });
  const broad = await broadFixtureDiscovery(matchDate, sport);
  const { fetchMatchesToday, allSportsFixtures } = await import('./tools.js');
  const [webResult, apiResult] = await Promise.allSettled([
    fetchMatchesToday(sport, matchDate),
    sport.toLowerCase() === 'football' ? allSportsFixtures(matchDate, matchDate) : Promise.resolve({ success: false, data: '', error: 'structured fixture API is football-only' }),
  ]);
  const web = webResult.status === 'fulfilled' ? webResult.value : { success: false, data: '', error: String(webResult.reason) };
  const api = apiResult.status === 'fulfilled' ? apiResult.value : { success: false, data: '', error: String(apiResult.reason) };
  const sources: string[] = [];
  if (broad.success && broad.data) sources.push(`=== SCRAPER-INDEPENDENT BROAD DISCOVERY ===\n${broad.data}`);
  if (web.success && web.data) sources.push(`=== MULTI-SOURCE WEB/SCRAPER SCHEDULE ===\n${web.data}`);
  if (api.success && api.data) sources.push(`=== STRUCTURED ALLSPORTS FULL-DATE FIXTURE FEED ===\n${api.data}`);
  const combinedSchedule = sources.join('\n\n');
  if (!combinedSchedule) return { fixtures: [], rawSchedule: '' };
  onStep({ type: 'thought', content: `📚 Broad discovery collected ${sources.length} independent schedule feeds. Building up to ${MAX_DISCOVERY_FIXTURES} verified future fixture jobs with specialist backpressure.`, timestamp: new Date().toISOString() });

  let llmFixtures: DiscoveredFixture[] = [];
  try {
    const x = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'You are a strict football fixture discovery and temporal-validation engine. Extract ALL REAL future fixtures present in supplied schedules. Do not limit to famous leagues or the first few results. Never invent fixture, kickoff, league or status. Return JSON only.' },
      { role: 'user', content: `User query: ${userQuery}\nRequested market-local date: ${matchDate}\nMarket timezone: ${MARKET_TIMEZONE}\nCurrent UTC time: ${new Date().toISOString()}\nSchedules:\n${combinedSchedule.substring(0, 50000)}\nReturn up to ${MAX_DISCOVERY_FIXTURES} distinct future fixtures across the full supplied slate. Kickoff must be after now and local date ${matchDate}. Omit started/live/finished/postponed/cancelled matches and any fixture whose kickoff cannot be verified.` }
    ] as any, temperature: 0, maxTokens: Math.min(5000, 150 + MAX_DISCOVERY_FIXTURES * 140) }));
    const raw = String(x.choices?.[0]?.message?.content || '');
    llmFixtures = parseFixturePayload(raw);
    if (!llmFixtures.length) {
      onStep({ type: 'thought', content: '🛠️ Discovery model malformed; activating structured repair and deterministic source-data fallback.', timestamp: new Date().toISOString() });
      llmFixtures = await repairFixturePayload(raw, matchDate);
    }
  } catch (e) {
    onStep({ type: 'error', content: `⚠️ Discovery model failed; using deterministic source fallback. ${e instanceof Error ? e.message : String(e)}`, timestamp: new Date().toISOString() });
  }
  let fixtures = validateFixtures(llmFixtures, matchDate);
  if (!fixtures.length) fixtures = validateFixtures(extractStructuredFallback(combinedSchedule), matchDate);
  if (fixtures.length) {
    onStep({ type: 'thought', content: `📊 Discovered ${fixtures.length} verified future fixtures. Each will move through specialist queues instead of spawning duplicate work.`, timestamp: new Date().toISOString() });
    return { fixtures, rawSchedule: combinedSchedule };
  }
  onStep({ type: 'error', content: `⚠️ No fixtures passed the future-match gate for ${matchDate}.`, timestamp: new Date().toISOString() });
  return { fixtures: [], rawSchedule: combinedSchedule };
}

async function parseQuery(userQuery: string) {
  try {
    const r = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Extract match info. Return JSON only.' },
      { role: 'user', content: `Extract from "${userQuery}". Return {"fixture":"Team A vs Team B or multiple/open","sport":"football","market":"Match Result","matchDate":"today or YYYY-MM-DD"}.` }
    ] as any, temperature: 0, maxTokens: 200 }));
    for (const candidate of balancedJsonCandidates(String(r.choices?.[0]?.message?.content || ''))) {
      try { const p = JSON.parse(candidate) as any; return { fixture: p.fixture || userQuery, sport: p.sport || 'football', market: p.market || 'Match Result', matchDate: p.matchDate === 'today' ? marketToday() : (p.matchDate || marketToday()) }; } catch {}
    }
  } catch {}
  return { fixture: userQuery, sport: 'football', market: 'Match Result', matchDate: marketToday() };
}

async function buildPlan(fixture: string): Promise<AgentPlan> {
  return { reasoning: 'Fixture-scoped dependency tiers with per-specialist FIFO queues.', agents: [
    { name: 'OddsScout', focus: `Find verified exact-market odds, line movement and price integrity for ${fixture}.`, required: true, tier: 1 },
    { name: 'FormScout', focus: `Find current-season form, H2H, xG and performance data for ${fixture}.`, required: true, tier: 1 },
    { name: 'InjuryIntel', focus: `Find current injuries, suspensions and availability for ${fixture}.`, required: true, tier: 2 },
    { name: 'SentimentAgent', focus: `Find current team news, weather, motivation and external context for ${fixture}.`, required: false, tier: 2 },
    { name: 'RefereeScout', focus: `Verify assigned referee and referee-specific statistics for ${fixture}; return null if unverified.`, required: false, tier: 2 },
    { name: 'LineupScout', focus: `Find confirmed/predicted lineups and late team news for ${fixture}.`, required: true, tier: 3 },
    { name: 'TacticalScout', focus: `Assess exact fixture tactical matchup, formations, pressing, transitions and set pieces for ${fixture}.`, required: false, tier: 3 },
    { name: 'DataQualityScout', focus: `Adversarially audit all prior evidence for ${fixture}: freshness, contradictions, provenance and critical gaps.`, required: true, tier: 4 },
  ] };
}

async function dispatchOne(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void): Promise<SubAgentResult> {
  const taskText = `${task.focus}\n\n${prior}`;
  switch (task.name) {
    case 'OddsScout': return runOddsScout(fixture, sport, sessionId, onStep, taskText);
    case 'FormScout': return runFormScout(fixture, sport, sessionId, onStep, taskText);
    case 'InjuryIntel': return runInjuryIntel(fixture, sport, sessionId, onStep, taskText);
    case 'SentimentAgent': return runSentimentAgent(fixture, sport, matchDate, sessionId, onStep, taskText);
    case 'LineupScout': return runLineupScout(fixture, sport, sessionId, onStep, taskText);
    case 'RefereeScout': return runRefereeScout(fixture, sport, sessionId, onStep, taskText);
    case 'TacticalScout': return runTacticalScout(fixture, sport, sessionId, onStep, taskText);
    case 'DataQualityScout': return runDataQualityScout(fixture, sport, sessionId, onStep, taskText);
  }
}

async function dispatchAgent(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void, fixtures: string[]): Promise<SubAgentResult> {
  const list = fixtures.length > 0 ? fixtures : [fixture];
  const jobs = list.map((fx, i) => fixtureScheduler.enqueue({
    agentName: task.name,
    fixture: fx,
    tier: task.tier,
    run: () => dispatchOne(task, fx, sport, matchDate, `${sessionId}-${task.name}-${i}`, prior, s => onStep({ ...s, content: `[${fx}] ${s.content}` })),
  }, position => onStep({ type: 'status', content: `⏳ ${task.name} queue: ${fx} waiting behind ${position} fixture job(s).`, timestamp: new Date().toISOString() })));

  const settled = await Promise.allSettled(jobs);
  const good = settled.filter((r): r is PromiseFulfilledResult<SubAgentResult> => r.status === 'fulfilled');
  const raw = settled.map((r, i) => r.status === 'fulfilled' ? `=== ${list[i]} ===\n${r.value.rawOutput || JSON.stringify(r.value.data)}` : `=== ${list[i]} ===\nFAILED: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`).join('\n\n');
  const data: Record<string, unknown> = { fixtures: Object.fromEntries(settled.map((r, i) => [list[i], r.status === 'fulfilled' ? r.value.data : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }])) };
  return { agentName: task.name, success: good.length > 0, partial: good.length < settled.length, data, steps: good.flatMap(r => r.value.steps), rawOutput: raw, error: good.length ? '' : `All ${settled.length} fixture jobs failed`, toolErrors: good.flatMap(r => r.value.toolErrors || []) };
}

function priorContext(acc: Record<string, SubAgentResult>): string {
  const entries = Object.entries(acc);
  return entries.length ? `=== PRIOR SPECIALIST RESULTS ===\n${entries.map(([n, r]) => `[${n}] ${(r.rawOutput || JSON.stringify(r.data)).substring(0, 1800)}`).join('\n\n')}\n=== END PRIOR SPECIALIST RESULTS ===` : '';
}

export async function runOrchestrator(userQuery: string, sessionId: string, onStep: (step: ReActStep) => void): Promise<OrchestratorResult> {
  const steps: ReActStep[] = [];
  const emit = (s: ReActStep) => { const x = { ...s, timestamp: new Date().toISOString() }; steps.push(x); onStep(x); };
  const pool = mistralPool.status();
  emit({ type: 'status', content: `🧠 Odessyus initializing — ${pool.total} model key(s), ${pool.available} available.` });
  const parsed = await parseQuery(userQuery);
  let { fixture, sport, market, matchDate } = parsed;
  let fixtures: string[] = [];
  let schedule = '';

  if (!fixture || fixture === 'multiple/open' || fixture === userQuery) {
    const d = await discoverFixtures(userQuery, sport, matchDate, emit);
    fixtures = d.fixtures; schedule = d.rawSchedule;
    if (fixtures.length) fixture = fixtures.join(' | ');
  }

  if (!fixtures.length && (fixture === 'multiple/open' || fixture === userQuery)) {
    return { finalAnswer: `NO QUALIFIED FIXTURES: I could not verify any future, not-yet-started fixtures for ${matchDate}. I will not analyse stale or already-played matches.`, steps, success: true, metadata: { fixture, sport, market, matchDate, agentsRun: [] } };
  }

  const scheduleContext = schedule ? `=== VERIFIED SCHEDULE — ${matchDate} ===\n${schedule.substring(0, 5000)}\n=== END SCHEDULE ===` : '';
  const plan = await buildPlan(fixture);
  const acc: Record<string, SubAgentResult> = {};
  const agentsRun: string[] = [];
  const byTier: Record<number, AgentTask[]> = {};
  for (const a of plan.agents) (byTier[a.tier] ??= []).push(a);

  for (const tier of Object.keys(byTier).map(Number).sort()) {
    const tasks = byTier[tier];
    emit({ type: 'status', content: `🚦 Tier ${tier}: ${tasks.map(t => t.name).join(' + ')} | ${fixtures.length || 1} fixture jobs | per-agent queues active.`, });
    const prior = `${scheduleContext}\n${priorContext(acc)}`.trim();
    const rs = await Promise.allSettled(tasks.map(t => dispatchAgent(t, fixture, sport, matchDate, sessionId, prior, emit, fixtures)));
    for (let i = 0; i < tasks.length; i++) {
      const r = rs[i], t = tasks[i];
      if (r.status === 'fulfilled') {
        acc[t.name] = r.value; if (r.value.success) agentsRun.push(t.name);
        emit({ type: r.value.success ? 'thought' : 'error', content: `${r.value.success ? '✅' : '⚠️'} ${t.name}: ${fixtures.length > 1 ? `processed ${fixtures.length} fixture jobs with FIFO specialist backpressure` : 'completed'}.` });
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        acc[t.name] = { agentName: t.name, success: false, data: {}, steps: [], rawOutput: '', error: msg };
        emit({ type: 'error', content: `💥 ${t.name}: ${msg}` });
      }
    }

    const requiredFailed = tasks.filter(t => t.required).some(t => !acc[t.name]?.success);
    if (requiredFailed) emit({ type: 'error', content: `⛔ Tier ${tier}: required specialist failed for part of the slate. Failed fields remain unavailable.` });
  }

  const empty = (name: AgentName): SubAgentResult => acc[name] || { agentName: name, success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
  const evidenceAudit = empty('DataQualityScout');
  try {
    const enrichedSentiment: SubAgentResult = {
      ...empty('SentimentAgent'),
      rawOutput: [empty('SentimentAgent').rawOutput, '=== REFEREE CONTEXT ===', empty('RefereeScout').rawOutput, '=== TACTICAL CONTEXT ===', empty('TacticalScout').rawOutput, '=== DATA QUALITY AUDIT ===', evidenceAudit.rawOutput].filter(Boolean).join('\n'),
    };
    const q = await runQuantSynthesis({ userQuery, fixture, sport, market, sessionId, oddsResult: empty('OddsScout'), formResult: empty('FormScout'), injuryResult: empty('InjuryIntel'), sentimentResult: enrichedSentiment, lineupResult: empty('LineupScout'), onStep: emit, isMultiFixture: fixtures.length > 1, discoveredFixtures: fixtures });
    if (!q.success) return { finalAnswer: q.finalAnswer || `⚠️ Synthesis failed: ${q.error || 'unknown error'}`, steps, success: false, error: q.error, metadata: { fixture, sport, market, agentsRun } };
    const predictionId = `${sessionId}-${Date.now()}`;
    logPrediction({ predictionId, fixture, sport, market, predictedProb: q.trueProb, impliedProb: q.impliedProb, expectedValue: q.expectedValue, isValueBet: q.isValueBet, starRating: q.starRating });
    emit({ type: 'synthesis', content: `🏆 ${fixtures.length > 1 ? `Multi-match synthesis complete for ${fixtures.length} games` : 'Synthesis complete'} | Gate: ${q.isValueBet ? '✅ VALUE BET' : '⚠️ MONITOR'} | Specialist queues drained.` });
    return { finalAnswer: q.finalAnswer, steps, success: true, metadata: { fixture, sport, market, predictionId, probability: q.trueProb * 100, confidence: q.confidence, starRating: q.starRating, expectedValue: q.expectedValue, recommendedOdds: q.recommendedOdds, goalStatement: q.goalStatement, monteCarlo: q.monteCarlo, dataCompletenessScore: q.dataCompletenessScore, impliedProb: q.impliedProb, trueProb: q.trueProb, isValueBet: q.isValueBet, recommendedStake: q.recommendedStake, categoryProbabilities: q.categoryProbabilities, agentPlan: plan.agents, agentsRun, queueSnapshot: fixtureScheduler.snapshot(), subagentResults: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.success])), poolStatus: mistralPool.status() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { finalAnswer: `⚠️ Synthesis failed: ${msg}`, steps, success: false, error: msg, metadata: { fixture, sport, market, agentsRun, queueSnapshot: fixtureScheduler.snapshot() } };
  }
}
