import type { ReActStep } from './react-engine.js';
import { runOddsScout } from './subagents/odds-scout.js';
import { runFormScout } from './subagents/form-scout.js';
import { runInjuryIntel } from './subagents/injury-intel.js';
import { runSentimentAgent } from './subagents/sentiment-agent.js';
import { runLineupScout } from './subagents/lineup-scout.js';
import { runRefereeScout } from './subagents/referee-scout.js';
import { runTacticalScout } from './subagents/tactical-scout.js';
import { runDataQualityScout } from './subagents/data-quality-scout.js';
import { runMarketMicrostructureScout } from './subagents/market-microstructure.js';
import { runModelRiskScout } from './subagents/model-risk.js';
import { runPortfolioRiskScout } from './subagents/portfolio-risk.js';
import { runQuantSynthesis } from './subagents/quant-synthesis.js';
import { mistralPool } from './mistral-pool.js';
import type { SubAgentResult } from './subagents/base.js';
import { logPrediction } from './airtable-logger.js';
import { broadFixtureDiscovery } from './broad-fixture-sources.js';
import { fixtureScheduler } from './fixture-task-scheduler.js';
import { researchCacheStats } from './research-cache.js';

type AgentName = 'OddsScout' | 'FormScout' | 'InjuryIntel' | 'SentimentAgent' | 'LineupScout' | 'RefereeScout' | 'TacticalScout' | 'DataQualityScout' | 'MarketMicrostructureScout' | 'ModelRiskScout' | 'PortfolioRiskScout';
interface AgentTask { name: AgentName; focus: string; required: boolean; tier: number; }
interface AgentPlan { reasoning: string; agents: AgentTask[]; }
export interface OrchestratorResult { finalAnswer: string; steps: ReActStep[]; success: boolean; error?: string; metadata: any; }
interface DiscoveredFixture { fixture: string; kickoff?: string; status?: string; competition?: string; }

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';
const MAX_DISCOVERY_FIXTURES = Number(process.env.MAX_DISCOVERY_FIXTURES || 30);
const MAX_FIXTURE_PIPELINES = Number(process.env.MAX_FIXTURE_PIPELINES || 3);

function marketToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function isTodayOrFuture(k?: string, requestedDate = '') { if (!k) return false; const d = new Date(k); return !Number.isNaN(d.getTime()) && d.getTime() > Date.now() - 120000 && d.toLocaleDateString('en-CA', { timeZone: MARKET_TIMEZONE }) === requestedDate; }
function isCompletedStatus(status?: string) { const s = String(status || '').toLowerCase().trim(); return !!s && /finished|final|ended|ft|aet|after penalties|cancelled|canceled|postponed|abandoned|walkover|live|in.?play|half.?time/.test(s); }
function isGenericFixtureLabel(value: string) { return /\b(fixtures?|schedule|slate|league|premier division fixtures|championship fixtures|today(?:'s)? fixtures)\b/i.test(value) && !/\b(?:vs\.?|v\.?)\b/i.test(value); }
function looksLikeMatch(value: string) {
  const m = value.trim().match(/^(.{2,100}?)\s+(?:vs\.?|v\.?)\s+(.{2,100}?)$/i);
  if (!m) return false;
  const home = m[1].trim(), away = m[2].trim();
  if (!home || !away || home.length < 2 || away.length < 2) return false;
  if (/^(fixtures?|schedule|league|premier division|championship|today|tomorrow)$/i.test(home)) return false;
  if (/^(fixtures?|schedule|league|premier division|championship|today|tomorrow)$/i.test(away)) return false;
  return !/\bfixtures?\b/i.test(home) && !/\bfixtures?\b/i.test(away);
}
function normalizeFixtureName(value: string) { return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*(?:vs\.?|v\.?|[-–—])\s*/g, ' vs ').trim(); }

function extractTextFixtures(raw: string, requestedDate: string): DiscoveredFixture[] {
  const out: DiscoveredFixture[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/^[-*•\d.)]+\s*/, '').replace(/\*+/g, '').trim();
    const m = cleaned.match(/(.{2,100}?\s+(?:vs\.?|v\.?)\s+.{2,100}?)(?:\s*[-–—|,]\s*|\s+)(\d{1,2}:\d{2})(?:\s*(?:local time|UK time|UTC)?)?/i);
    const fixture = (m?.[1] || cleaned).replace(/\s+(?:\([^)]*\))\s*$/,'').trim();
    if (!looksLikeMatch(fixture) || isGenericFixtureLabel(fixture)) continue;
    const key = normalizeFixtureName(fixture);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ fixture, kickoff: m ? `${requestedDate}T${m[2]}:00` : undefined, status: 'scheduled' });
    if (out.length >= MAX_DISCOVERY_FIXTURES) break;
  }
  return out;
}

