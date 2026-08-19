import type { ReActStep } from './react-engine.js';
import { runOddsScout } from './subagents/odds-scout.js';
import { runFormScout } from './subagents/form-scout.js';
import { runInjuryIntel } from './subagents/injury-intel.js';
import { runSentimentAgent } from './subagents/sentiment-agent.js';
import { runLineupScout } from './subagents/lineup-scout.js';
import { runQuantSynthesis } from './subagents/quant-synthesis.js';
import { mistralPool } from './mistral-pool.js';
import type { SubAgentResult } from './subagents/base.js';
import { logPrediction } from './airtable-logger.js';

type AgentName = 'OddsScout' | 'FormScout' | 'InjuryIntel' | 'SentimentAgent' | 'LineupScout';
interface AgentTask { name: AgentName; focus: string; required: boolean; tier: 1 | 2 | 3; }
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
  const starts = ['{', '['];
  for (const startChar of starts) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (start < 0) {
        if (ch === startChar) { start = i; depth = 1; }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === startChar) depth++;
      else if ((startChar === '{' && ch === '}') || (startChar === '[' && ch === ']')) depth--;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
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
    } catch { /* try the next balanced candidate */ }
  }
  return [];
}

function normalizeFixtureName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*(?:vs\.?|v\.?|[-–—])\s*/g, ' vs ').trim();
}

function validateFixtures(values: DiscoveredFixture[], requestedDate: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || typeof value.fixture !== 'string') continue;
    if (isCompletedStatus(value.status)) continue;
    if (!isTodayOrFuture(value.kickoff, requestedDate)) continue;
    const fixture = value.fixture.trim();
    if (fixture.length < 6) continue;
    const key = normalizeFixtureName(fixture);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(fixture);
    if (result.length >= MAX_DISCOVERY_FIXTURES) break;
  }
  return result;
}

function extractStructuredFallback(schedule: string, requestedDate: string): DiscoveredFixture[] {
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
    } catch { /* non-JSON source text */ }
  }
  return results;
}

async function repairFixturePayload(raw: string, matchDate: string): Promise<DiscoveredFixture[]> {
  try {
    const x = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Repair fixture extraction. Return ONLY one valid JSON object, with no markdown or commentary, in the exact shape {"fixtures":[{"fixture":"Home vs Away","kickoff":"ISO-8601","status":"scheduled","competition":"..."}]}. Copy only fixtures explicitly present in the supplied response. Never invent or change kickoff times.' },
      { role: 'user', content: `Requested date: ${matchDate}\nMalformed discovery response:\n${raw.substring(0, 12000)}` }
    ] as any, temperature: 0, maxTokens: 2500 }));
    return parseFixturePayload(String(x.choices?.[0]?.message?.content || ''));
  } catch { return []; }
}

