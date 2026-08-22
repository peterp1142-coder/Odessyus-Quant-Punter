/**
 * Broad fixture discovery using the local browser first, then structured APIs
 * and targeted search providers. Discovery is DAY/TIME aware: it targets the
 * user's market date, the current local day/time, imminent kickoffs (next
 * ~40 minutes) as a priority band, and ALL remaining future fixtures for
 * that requested day regardless of how many hours away they start.
 */
import { serpSearch, taloredataSearch, allSportsFixtures, type ToolResult } from './tools.js';
import { localBrowserFixtureDiscovery } from './local-fixture-discovery.js';
import { extractFixtureCandidates, serializeFixtureCandidates } from './fixture-candidate-extractor.js';

const MAX_SEARCH_RESULTS = Number(process.env.MAX_DISCOVERY_FIXTURES || 100);
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';
const SEARCH_BATCH_SIZE = Math.max(1, Math.min(3, Number(process.env.DISCOVERY_SEARCH_CONCURRENCY || 3)));
const SEARCH_QUERY_LIMIT = Math.max(8, Math.min(12, Number(process.env.DISCOVERY_SEARCH_QUERIES || 12)));
const SEARCH_IF_BELOW = Math.max(4, Number(process.env.DISCOVERY_SEARCH_IF_BELOW || 12));
const IMMINENT_MINUTES = Math.max(20, Math.min(60, Number(process.env.DISCOVERY_IMMINENT_MINUTES || 40)));

const LEAGUE_SEARCH_CATALOG = [
  'Premier League', 'Championship', 'League One', 'League Two', 'National League',
  'Scottish Premiership', 'Scottish Championship', 'Scottish League One', 'Scottish League Two',
  'La Liga', 'Segunda Division', 'Serie A', 'Serie B', 'Bundesliga', '2. Bundesliga',
  'Ligue 1', 'Ligue 2', 'Eredivisie', 'Primeira Liga', 'Belgian Pro League', 'Turkish Super Lig',
  'Greek Super League', 'Austrian Bundesliga', 'Swiss Super League',
  'Danish Superliga', 'Allsvenskan', 'Eliteserien', 'Veikkausliiga',
  'MLS', 'Liga MX', 'Brazil Serie A', 'Brazil Serie B', 'Argentina Liga Profesional',
  'Colombia Primera A', 'Chile Primera Division',
  'J1 League', 'J2 League', 'K League 1', 'Saudi Pro League', 'Qatar Stars League', 'UAE Pro League',
  'South African Premiership', 'CAF Champions League', 'CAF Confederation Cup',
  'UEFA Champions League', 'UEFA Europa League', 'UEFA Conference League'
];

function todayInZone(date: Date, timeZone = MARKET_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function dayNameInZone(date: Date, timeZone = MARKET_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(date);
}
function localClockInZone(date: Date, timeZone = MARKET_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}
function plusMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}
function isFutureCandidate(candidate: { kickoff?: string; status?: string }): boolean {
  const status = String(candidate.status || '').toLowerCase();
  if (/finished|final|ended|ft|aet|cancelled|canceled|postponed|abandoned|walkover|live|in.?play|half.?time/.test(status)) return false;
  if (!candidate.kickoff) return false;
  const ts = new Date(candidate.kickoff).getTime();
  return Number.isFinite(ts) && ts >= Date.now() - 120_000;
}
function getTimeDistance(kickoff?: string): number {
  if (!kickoff) return Number.POSITIVE_INFINITY;
  const ts = new Date(kickoff).getTime();
  return Number.isFinite(ts) ? ts - Date.now() : Number.POSITIVE_INFINITY;
}
function priorityBucket(kickoff?: string): 'IMMINENT' | 'LATER_TODAY' {
  const distance = getTimeDistance(kickoff);
  return distance >= 0 && distance <= IMMINENT_MINUTES * 60_000 ? 'IMMINENT' : 'LATER_TODAY';
}