function balancedJsonCandidates(raw: string) {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const out: string[] = [];
  for (const startChar of ['{', '[']) {
    let start = -1, depth = 0, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (start < 0) { if (ch === startChar) { start = i; depth = 1; } continue; }
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') { inString = true; continue; }
      if (ch === startChar) depth++;
      else if ((startChar === '{' && ch === '}') || (startChar === '[' && ch === ']')) depth--;
      if (depth === 0) { out.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

function parseFixturePayload(raw: string): DiscoveredFixture[] {
  for (const candidate of balancedJsonCandidates(raw)) {
    try {
      const value = JSON.parse(candidate) as any;
      const list = Array.isArray(value) ? value : Array.isArray(value?.fixtures) ? value.fixtures : [];
      if (list.length) return list.filter((x: any) => x && typeof x.fixture === 'string');
    } catch {}
  }
  return [];
}

function validateFixtures(values: DiscoveredFixture[], requestedDate: string) {
  const seen = new Set<string>(); const result: DiscoveredFixture[] = [];
  for (const value of values) {
    if (!value || typeof value.fixture !== 'string') continue;
    const fixture = value.fixture.trim();
    if (!looksLikeMatch(fixture) || isGenericFixtureLabel(fixture)) continue;
    if (isCompletedStatus(value.status)) continue;
    if (value.kickoff && !isTodayOrFuture(value.kickoff, requestedDate)) continue;
    const key = normalizeFixtureName(fixture); if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...value, fixture, status: value.status || 'scheduled' });
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
        const fixture = typeof home === 'string' && typeof away === 'string' ? `${home} vs ${away}` : '';
        if (looksLikeMatch(fixture) && typeof kickoff === 'string') results.push({ fixture, kickoff, status: typeof status === 'string' ? status : 'scheduled', competition: node.competition?.name || node.league?.name });
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
      { role: 'system', content: 'Return only valid JSON: {"fixtures":[{"fixture":"Home vs Away","kickoff":"ISO-8601","status":"scheduled","competition":"..."}]}. Copy only explicit real matches; reject league names, fixture-list titles, headings, and generic labels. Never invent.' },
      { role: 'user', content: `Requested date ${matchDate}\nMalformed schedule:\n${raw.slice(0, 12000)}` },
    ] as any, temperature: 0, maxTokens: 2500 }));
    return parseFixturePayload(String(x.choices?.[0]?.message?.content || ''));
  } catch { return []; }
}