async function discoverFixtures(userQuery: string, sport: string, matchDate: string, onStep: (s: ReActStep) => void) {
  const { fetchMatchesToday, allSportsFixtures } = await import('./tools.js');
  onStep({ type: 'status', content: `🔍 WIDE fixture discovery: scanning ${sport} across the full ${matchDate} schedule in ${MARKET_TIMEZONE}…`, timestamp: new Date().toISOString() });
  const [webResult, apiResult] = await Promise.allSettled([
    fetchMatchesToday(sport, matchDate),
    sport.toLowerCase() === 'football' ? allSportsFixtures(matchDate, matchDate) : Promise.resolve({ success: false, data: '', error: 'structured fixture API is football-only' }),
  ]);
  const web = webResult.status === 'fulfilled' ? webResult.value : { success: false, data: '', error: String(webResult.reason) };
  const api = apiResult.status === 'fulfilled' ? apiResult.value : { success: false, data: '', error: String(apiResult.reason) };
  const sources: string[] = [];
  if (web.success && web.data) sources.push(`=== MULTI-SOURCE WEB/SCRAPER SCHEDULE ===\n${web.data}`);
  if (api.success && api.data) sources.push(`=== STRUCTURED ALLSPORTS FULL-DATE FIXTURE FEED ===\n${api.data}`);
  const combinedSchedule = sources.join('\n\n');
  if (!combinedSchedule) return { fixtures: [], rawSchedule: '' };
  onStep({ type: 'thought', content: `📚 Broad discovery collected ${sources.length} schedule sources. Shortlisting up to ${MAX_DISCOVERY_FIXTURES} future fixtures instead of only 6–10.`, timestamp: new Date().toISOString() });
  let llmFixtures: DiscoveredFixture[] = [];
  try {
    const x = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'You are a strict football fixture discovery and temporal-validation engine. Build a BROAD candidate pool from the supplied schedules. Extract only REAL scheduled fixtures that have NOT started. Do not limit the pool to famous leagues or the first few results. Deduplicate fixtures. Never invent fixtures, kickoff times, leagues or statuses. Return JSON only.' },
      { role: 'user', content: `User query: ${userQuery}\nRequested market-local date: ${matchDate}\nMarket timezone: ${MARKET_TIMEZONE}\nCurrent UTC time: ${new Date().toISOString()}\nCandidate schedules:\n${combinedSchedule.substring(0, 30000)}\nReturn up to ${MAX_DISCOVERY_FIXTURES} distinct relevant FUTURE football fixtures from the ENTIRE supplied schedule, across major and minor leagues/competitions. Do not return only 6-10. Each item must be {"fixture":"Home vs Away","kickoff":"ISO-8601 timestamp with timezone/UTC","status":"scheduled","competition":"..."}. The kickoff MUST be later than current time and must fall on ${matchDate} in ${MARKET_TIMEZONE}. Omit any match already started, live, finished, postponed, cancelled, abandoned, or whose kickoff cannot be verified. Prefer broad league coverage and do not rank popularity above availability of real fixtures.` }
    ] as any, temperature: 0, maxTokens: Math.min(3500, 150 + MAX_DISCOVERY_FIXTURES * 110) }));
    const raw = String(x.choices?.[0]?.message?.content || '');
    llmFixtures = parseFixturePayload(raw);
    if (!llmFixtures.length) {
      onStep({ type: 'thought', content: '🛠️ Discovery model returned malformed/non-parseable JSON; activating structured repair and source-data fallback instead of discarding today’s fixtures.', timestamp: new Date().toISOString() });
      llmFixtures = await repairFixturePayload(raw, matchDate);
    }
  } catch (e) {
    onStep({ type: 'error', content: `⚠️ Discovery model failed; using source-data fallback. ${e instanceof Error ? e.message : String(e)}`, timestamp: new Date().toISOString() });
  }

  let fixtures = validateFixtures(llmFixtures, matchDate);
  if (!fixtures.length) {
    const fallback = extractStructuredFallback(combinedSchedule, matchDate);
    fixtures = validateFixtures(fallback, matchDate);
    if (fixtures.length) onStep({ type: 'thought', content: `🔄 Deterministic schedule fallback recovered ${fixtures.length} future fixtures after discovery-model parsing failed.`, timestamp: new Date().toISOString() });
  }
  if (fixtures.length) {
    onStep({ type: 'thought', content: `📊 Discovered ${fixtures.length} verified future fixtures across the full daily slate. Finished/live/stale matches were excluded before specialist analysis.`, timestamp: new Date().toISOString() });
    return { fixtures, rawSchedule: combinedSchedule };
  }
  onStep({ type: 'error', content: `⚠️ No fixtures passed the future-match gate for ${matchDate}. Raw schedule sources were checked, but no candidate had a verifiable future kickoff.`, timestamp: new Date().toISOString() });
  return { fixtures: [], rawSchedule: combinedSchedule };
}

