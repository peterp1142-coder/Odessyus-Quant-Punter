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
interface AgentPlan { agents: AgentTask[]; }
export interface OrchestratorResult { finalAnswer: string; steps: ReActStep[]; success: boolean; error?: string; metadata: Record<string, unknown>; }
interface DiscoveredFixture { fixture: string; kickoff?: string; status?: string; competition?: string; }

const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';
const MAX_DISCOVERY_FIXTURES = Number(process.env.MAX_DISCOVERY_FIXTURES || 30);
const MAX_FIXTURE_PIPELINES = Number(process.env.MAX_FIXTURE_PIPELINES || 3);

function marketToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function fixtureMatchDate(kickoff?: string, fallback = marketToday()): string {
  if (!kickoff) return fallback;
  const date = new Date(kickoff);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-CA', { timeZone: MARKET_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function isCompletedStatus(status?: string): boolean {
  const value = String(status || '').toLowerCase().trim();
  return !!value && /finished|final|ended|ft|aet|after penalties|cancelled|canceled|postponed|abandoned|walkover|live|in.?play|half.?time/.test(value);
}
function normalizeFixtureName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*(?:vs\.?|v\.?|[-–—])\s*/g, ' vs ').trim();
}
function looksLikeMatch(value: string): boolean {
  const match = value.trim().match(/^(.{2,100}?)\s+(?:vs\.?|v\.?)\s+(.{2,100}?)$/i);
  if (!match) return false;
  const home = match[1].trim();
  const away = match[2].trim();
  if (!home || !away) return false;
  if (/^(fixtures?|schedule|league|today|tomorrow)$/i.test(home)) return false;
  if (/^(fixtures?|schedule|league|today|tomorrow)$/i.test(away)) return false;
  return true;
}
function parseJsonCandidates(raw: string): unknown[] {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const candidates: string[] = [];
  for (const opening of ['{', '['] as const) {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (start < 0) { if (ch === opening) { start = i; depth = 1; } continue; }
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === opening) depth += 1;
      else if ((opening === '{' && ch === '}') || (opening === '[' && ch === ']')) depth -= 1;
      if (depth === 0) { candidates.push(text.slice(start, i + 1)); start = -1; }
    }
  }
  return candidates.sort((a, b) => b.length - a.length).map((value) => { try { return JSON.parse(value); } catch { return null; } }).filter(Boolean);
}
function extractFixturesFromModel(raw: string): DiscoveredFixture[] {
  for (const candidate of parseJsonCandidates(raw)) {
    const value = candidate as any;
    const list = Array.isArray(value) ? value : Array.isArray(value?.fixtures) ? value.fixtures : [];
    const fixtures = list.filter((item: any) => item && typeof item.fixture === 'string' && looksLikeMatch(item.fixture));
    if (fixtures.length) return fixtures;
  }
  return [];
}
function extractFixturesFromLines(raw: string, requestedDate: string): DiscoveredFixture[] {
  const result: DiscoveredFixture[] = [];
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/^[-*•\d.)]+\s*/, '').replace(/\*+/g, '').trim();
    const match = cleaned.match(/(.{2,100}?\s+(?:vs\.?|v\.?)\s+.{2,100}?)(?:\s*[-–—|,]\s*|\s+)(\d{1,2}:\d{2})/i);
    const fixture = (match?.[1] || cleaned).trim();
    if (!looksLikeMatch(fixture)) continue;
    const key = normalizeFixtureName(fixture);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ fixture, kickoff: match ? `${requestedDate}T${match[2]}:00` : undefined, status: 'scheduled' });
    if (result.length >= MAX_DISCOVERY_FIXTURES) break;
  }
  return result;
}
function validateFixtures(values: DiscoveredFixture[], requestedDate: string): DiscoveredFixture[] {
  const seen = new Set<string>();
  const result: DiscoveredFixture[] = [];
  for (const value of values) {
    if (!value?.fixture || !looksLikeMatch(value.fixture) || isCompletedStatus(value.status)) continue;
    if (value.kickoff && fixtureMatchDate(value.kickoff, requestedDate) !== requestedDate) continue;
    const key = normalizeFixtureName(value.fixture);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...value, fixture: value.fixture.trim(), status: value.status || 'scheduled' });
    if (result.length >= MAX_DISCOVERY_FIXTURES) break;
  }
  return result;
}
async function discoverFixtures(userQuery: string, sport: string, requestedDate: string, onStep: (step: ReActStep) => void): Promise<{ fixtures: DiscoveredFixture[]; rawSchedule: string }> {
  onStep({ type: 'status', content: `🔍 Discovering the full ${sport} slate for ${requestedDate} in ${MARKET_TIMEZONE}…` });
  const { fetchMatchesToday, allSportsFixtures } = await import('./tools.js');
  const [broad, web, structured] = await Promise.allSettled([
    broadFixtureDiscovery(requestedDate, sport),
    fetchMatchesToday(sport, requestedDate),
    sport.toLowerCase() === 'football' ? allSportsFixtures(requestedDate, requestedDate) : Promise.resolve({ success: false, data: '', error: 'structured football source only' }),
  ]);
  const sources: string[] = [];
  if (broad.status === 'fulfilled' && broad.value.success && broad.value.data) sources.push(`=== BROAD ===\n${broad.value.data}`);
  if (web.status === 'fulfilled' && web.value.success && web.value.data) sources.push(`=== WEB ===\n${web.value.data}`);
  if (structured.status === 'fulfilled' && structured.value.success && structured.value.data) sources.push(`=== STRUCTURED ===\n${structured.value.data}`);
  const combined = sources.join('\n\n');
  if (!combined) return { fixtures: [], rawSchedule: '' };
  let modelFixtures: DiscoveredFixture[] = [];
  try {
    const response = await mistralPool.call((client) => client.chat.complete({
      model: 'mistral-small-latest',
      messages: [
        { role: 'system', content: 'Extract ALL real future matches from supplied schedules. Return JSON only as {"fixtures":[{"fixture":"Home vs Away","kickoff":"ISO-8601","status":"scheduled","competition":"..."}]}. Never return league names or headings. Do not limit to famous clubs.' },
        { role: 'user', content: `User query: ${userQuery}\nRequested date: ${requestedDate}\nTimezone: ${MARKET_TIMEZONE}\nNow: ${new Date().toISOString()}\nReturn up to ${MAX_DISCOVERY_FIXTURES} distinct future fixtures from the supplied slate. Exclude started, live, finished, postponed and cancelled matches.` },
      ] as any,
      temperature: 0,
      maxTokens: Math.min(5000, 200 + MAX_DISCOVERY_FIXTURES * 150),
    }));
    modelFixtures = extractFixturesFromModel(String(response.choices?.[0]?.message?.content || ''));
  } catch (error) {
    onStep({ type: 'error', content: `Discovery model failed; deterministic fallback active: ${error instanceof Error ? error.message : String(error)}` });
  }
  const valid = validateFixtures([...modelFixtures, ...extractFixturesFromLines(combined, requestedDate)], requestedDate);
  onStep({ type: valid.length ? 'thought' : 'error', content: valid.length ? `📊 ${valid.length} canonical fixtures admitted: ${valid.map((fx) => `${fx.fixture} [${fixtureMatchDate(fx.kickoff, requestedDate)}]`).join(' | ')}` : `⚠️ No verified future fixtures passed the registry gate for ${requestedDate}.` });
  return { fixtures: valid, rawSchedule: combined };
}
async function parseQuery(userQuery: string) {
  try {
    const response = await mistralPool.call((client) => client.chat.complete({ model: 'mistral-small-latest', messages: [{ role: 'system', content: 'Extract match info. Return JSON only.' }, { role: 'user', content: `Extract from "${userQuery}". Return {"fixture":"Team A vs Team B or multiple/open","sport":"football","market":"Match Result","matchDate":"today or YYYY-MM-DD"}.` }] as any, temperature: 0, maxTokens: 200 }));
    for (const candidate of parseJsonCandidates(String(response.choices?.[0]?.message?.content || ''))) {
      const parsed = candidate as any;
      if (!parsed || typeof parsed !== 'object') continue;
      return { fixture: parsed.fixture || userQuery, sport: parsed.sport || 'football', market: parsed.market || 'Match Result', matchDate: parsed.matchDate === 'today' ? marketToday() : parsed.matchDate || marketToday() };
    }
  } catch {}
  return { fixture: userQuery, sport: 'football', market: 'Match Result', matchDate: marketToday() };
}
async function buildPlan(): Promise<AgentPlan> {
  return { agents: [
    { name: 'OddsScout', focus: 'Verify exact-market odds for this fixture.', required: true, tier: 1 },
    { name: 'FormScout', focus: 'Verify current-season form, xG and H2H for this fixture.', required: true, tier: 1 },
    { name: 'InjuryIntel', focus: 'Verify injuries, suspensions and player availability for this fixture.', required: true, tier: 2 },
    { name: 'SentimentAgent', focus: 'Verify current team news, weather and match context for this fixture.', required: false, tier: 2 },
    { name: 'RefereeScout', focus: 'Verify referee assignment and relevant referee evidence for this fixture.', required: false, tier: 2 },
    { name: 'MarketMicrostructureScout', focus: 'Verify bookmaker dispersion, overround and price integrity for this fixture.', required: true, tier: 2 },
    { name: 'LineupScout', focus: 'Verify confirmed or predicted lineups and late team news for this fixture.', required: true, tier: 3 },
    { name: 'TacticalScout', focus: 'Assess the exact tactical matchup for this fixture.', required: false, tier: 3 },
    { name: 'ModelRiskScout', focus: 'Adversarially stress-test the developing prediction for this fixture.', required: true, tier: 4 },
    { name: 'DataQualityScout', focus: 'Audit freshness, provenance and contradictions for this fixture.', required: true, tier: 4 },
  ] };
}
function canonicalFixtureContext(fixture: DiscoveredFixture, sport: string, requestedDate: string): string {
  const matchDate = fixtureMatchDate(fixture.kickoff, requestedDate);
  return ['=== CANONICAL FIXTURE REGISTRY ENTRY ===', `Fixture: ${fixture.fixture}`, `Sport: ${sport}`, `Match date: ${matchDate}`, `Kickoff: ${fixture.kickoff || 'unverified'}`, `Competition: ${fixture.competition || 'verified by registry'}`, 'RULE: This is the ONLY fixture this specialist may research.', `ALL DATE-SPECIFIC SEARCHES MUST USE ${matchDate}.`, 'Do not substitute, merge, or transfer evidence from another fixture.', '=== END CANONICAL FIXTURE REGISTRY ENTRY ==='].join('\n');
}
async function dispatchOne(task: AgentTask, fixture: DiscoveredFixture, sport: string, requestedDate: string, sessionId: string, prior: string, onStep: (step: ReActStep) => void): Promise<SubAgentResult> {
  const matchDate = fixtureMatchDate(fixture.kickoff, requestedDate);
  const taskText = `${canonicalFixtureContext(fixture, sport, requestedDate)}\n\n${task.focus}\n\n${prior}`;
  switch (task.name) {
    case 'OddsScout': return runOddsScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'FormScout': return runFormScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'InjuryIntel': return runInjuryIntel(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'SentimentAgent': return runSentimentAgent(fixture.fixture, sport, matchDate, sessionId, onStep, taskText);
    case 'LineupScout': return runLineupScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'RefereeScout': return runRefereeScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'TacticalScout': return runTacticalScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'DataQualityScout': return runDataQualityScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'MarketMicrostructureScout': return runMarketMicrostructureScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'ModelRiskScout': return runModelRiskScout(fixture.fixture, sport, sessionId, onStep, taskText);
    case 'PortfolioRiskScout': return runPortfolioRiskScout(fixture.fixture, sport, sessionId, onStep, taskText);
    default: throw new Error(`Unsupported agent: ${task.name}`);
  }
}
async function dispatchAgent(task: AgentTask, fixture: DiscoveredFixture, sport: string, requestedDate: string, sessionId: string, prior: string, onStep: (step: ReActStep) => void): Promise<SubAgentResult> {
  return fixtureScheduler.enqueue({
    agentName: task.name,
    fixture: fixture.fixture,
    tier: task.tier,
    run: () => dispatchOne(task, fixture, sport, requestedDate, sessionId, prior, (step) => onStep({ ...step, content: `[${fixture.fixture}] ${step.content}` })),
  }, (position: number) => onStep({ type: 'status', content: `⏳ ${task.name}: ${fixture.fixture} queued behind ${position} job(s).` }));
}
function priorContext(results: Record<string, SubAgentResult>): string {
  const entries = Object.entries(results);
  if (!entries.length) return '';
  return ['=== PRIOR EVIDENCE ===', ...entries.map(([name, result]) => `[${name}]\n${(result.rawOutput || JSON.stringify(result.data)).slice(0, 1800)}`), '=== END PRIOR EVIDENCE ==='].join('\n\n');
}
function aggregateSingle(name: AgentName, fixture: DiscoveredFixture, results: Record<string, SubAgentResult>): SubAgentResult {
  return results[name] || { agentName: name, success: false, data: {}, steps: [], rawOutput: '', error: `No result for ${fixture.fixture}` };
}
function advancedEvidence(results: Record<string, SubAgentResult>, portfolio: SubAgentResult): string {
  const names: AgentName[] = ['RefereeScout', 'TacticalScout', 'MarketMicrostructureScout', 'ModelRiskScout', 'DataQualityScout'];
  return [...names.map((name) => results[name]?.rawOutput || ''), portfolio.rawOutput || ''].filter(Boolean).join('\n\n');
}
async function runFixturePipeline(fixture: DiscoveredFixture, index: number, plan: AgentPlan, scheduleContext: string, sessionId: string, sport: string, requestedDate: string, onStep: (step: ReActStep) => void): Promise<Record<string, SubAgentResult>> {
  const results: Record<string, SubAgentResult> = {};
  const matchDate = fixtureMatchDate(fixture.kickoff, requestedDate);
  onStep({ type: 'status', content: `📅 ${fixture.fixture} · canonical match date ${matchDate}` });
  for (const tier of [1, 2, 3, 4]) {
    const tasks = plan.agents.filter((agent) => agent.tier === tier);
    if (!tasks.length) continue;
    const prior = [canonicalFixtureContext(fixture, sport, requestedDate), scheduleContext, priorContext(results)].filter(Boolean).join('\n\n');
    onStep({ type: 'status', content: `🚦 ${fixture.fixture} · Tier ${tier}: ${tasks.map((task) => task.name).join(' + ')}` });
    const settled = await Promise.allSettled(tasks.map((task) => dispatchAgent(task, fixture, sport, requestedDate, `${sessionId}-${index}-${task.name}`, prior, onStep)));
    tasks.forEach((task, taskIndex) => {
      const result = settled[taskIndex];
      if (result.status === 'fulfilled') {
        results[task.name] = result.value;
        onStep({ type: result.value.success ? 'thought' : 'error', content: `${result.value.success ? '✅' : '⚠️'} ${fixture.fixture} · ${task.name} ${result.value.success ? 'complete' : 'failed'}.` });
      } else {
        const error = result.reason instanceof Error ? result.reason.message : String(result.reason);
        results[task.name] = { agentName: task.name, success: false, data: {}, steps: [], rawOutput: '', error };
        onStep({ type: 'error', content: `💥 ${fixture.fixture} · ${task.name}: ${error}` });
      }
    });
  }
  return results;
}
export async function runOrchestrator(userQuery: string, sessionId: string, onStep: (step: ReActStep) => void): Promise<OrchestratorResult> {
  const steps: ReActStep[] = [];
  const emit = (step: ReActStep) => { const enriched = { ...step, timestamp: new Date().toISOString() }; steps.push(enriched); onStep(enriched); };
  const parsed = await parseQuery(userQuery);
  const sport = parsed.sport;
  const market = parsed.market;
  const requestedDate = parsed.matchDate;
  let fixtures: DiscoveredFixture[] = [];
  let schedule = '';
  if (!parsed.fixture || parsed.fixture === 'multiple/open' || parsed.fixture === userQuery) {
    const discovered = await discoverFixtures(userQuery, sport, requestedDate, emit);
    fixtures = discovered.fixtures;
    schedule = discovered.rawSchedule;
  }
  if (!fixtures.length && parsed.fixture && parsed.fixture !== 'multiple/open') fixtures = [{ fixture: parsed.fixture, status: 'scheduled' }];
  if (!fixtures.length) return { finalAnswer: `NO QUALIFIED FIXTURES: I could not verify future fixtures for ${requestedDate}.`, steps, success: true, metadata: { requestedDate, agentsRun: [] } };
  const plan = await buildPlan();
  const registry: Record<string, Record<string, SubAgentResult>> = {};
  const scheduleContext = schedule ? `=== VERIFIED DISCOVERY SCHEDULE ===\n${schedule.slice(0, 6000)}` : '';
  let nextIndex = 0;
  const workerCount = Math.min(MAX_FIXTURE_PIPELINES, fixtures.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= fixtures.length) return;
      const fixture = fixtures[index];
      registry[fixture.fixture] = await runFixturePipeline(fixture, index, plan, scheduleContext, sessionId, sport, requestedDate, emit);
    }
  });
  await Promise.all(workers);
  let portfolio: SubAgentResult = { agentName: 'PortfolioRiskScout', success: false, data: {}, steps: [], rawOutput: '', error: 'not run' };
  if (fixtures.length > 1) {
    const allEvidence = Object.entries(registry).map(([fixture, results]) => `=== ${fixture} ===\n${priorContext(results)}`).join('\n\n');
    const portfolioFixture = { fixture: fixtures.map((item) => item.fixture).join(' | '), status: 'scheduled' };
    portfolio = await dispatchAgent({ name: 'PortfolioRiskScout', focus: 'Review the complete candidate slate for correlation, common factors and concentration. Do not replace fixture-specific conclusions.', required: true, tier: 5 }, portfolioFixture, sport, requestedDate, `${sessionId}-portfolio`, allEvidence, emit);
  }
  const fixtureAnswers: string[] = [];
  const predictions: Array<Record<string, unknown>> = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    const fixture = fixtures[index];
    const results = registry[fixture.fixture] || {};
    const matchDate = fixtureMatchDate(fixture.kickoff, requestedDate);
    emit({ type: 'status', content: `🧮 Synthesizing ${fixture.fixture} independently for ${matchDate}…` });
    const q = await runQuantSynthesis({
      userQuery,
      fixture: fixture.fixture,
      sport,
      market,
      sessionId: `${sessionId}-synthesis-${index}`,
      oddsResult: aggregateSingle('OddsScout', fixture, results),
      formResult: aggregateSingle('FormScout', fixture, results),
      injuryResult: aggregateSingle('InjuryIntel', fixture, results),
      sentimentResult: aggregateSingle('SentimentAgent', fixture, results),
      lineupResult: aggregateSingle('LineupScout', fixture, results),
      advancedText: advancedEvidence(results, portfolio),
      onStep: emit,
      isMultiFixture: false,
      discoveredFixtures: [fixture.fixture],
    });
    if (q.success) {
      fixtureAnswers.push(`## ${fixture.fixture}\n### Match date: ${matchDate}\n\n${q.finalAnswer || 'NO QUALIFIED ANALYSIS'}`);
      predictions.push({ fixture: fixture.fixture, date: matchDate, success: true, probability: q.trueProb * 100, confidence: q.confidence, starRating: q.starRating, expectedValue: q.expectedValue, isValueBet: q.isValueBet, recommendedOdds: q.recommendedOdds });
      logPrediction({ predictionId: `${sessionId}-${index}-${Date.now()}`, fixture: fixture.fixture, sport, market, predictedProb: q.trueProb, impliedProb: q.impliedProb, expectedValue: q.expectedValue, isValueBet: q.isValueBet, starRating: q.starRating });
    } else {
      fixtureAnswers.push(`## ${fixture.fixture}\n### Match date: ${matchDate}\n\nNO QUALIFIED ANALYSIS\n\n${q.error || 'Synthesis failed for this fixture.'}`);
      predictions.push({ fixture: fixture.fixture, date: matchDate, success: false, error: q.error || 'synthesis failed' });
    }
  }
  emit({ type: 'synthesis', content: `🏆 Independent synthesis complete for ${fixtures.length} fixture(s) — every fixture received its own date-scoped evidence and result.` });
  return {
    finalAnswer: fixtureAnswers.join('\n\n'),
    steps,
    success: true,
    metadata: {
      requestedDate,
      fixtures: fixtures.map((fixture) => ({ fixture: fixture.fixture, kickoff: fixture.kickoff, date: fixtureMatchDate(fixture.kickoff, requestedDate) })),
      predictions,
      agentsRun: [...plan.agents.map((agent) => agent.name), ...(portfolio.success ? ['PortfolioRiskScout'] : [])],
      queueSnapshot: fixtureScheduler.snapshot(),
      researchCache: researchCacheStats(),
      fixtureRegistry: Object.fromEntries(Object.entries(registry).map(([fixture, results]) => [fixture, Object.fromEntries(Object.entries(results).map(([name, result]) => [name, result.success]))])),
      portfolioRisk: portfolio.data,
      poolStatus: mistralPool.status(),
    },
  };
}