async function discoverFixtures(userQuery: string, sport: string, date: string, onStep: (s: ReActStep) => void) {
  onStep({ type: 'status', content: `🔍 Wide discovery: scanning the full ${sport} slate for ${date} in ${MARKET_TIMEZONE}…` });
  const broad = await broadFixtureDiscovery(date, sport);
  const { fetchMatchesToday, allSportsFixtures } = await import('./tools.js');
  const [webResult, apiResult] = await Promise.allSettled([
    fetchMatchesToday(sport, date),
    sport.toLowerCase() === 'football' ? allSportsFixtures(date, date) : Promise.resolve({ success: false, data: '', error: 'football only' }),
  ]);
  const web = webResult.status === 'fulfilled' ? webResult.value : { success: false, data: '', error: String(webResult.reason) };
  const api = apiResult.status === 'fulfilled' ? apiResult.value : { success: false, data: '', error: String(apiResult.reason) };
  const sources: string[] = [];
  if (broad.success && broad.data) sources.push(`=== BROAD ===\n${broad.data}`);
  if (web.success && web.data) sources.push(`=== WEB ===\n${web.data}`);
  if (api.success && api.data) sources.push(`=== STRUCTURED ===\n${api.data}`);
  const combined = sources.join('\n\n');
  if (!combined) return { fixtures: [], rawSchedule: '' };
  onStep({ type: 'thought', content: `📚 ${sources.length} independent schedule feeds collected; candidates are validated before specialist work.` });
  let modelFixtures: DiscoveredFixture[] = [];
  try {
    const r = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Extract all real future fixtures from supplied schedules. Return only actual Home vs Away matches with kickoff times. Never return league titles, fixture-list headings, or generic labels. Do not limit to famous leagues. JSON only.' },
      { role: 'user', content: `User:${userQuery}\nDate:${date}\nTimezone:${MARKET_TIMEZONE}\nNow:${new Date().toISOString()}\nReturn up to ${MAX_DISCOVERY_FIXTURES} distinct future fixtures from the ENTIRE supplied slate with verified ISO kickoff; omit started/live/finished/postponed/cancelled.` },
    ] as any, temperature: 0, maxTokens: Math.min(5000, 150 + MAX_DISCOVERY_FIXTURES * 140) }));
    const raw = String(r.choices?.[0]?.message?.content || ''); modelFixtures = parseFixturePayload(raw);
    if (!modelFixtures.length) modelFixtures = await repairFixturePayload(raw, date);
  } catch (e) { onStep({ type: 'error', content: `Discovery model failed; deterministic fallback active: ${e instanceof Error ? e.message : String(e)}` }); }
  const textFixtures = extractTextFixtures(combined, date);
  const structuredFixtures = extractStructuredFallback(combined);
  const valid = validateFixtures([...modelFixtures, ...structuredFixtures, ...textFixtures], date);
  if (!valid.length) onStep({ type: 'error', content: `⚠️ No verified future match fixtures passed the identity/temporal gate for ${date}.` });
  else onStep({ type: 'thought', content: `📊 ${valid.length} canonical fixtures admitted to the fixture registry: ${valid.map(x => x.fixture).join(' | ')}` });
  return { fixtures: valid, rawSchedule: combined };
}

async function parseQuery(userQuery: string) {
  try {
    const r = await mistralPool.call(c => c.chat.complete({ model: 'mistral-small-latest', messages: [
      { role: 'system', content: 'Extract match info. Return JSON only.' },
      { role: 'user', content: `Extract from "${userQuery}". Return {"fixture":"Team A vs Team B or multiple/open","sport":"football","market":"Match Result","matchDate":"today or YYYY-MM-DD"}.` },
    ] as any, temperature: 0, maxTokens: 200 }));
    for (const candidate of balancedJsonCandidates(String(r.choices?.[0]?.message?.content || ''))) {
      try { const p = JSON.parse(candidate) as any; return { fixture: p.fixture || userQuery, sport: p.sport || 'football', market: p.market || 'Match Result', matchDate: p.matchDate === 'today' ? marketToday() : (p.matchDate || marketToday()) }; } catch {}
    }
  } catch {}
  return { fixture: userQuery, sport: 'football', market: 'Match Result', matchDate: marketToday() };
}

async function buildPlan(fixture: string): Promise<AgentPlan> {
  return { reasoning: 'Fixture-scoped dependency DAG with a canonical fixture registry, adversarial review and portfolio validation.', agents: [
    { name: 'OddsScout', focus: `Verify exact-market odds, opening/current price and price integrity for ${fixture}.`, required: true, tier: 1 },
    { name: 'FormScout', focus: `Verify current-season form, xG, venue performance and useful H2H for ${fixture}.`, required: true, tier: 1 },
    { name: 'InjuryIntel', focus: `Verify current injuries, suspensions and availability for ${fixture}.`, required: true, tier: 2 },
    { name: 'SentimentAgent', focus: `Verify current team news, weather, motivation and context for ${fixture}.`, required: false, tier: 2 },
    { name: 'RefereeScout', focus: `Verify appointed referee and referee-specific evidence for ${fixture}; use null when unverified.`, required: false, tier: 2 },
    { name: 'MarketMicrostructureScout', focus: `Verify cross-bookmaker dispersion, overround, liquidity and CLV/price integrity for ${fixture}.`, required: true, tier: 2 },
    { name: 'LineupScout', focus: `Verify confirmed/predicted lineups and late team news for ${fixture}.`, required: true, tier: 3 },
    { name: 'TacticalScout', focus: `Assess exact tactical matchup, formations, transitions and set pieces for ${fixture}.`, required: false, tier: 3 },
    { name: 'ModelRiskScout', focus: `Adversarially stress-test the developing prediction for ${fixture}.`, required: true, tier: 4 },
    { name: 'DataQualityScout', focus: `Audit freshness, provenance, contradictions, missing critical evidence and market-specific applicability for ${fixture}.`, required: true, tier: 4 },
  ] };
}