async function parseQuery(userQuery: string) {
  try {
    const r = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Extract match info. Return JSON only.' },
      { role: 'user', content: `Extract from "${userQuery}". Return {"fixture":"Team A vs Team B or multiple/open","sport":"football","market":"Match Result","matchDate":"today or YYYY-MM-DD"}.` }
    ] as any, temperature: 0, maxTokens: 200 }));
    const raw = String(r.choices?.[0]?.message?.content || '');
    for (const candidate of balancedJsonCandidates(raw)) {
      try {
        const p = JSON.parse(candidate) as any;
        const requested = p.matchDate === 'today' ? marketToday() : (p.matchDate || marketToday());
        return { fixture: p.fixture || userQuery, sport: p.sport || 'football', market: p.market || 'Match Result', matchDate: requested };
      } catch { /* continue */ }
    }
  } catch { /* safe defaults */ }
  return { fixture: userQuery, sport: 'football', market: 'Match Result', matchDate: marketToday() };
}

async function buildPlan(_userQuery: string, fixture: string, _sport: string, _market: string): Promise<AgentPlan> {
  return { reasoning: 'Full evidence roster with fixture-level asynchronous fan-out.', agents: [
    { name: 'OddsScout', focus: `Find verified odds and line movement for ${fixture}. Reject odds for finished/live/stale fixtures.`, required: true, tier: 1 },
    { name: 'FormScout', focus: `Find form, H2H, xG and performance data for ${fixture}`, required: true, tier: 1 },
    { name: 'InjuryIntel', focus: `Find injuries, suspensions and availability for ${fixture}`, required: true, tier: 2 },
    { name: 'SentimentAgent', focus: `Find team news, weather, referee and motivation for ${fixture}`, required: false, tier: 2 },
    { name: 'LineupScout', focus: `Find confirmed/predicted lineups for ${fixture}`, required: true, tier: 3 }
  ] };
}

async function dispatchOne(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void): Promise<SubAgentResult> {
  const taskText = task.focus + (prior ? `\n\n${prior}` : '');
  switch (task.name) {
    case 'OddsScout': return runOddsScout(fixture, sport, sessionId, onStep, taskText);
    case 'FormScout': return runFormScout(fixture, sport, sessionId, onStep, taskText);
    case 'InjuryIntel': return runInjuryIntel(fixture, sport, sessionId, onStep, taskText);
    case 'SentimentAgent': return runSentimentAgent(fixture, sport, matchDate, sessionId, onStep, taskText);
    case 'LineupScout': return runLineupScout(fixture, sport, sessionId, onStep, taskText);
  }
}

async function dispatchAgent(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void, fixtures: string[]): Promise<SubAgentResult> {
  const list = fixtures.length > 1 ? fixtures : [fixture];
  if (list.length === 1) return dispatchOne(task, list[0], sport, matchDate, `${sessionId}-${task.name}`, prior, onStep);
  const jobs = await Promise.allSettled(list.map((fx, i) => dispatchOne(task, fx, sport, matchDate, `${sessionId}-${task.name}-${i}`, prior, s => onStep({ ...s, content: `[${fx}] ${s.content}` }))));
  const good = jobs.filter((r): r is PromiseFulfilledResult<SubAgentResult> => r.status === 'fulfilled');
  const raw = jobs.map((r, i) => r.status === 'fulfilled' ? `=== ${list[i]} ===\n${r.value.rawOutput || JSON.stringify(r.value.data)}` : `=== ${list[i]} ===\nFAILED: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`).join('\n\n');
  const data: Record<string, unknown> = { fixtures: Object.fromEntries(jobs.map((r, i) => [list[i], r.status === 'fulfilled' ? r.value.data : { error: r.reason instanceof Error ? r.reason.message : String(r.reason) }])) };
  return { agentName: task.name, success: good.length > 0, partial: good.length < jobs.length, data, steps: good.flatMap(r => r.value.steps), rawOutput: raw, error: good.length ? '' : `All ${jobs.length} fixture jobs failed`, toolErrors: good.flatMap(r => r.value.toolErrors || []) };
}