async function runSearchesInBatches(date: string): Promise<ToolResult[]> {
  const now = new Date();
  const dayName = dayNameInZone(now);
  const localTime = localClockInZone(now);
  const leagueGroups = [
    LEAGUE_SEARCH_CATALOG.slice(0, 8).join(' | '),
    LEAGUE_SEARCH_CATALOG.slice(8, 16).join(' | '),
    LEAGUE_SEARCH_CATALOG.slice(16, 24).join(' | '),
    LEAGUE_SEARCH_CATALOG.slice(24, 32).join(' | '),
    LEAGUE_SEARCH_CATALOG.slice(32, 40).join(' | '),
  ];
  const queries = [
    `football fixtures ${date} ${dayName} after ${localTime} local time all leagues upcoming`,
    `football matches ${date} today ${dayName} kickoffs after ${localTime} not started`,
    `football fixtures ${date} next ${IMMINENT_MINUTES} minutes upcoming`,
    `football fixtures ${date} remaining today future matches schedule no time cutoff`,
    `football fixtures ${date} later today all future kickoffs regardless of start hour`,
    `soccer fixtures ${date} all competitions after ${localTime} upcoming`,
    `football fixtures ${date} Europe Asia Africa South America North America after ${localTime}`,
    `football fixtures ${date} ${leagueGroups[0]} upcoming`,
    `football fixtures ${date} ${leagueGroups[1]} upcoming`,
    `football fixtures ${date} ${leagueGroups[2]} upcoming`,
    `football fixtures ${date} ${leagueGroups[3]} upcoming`,
    `football fixtures ${date} ${leagueGroups[4]} upcoming`,
  ].slice(0, SEARCH_QUERY_LIMIT);
  const out: ToolResult[] = [];
  for (let i = 0; i < queries.length; i += SEARCH_BATCH_SIZE) {
    const batch = queries.slice(i, i + SEARCH_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((q) => serpSearch(q)));
    results.forEach((r) => { if (r.status === 'fulfilled') out.push(r.value); });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
}

async function runSecondarySearchesInBatches(date: string): Promise<ToolResult[]> {
  const now = new Date();
  const dayName = dayNameInZone(now);
  const localTime = localClockInZone(now);
  const queries = [
    `football fixtures ${date} ${dayName} after ${localTime} all leagues`,
    `soccer fixtures ${date} next ${IMMINENT_MINUTES} minutes`,
    `football matches ${date} remaining today upcoming not started no upper time limit`,
    `football fixtures ${date} later tonight upcoming`,
    `football fixtures ${date} Premier League Serie A La Liga Bundesliga Ligue 1 upcoming`,
    `football fixtures ${date} Brazil Argentina MLS Liga MX J1 K League Saudi upcoming`,
    `football fixtures ${date} South Africa Primeira Liga Eredivisie Turkey Greece upcoming`,
  ];
  const out: ToolResult[] = [];
  for (let i = 0; i < queries.length; i += SEARCH_BATCH_SIZE) {
    const batch = queries.slice(i, i + SEARCH_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((q) => taloredataSearch(q)));
    results.forEach((r) => { if (r.status === 'fulfilled') out.push(r.value); });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
}

export async function broadFixtureDiscovery(date: string, sport = 'football'): Promise<ToolResult> {
  if (sport.toLowerCase() !== 'football') return { success: false, data: '', error: 'Broad fixture discovery currently supports football only', source: 'broad_fixture_discovery' };

  const now = new Date();
  const localDate = todayInZone(now);
  const localDay = dayNameInZone(now);
  const localTime = localClockInZone(now);
  const imminentUntil = new Date(Date.now() + IMMINENT_MINUTES * 60_000);
  const [browser, api] = await Promise.all([localBrowserFixtureDiscovery(date, sport), allSportsFixtures(date, date)]);

  const parts: string[] = [];
  const candidateTexts: string[] = [];
  if (browser.success && browser.data) { parts.push(`=== LOCAL BROWSER FIXTURE DISCOVERY ===\n${browser.data}`); candidateTexts.push(browser.data); }
  if (api.success && api.data) { parts.push(`=== STRUCTURED FIXTURE API ===\n${api.data}`); candidateTexts.push(api.data); }

  const firstCandidates = candidateTexts.flatMap((text, i) => extractFixtureCandidates(text, date, MARKET_TIMEZONE, `primary-source-${i + 1}`));
  const firstFutureCandidates = firstCandidates.filter(isFutureCandidate);
  const firstKeys = new Set(firstCandidates.map(c => `${c.fixture.toLowerCase()}|${c.kickoff}`));
  const firstFutureKeys = new Set(firstFutureCandidates.map(c => `${c.fixture.toLowerCase()}|${c.kickoff}`));

  let allSearches: ToolResult[] = [];
  if (firstFutureKeys.size < SEARCH_IF_BELOW || !browser.success) {
    const searches = await runSearchesInBatches(date);
    const secondary = searches.filter(r => r.success && r.data).length < 3 || firstFutureKeys.size === 0
      ? await runSecondarySearchesInBatches(date)
      : [];
    allSearches = [...searches, ...secondary];
  }

  allSearches.forEach((r, i) => {
    if (r.success && r.data) {
      parts.push(`=== DISCOVERY SEARCH ${i + 1} (${r.source || 'search'}) ===\n${r.data}`);
      candidateTexts.push(r.data);
    }
  });

  if (!parts.length) return { success: false, data: '', error: 'All broad fixture sources failed', source: 'broad_fixture_discovery' };

  const candidates = candidateTexts.flatMap((text, i) => extractFixtureCandidates(text, date, MARKET_TIMEZONE, `broad-source-${i + 1}`));
  const deduped = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    const key = `${candidate.fixture.toLowerCase()}|${candidate.kickoff}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }

  const deterministic = [...deduped.values()]
    .filter(isFutureCandidate)
    .sort((a, b) => {
      const ad = getTimeDistance(a.kickoff);
      const bd = getTimeDistance(b.kickoff);
      const ai = ad <= IMMINENT_MINUTES * 60_000 ? 0 : 1;
      const bi = bd <= IMMINENT_MINUTES * 60_000 ? 0 : 1;
      return ai - bi || ad - bd;
    })
    .slice(0, Math.max(MAX_SEARCH_RESULTS * 3, 300));

  const imminentCandidates = deterministic.filter(c => priorityBucket(c.kickoff) === 'IMMINENT');
  const laterTodayCandidates = deterministic.filter(c => priorityBucket(c.kickoff) === 'LATER_TODAY');
  const payload = [
    `[Broad football discovery date=${date}; localDate=${localDate}; localDay=${localDay}; localTime=${localTime}; imminentWindow=${imminentUntil.toISOString()}; imminentMinutes=${IMMINENT_MINUTES}; NO_MAX_HOURS_CUTOFF=true; targetPool=${MAX_SEARCH_RESULTS}; primaryCandidates=${firstKeys.size}; primaryFutureCandidates=${firstFutureKeys.size}; searchCalls=${allSearches.length}; imminentCandidates=${imminentCandidates.length}; laterTodayCandidates=${laterTodayCandidates.length}; localBrowser=${browser.success ? 'available' : 'failed'}]`,
    '=== LEAGUE SEARCH CATALOG ===',
    LEAGUE_SEARCH_CATALOG.join(' | '),
    '=== DETERMINISTIC FUTURE FIXTURE CANDIDATES ===',
    'All candidates below have explicit kickoff timestamps, are still future at discovery time, and match the requested day. IMMINENT is only a priority bucket; LATER_TODAY remains fully eligible with no upper-hours cutoff.',
    '=== IMMINENT (0-40 MIN) PRIORITY ===',
    serializeFixtureCandidates(imminentCandidates),
    '=== LATER TODAY (40+ MIN) ===',
    serializeFixtureCandidates(laterTodayCandidates),
    ...parts,
  ].join('\n\n');

  return { success: true, data: payload.slice(0, 150000), source: 'broad_fixture_discovery' };
}