function canonicalFixtureContext(fixture: string, sport: string, matchDate: string, competition?: string) {
  return `=== CANONICAL FIXTURE REGISTRY ENTRY ===\nFixture: ${fixture}\nSport: ${sport}\nMatch date: ${matchDate}\nCompetition: ${competition || 'verified by fixture registry'}\nRULE: This is the ONLY match this specialist is permitted to analyze. Do not rediscover, substitute, merge, or replace the fixture. If a source concerns another match, mark it irrelevant and do not use it as evidence.\n=== END CANONICAL FIXTURE REGISTRY ENTRY ===`;
}

async function dispatchOne(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void): Promise<SubAgentResult> {
  const taskText = `${canonicalFixtureContext(fixture, sport, matchDate)}\n\n${task.focus}\n\n${prior}`;
  switch (task.name) {
    case 'OddsScout': return runOddsScout(fixture, sport, sessionId, onStep, taskText);
    case 'FormScout': return runFormScout(fixture, sport, sessionId, onStep, taskText);
    case 'InjuryIntel': return runInjuryIntel(fixture, sport, sessionId, onStep, taskText);
    case 'SentimentAgent': return runSentimentAgent(fixture, sport, matchDate, sessionId, onStep, taskText);
    case 'LineupScout': return runLineupScout(fixture, sport, sessionId, onStep, taskText);
    case 'RefereeScout': return runRefereeScout(fixture, sport, sessionId, onStep, taskText);
    case 'TacticalScout': return runTacticalScout(fixture, sport, sessionId, onStep, taskText);
    case 'DataQualityScout': return runDataQualityScout(fixture, sport, sessionId, onStep, taskText);
    case 'MarketMicrostructureScout': return runMarketMicrostructureScout(fixture, sport, sessionId, onStep, taskText);
    case 'ModelRiskScout': return runModelRiskScout(fixture, sport, sessionId, onStep, taskText);
    case 'PortfolioRiskScout': return runPortfolioRiskScout(fixture, sport, sessionId, onStep, taskText);
    default: throw new Error(`Unsupported agent: ${task.name}`);
  }
}

async function dispatchAgent(task: AgentTask, fixture: string, sport: string, matchDate: string, sessionId: string, prior: string, onStep: (s: ReActStep) => void): Promise<SubAgentResult> {
  return fixtureScheduler.enqueue({ agentName: task.name, fixture, tier: task.tier, run: () => dispatchOne(task, fixture, sport, matchDate, sessionId, prior, s => onStep({ ...s, content: `[${fixture}] ${s.content}` })) }, position => onStep({ type: 'status', content: `⏳ ${task.name}: ${fixture} queued behind ${position} job(s).` }));
}

function priorContext(acc: Record<string, SubAgentResult>) {
  const entries = Object.entries(acc);
  return entries.length ? `=== PRIOR EVIDENCE ===\n${entries.map(([n, r]) => `[${n}] ${(r.rawOutput || JSON.stringify(r.data)).slice(0, 1800)}`).join('\n\n')}\n=== END PRIOR EVIDENCE ===` : '';
}