function priorContext(acc: Record<string, SubAgentResult>) {
  const entries = Object.entries(acc);
  return entries.length ? `=== PRIOR CONTEXT ===\n${entries.map(([n, r]) => `[${n}] ${(r.rawOutput || JSON.stringify(r.data)).substring(0, 1200)}`).join('\n\n')}\n=== END PRIOR CONTEXT ===` : '';
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
  const plan = await buildPlan(userQuery, fixture, sport, market);
  const acc: Record<string, SubAgentResult> = {};
  const agentsRun: string[] = [];
  const byTier: Record<number, AgentTask[]> = {};
  for (const a of plan.agents) (byTier[a.tier] ??= []).push(a);
  for (const tier of Object.keys(byTier).map(Number).sort()) {
    const tasks = byTier[tier];
    emit({ type: 'status', content: `🚀 Tier ${tier}: ${tasks.map(t => t.name).join(' + ')} × ${fixtures.length || 1} games — running asynchronously.` });
    const prior = scheduleContext + priorContext(acc);
    const rs = await Promise.allSettled(tasks.map(t => dispatchAgent(t, fixture, sport, matchDate, sessionId, prior, emit, fixtures)));
    for (let i = 0; i < tasks.length; i++) {
      const r = rs[i], t = tasks[i];
      if (r.status === 'fulfilled') {
        acc[t.name] = r.value; agentsRun.push(t.name);
        emit({ type: r.value.success ? 'thought' : 'error', content: `${r.value.success ? '✅' : '⚠️'} ${t.name}: ${fixtures.length > 1 ? `processed ${fixtures.length} games` : 'completed'}.` });
      } else {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        acc[t.name] = { agentName: t.name, success: false, data: {}, steps: [], rawOutput: '', error: msg };
        emit({ type: 'error', content: `💥 ${t.name}: ${msg}` });
      }
    }
  }
  const empty = (name: AgentName): SubAgentResult => acc[name] || { agentName: name, success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
  try {
    const q = await runQuantSynthesis({ userQuery, fixture, sport, market, sessionId, oddsResult: empty('OddsScout'), formResult: empty('FormScout'), injuryResult: empty('InjuryIntel'), sentimentResult: empty('SentimentAgent'), lineupResult: empty('LineupScout'), onStep: emit, isMultiFixture: fixtures.length > 1, discoveredFixtures: fixtures });
    if (!q.success) return { finalAnswer: q.finalAnswer || `⚠️ Synthesis failed: ${q.error || 'unknown error'}`, steps, success: false, error: q.error, metadata: { fixture, sport, market, agentsRun } };
    const predictionId = `${sessionId}-${Date.now()}`;
    logPrediction({ predictionId, fixture, sport, market, predictedProb: q.trueProb, impliedProb: q.impliedProb, expectedValue: q.expectedValue, isValueBet: q.isValueBet, starRating: q.starRating });
    emit({ type: 'synthesis', content: `🏆 ${fixtures.length > 1 ? `Multi-match synthesis complete for ${fixtures.length} games` : 'Synthesis complete'} | Gate: ${q.isValueBet ? '✅ VALUE BET' : '⚠️ MONITOR'}` });
    return { finalAnswer: q.finalAnswer, steps, success: true, metadata: { fixture, sport, market, predictionId, probability: q.trueProb * 100, confidence: q.confidence, starRating: q.starRating, expectedValue: q.expectedValue, recommendedOdds: q.recommendedOdds, goalStatement: q.goalStatement, monteCarlo: q.monteCarlo, dataCompletenessScore: q.dataCompletenessScore, impliedProb: q.impliedProb, trueProb: q.trueProb, isValueBet: q.isValueBet, recommendedStake: q.recommendedStake, categoryProbabilities: q.categoryProbabilities, agentPlan: plan.agents, agentsRun, subagentResults: Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.success])), poolStatus: mistralPool.status() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { finalAnswer: `⚠️ Synthesis failed: ${msg}`, steps, success: false, error: msg, metadata: { fixture, sport, market, agentsRun } };
  }
}
