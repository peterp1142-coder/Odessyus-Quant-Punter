/**
 * Broad fixture discovery using the local browser first, then structured APIs
 * and search providers when the deterministic FUTURE candidate pool is thin.
 */
import { serpSearch, taloredataSearch, allSportsFixtures, type ToolResult } from './tools.js';
import { localBrowserFixtureDiscovery } from './local-fixture-discovery.js';
import { extractFixtureCandidates, serializeFixtureCandidates } from './fixture-candidate-extractor.js';

const MAX_SEARCH_RESULTS = Number(process.env.MAX_DISCOVERY_FIXTURES || 100);
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';
const SEARCH_BATCH_SIZE = Math.max(1, Math.min(3, Number(process.env.DISCOVERY_SEARCH_CONCURRENCY || 3)));
const SEARCH_QUERY_LIMIT = Math.max(7, Math.min(12, Number(process.env.DISCOVERY_SEARCH_QUERIES || 12)));
const SEARCH_IF_BELOW = Math.max(4, Number(process.env.DISCOVERY_SEARCH_IF_BELOW || 12));

function todayInZone(date: Date, timeZone = MARKET_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function isFutureCandidate(candidate: { kickoff?: string; status?: string }): boolean {
  const status = String(candidate.status || '').toLowerCase();
  if (/finished|final|ended|ft|aet|cancelled|canceled|postponed|abandoned|walkover|live|in.?play|half.?time/.test(status)) return false;
  if (!candidate.kickoff) return false;
  const ts = new Date(candidate.kickoff).getTime();
  return Number.isFinite(ts) && ts >= Date.now() - 120_000;
}

async function runSearchesInBatches(date: string): Promise<ToolResult[]> {
  const queries = [
    `football fixtures ${date} all leagues today kickoff`,
    `soccer fixtures ${date} today all leagues results schedule`,
    `football matches ${date} Europe Asia Africa South America North America`,
    `football fixtures ${date} site:flashscore.com OR site:sofascore.com OR site:livescore.com`,
    `football fixtures ${date} site:espn.com OR site:bbc.com/sport/football`,
    `football fixtures ${date} site:soccerway.com OR site:footystats.org`,
    `football fixtures ${date} site:worldfootball.net OR site:globalsportsarchive.com`,
    `Premier League fixtures ${date} Championship fixtures ${date} League One fixtures ${date}`,
    `La Liga fixtures ${date} Serie A fixtures ${date} Bundesliga fixtures ${date}`,
    `Ligue 1 fixtures ${date} Eredivisie fixtures ${date} Primeira Liga fixtures ${date}`,
    `MLS fixtures ${date} Liga MX fixtures ${date} Brazil Serie A fixtures ${date} Argentina fixtures ${date}`,
    `Africa football fixtures ${date} Asia football fixtures ${date} international football fixtures ${date}`,
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
  const queries = [
    `football fixtures ${date} all leagues today kickoff`,
    `soccer fixtures ${date} Africa Europe Asia today`,
    `football matches ${date} South America North America today`,
    `football fixtures ${date} Premier League Serie A La Liga Bundesliga Ligue 1`,
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
  if (sport.toLowerCase() !== 'football') {
    return { success: false, data: '', error: 'Broad fixture discovery currently supports football only', source: 'broad_fixture_discovery' };
  }

  const [browser, api] = await Promise.all([
    localBrowserFixtureDiscovery(date, sport),
    allSportsFixtures(date, date),
  ]);

  const parts: string[] = [];
  const candidateTexts: string[] = [];
  if (browser.success && browser.data) { parts.push(`=== LOCAL BROWSER FIXTURE DISCOVERY ===\n${browser.data}`); candidateTexts.push(browser.data); }
  if (api.success && api.data) { parts.push(`=== STRUCTURED FIXTURE API ===\n${api.data}`); candidateTexts.push(api.data); }

  const firstCandidates = candidateTexts.flatMap((text, i) => extractFixtureCandidates(text, date, MARKET_TIMEZONE, `primary-source-${i + 1}`));
  const firstFutureCandidates = firstCandidates.filter(isFutureCandidate);
  const firstKeys = new Set(firstCandidates.map(c => `${c.fixture.toLowerCase()}|${c.kickoff}`));
  const firstFutureKeys = new Set(firstFutureCandidates.map(c => `${c.fixture.toLowerCase()}|${c.kickoff}`));

  let allSearches: ToolResult[] = [];
  // Critical: a large number of primary candidates can simply mean the sources
  // are full of matches that have already finished. Search expansion must be
  // driven by FUTURE candidates, not total candidates.
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
    .sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())
    .slice(0, Math.max(MAX_SEARCH_RESULTS * 3, 300));

  const payload = [
    `[Broad football discovery date=${date}; localDate=${todayInZone(new Date())}; targetPool=${MAX_SEARCH_RESULTS}; primaryCandidates=${firstKeys.size}; primaryFutureCandidates=${firstFutureKeys.size}; searchCalls=${allSearches.length}; localBrowser=${browser.success ? 'available' : 'failed'}]`,
    '=== DETERMINISTIC FUTURE FIXTURE CANDIDATES ===',
    'These candidates have a kickoff at or after the current time and are eligible for downstream identity/date verification.',
    serializeFixtureCandidates(deterministic),
    ...parts,
  ].join('\n\n');

  return { success: true, data: payload.slice(0, 120000), source: 'broad_fixture_discovery' };
}