async function runFixturePipeline(fx: DiscoveredFixture, index: number, plan: AgentPlan, scheduleContext: string, sessionId: string, sport: string, matchDate: string, onStep: (s: ReActStep) => void) {
  const results: Record<string, SubAgentResult> = {};
  const fixture = fx.fixture;
  const canonical = canonicalFixtureContext(fixture, sport, matchDate, fx.competition);
  for (const tier of [1, 2, 3, 4]) {
    const tasks = plan.agents.filter(a => a.tier === tier); if (!tasks.length) continue;
    onStep({ type: 'status', content: `🚦 ${fixture} · Tier ${tier}: ${tasks.map(t => t.name).join(' + ')}` });
    const prior = `${canonical}\n${scheduleContext}\n${priorContext(results)}`.trim();
    const settled = await Promise.allSettled(tasks.map(task => dispatchAgent(task, fixture, sport, matchDate, `${sessionId}-${index}-${task.name}`, prior, onStep)));
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i], result = settled[i];
      if (result.status === 'fulfilled') {
        results[task.name] = result.value;
        onStep({ type: result.value.success ? 'thought' : 'error', content: `${result.value.success ? '✅' : '⚠️'} ${fixture} · ${task.name} ${result.value.success ? 'complete' : 'failed'}.` });
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        results[task.name] = { agentName: task.name, success: false, data: {}, steps: [], rawOutput: '', error };
        onStep({ type: 'error', content: `💥 ${fixture} · ${task.name}: ${error}` });
      }
    }
    const requiredFailed = tasks.filter(t => t.required).some(t => !results[t.name]?.success);
    if (requiredFailed) onStep({ type: 'error', content: `⛔ ${fixture} · Tier ${tier} has missing required evidence; downstream gates remain fail-closed.` });
  }
  return results;
}

function aggregate(name: AgentName, registry: Record<string, Record<string, SubAgentResult>>) {
  const raws: string[] = []; const datas: Record<string, unknown> = {}; let successes = 0;
  for (const fx of Object.keys(registry)) { const result = registry[fx]?.[name]; if (!result) continue; if (result.success) successes++; raws.push(`=== ${fx} ===\n${result.rawOutput || JSON.stringify(result.data)}`); datas[fx] = result.data; }
  return { agentName: name, success: successes > 0, data: { fixtures: datas }, steps: [], rawOutput: raws.join('\n\n'), error: successes ? '' : `No successful ${name} jobs` } as SubAgentResult;
}

async function runOrchestrator(userQuery: string, sessionId: string, onStep: (step: ReActStep) => void): Promise<OrchestratorResult> {
  const steps: ReActStep[] = [];
  const emit = (s: ReActStep) => { const x = { ...s, timestamp: new Date().toISOString() }; steps.push(x); onStep(x); };
  const pool = mistralPool.status(); emit({ type: 'status', content: `🧠 Odessyus initializing — ${pool.total} model keys, ${pool.available} available.` });
  const parsed = await parseQuery(userQuery);
  let { fixture, sport, market, matchDate } = parsed;
  let fixtures: DiscoveredFixture[] = []; let schedule = '';
  if (!fixture || fixture === 'multiple/open' || fixture === userQuery) {
    const discovered = await discoverFixtures(userQuery, sport, matchDate, emit);
    fixtures = discovered.fixtures; schedule = discovered.rawSchedule; if (fixtures.length) fixture = fixtures.map(x => x.fixture).join(' | ');
  }
  if (!fixtures.length && (fixture === 'multiple/open' || fixture === userQuery)) return { finalAnswer: `NO QUALIFIED FIXTURES: I could not verify any future, not-yet-started fixtures for ${matchDate}.`, steps, success: true, metadata: { fixture, sport, market, matchDate, agentsRun: [] } };
  const plan = await buildPlan(fixture);
  const registry: Record<string, Record<string, SubAgentResult>> = {};
  const scheduleContext = schedule ? `=== VERIFIED SCHEDULE ${matchDate} ===\n${schedule.slice(0, 5000)}` : '';
  const pipelineFixtures = fixtures.length ? fixtures : [{ fixture, status: 'scheduled' }];
  let nextIndex = 0;
  const workerCount = Math.min(MAX_FIXTURE_PIPELINES, pipelineFixtures.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= pipelineFixtures.length) return;
      const fx = pipelineFixtures[index];
      registry[fx.fixture] = await runFixturePipeline(fx, index, plan, scheduleContext, sessionId, sport, matchDate, emit);
    }
  });
  await Promise.all(workers);
  let portfolio: SubAgentResult = { agentName: 'PortfolioRiskScout', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
  const fixturesForPortfolio = Object.entries(registry).map(([fx, results]) => `=== ${fx} ===\n${priorContext(results)}`).join('\n\n');
  if (pipelineFixtures.length > 1) portfolio = await dispatchAgent({ name: 'PortfolioRiskScout', focus: 'Review the entire candidate slate for correlation, common factors and concentration.', required: true, tier: 5 }, pipelineFixtures.map(x => x.fixture).join(' | '), sport, matchDate, `${sessionId}-portfolio`, fixturesForPortfolio, emit);
  const odds = aggregate('OddsScout', registry);
  const form = aggregate('FormScout', registry);
  const injury = aggregate('InjuryIntel', registry);
  const sentiment = aggregate('SentimentAgent', registry);
  const lineup = aggregate('LineupScout', registry);
  const advancedText = [aggregate('RefereeScout', registry).rawOutput, aggregate('TacticalScout', registry).rawOutput, aggregate('MarketMicrostructureScout', registry).rawOutput, aggregate('ModelRiskScout', registry).rawOutput, aggregate('DataQualityScout', registry).rawOutput, portfolio.rawOutput].filter(Boolean).join('\n\n');
  try {
    const enrichedSentiment = { ...sentiment, rawOutput: [sentiment.rawOutput, '=== ADVANCED EVIDENCE ===', advancedText].join('\n') };
    const q = await runQuantSynthesis({ userQuery, fixture, sport, market, sessionId, oddsResult: odds, formResult: form, injuryResult: injury, sentimentResult: enrichedSentiment, lineupResult: lineup, advancedText, onStep: emit, isMultiFixture: pipelineFixtures.length > 1, discoveredFixtures: pipelineFixtures.map(x => x.fixture) });
    if (!q.success) return { finalAnswer: q.finalAnswer || `⚠️ Synthesis failed: ${q.error || 'unknown error'}`, steps, success: false, error: q.error, metadata: { fixture, sport, market, fixtures: pipelineFixtures.map(x => x.fixture) } };
    const predictionId = `${sessionId}-${Date.now()}`;
    logPrediction({ predictionId, fixture, sport, market, predictedProb: q.trueProb, impliedProb: q.impliedProb, expectedValue: q.expectedValue, isValueBet: q.isValueBet, starRating: q.starRating });
    emit({ type: 'synthesis', content: `🏆 ${pipelineFixtures.length > 1 ? `Multi-match synthesis complete for ${pipelineFixtures.length} fixtures` : 'Synthesis complete'} · FIFO queues drained · advanced risk gates applied.` });
    const agentsRun = plan.agents.map(a => a.name); if (portfolio.success) agentsRun.push('PortfolioRiskScout');
    return { finalAnswer: q.finalAnswer, steps, success: true, metadata: { fixture, sport, market, matchDate, fixtures: pipelineFixtures.map(x => x.fixture), predictionId, probability: q.trueProb * 100, confidence: q.confidence, starRating: q.starRating, expectedValue: q.expectedValue, recommendedOdds: q.recommendedOdds, dataCompletenessScore: q.dataCompletenessScore, isValueBet: q.isValueBet, recommendedStake: q.recommendedStake, categoryProbabilities: q.categoryProbabilities, agentPlan: plan.agents, agentsRun, queueSnapshot: fixtureScheduler.snapshot(), researchCache: researchCacheStats(), fixtureRegistry: Object.fromEntries(Object.entries(registry).map(([fx, results]) => [fx, Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.success]))])), portfolioRisk: portfolio.data, poolStatus: mistralPool.status() } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { finalAnswer: `⚠️ Synthesis failed: ${msg}`, steps, success: false, error: msg, metadata: { fixture, sport, market, fixtures: pipelineFixtures.map(x => x.fixture), queueSnapshot: fixtureScheduler.snapshot() } };
  }
}
