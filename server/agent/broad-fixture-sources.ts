/**
 * Broad fixture discovery using every available layer: local browser,
 * structured fixture APIs, and search providers. The local browser is a
 * first-class discovery source rather than only a deep-analysis scraper.
 */
import { serpSearch, taloredataSearch, allSportsFixtures, type ToolResult } from './tools.js';
import { localBrowserFixtureDiscovery } from './local-fixture-discovery.js';
import { extractFixtureCandidates, serializeFixtureCandidates } from './fixture-candidate-extractor.js';

const MAX_SEARCH_RESULTS = Number(process.env.MAX_DISCOVERY_FIXTURES || 30);
const MARKET_TIMEZONE = process.env.MARKET_TIMEZONE || 'Africa/Lagos';

function todayInZone(date: Date, timeZone = MARKET_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export async function broadFixtureDiscovery(date: string, sport = 'football'): Promise<ToolResult> {
  if (sport.toLowerCase() !== 'football') {
    return { success: false, data: '', error: 'Broad fixture discovery currently supports football only', source: 'broad_fixture_discovery' };
  }

  const queries = [
    `football fixtures ${date} all leagues today kickoff`,
    `soccer fixtures ${date} today all leagues results schedule`,
    `football matches ${date} Europe Asia Africa South America North America`,
    `football fixtures ${date} site:flashscore.com OR site:sofascore.com OR site:livescore.com`,
    `football fixtures ${date} site:espn.com OR site:bbc.com/sport/football`,
    `football fixtures ${date} site:soccerway.com OR site:footystats.org`,
    `football fixtures ${date} site:worldfootball.net OR site:globalsportsarchive.com`,
  ];

  // Keep the browser, structured feed and search providers running in parallel.
  // One failed provider must never collapse the discovery pool.
  const [browser, api, ...searches] = await Promise.all([
    localBrowserFixtureDiscovery(date, sport),
    allSportsFixtures(date, date),
    ...queries.map(q => serpSearch(q)),
    ...queries.slice(0, 3).map(q => taloredataSearch(q)),
  ]);

  const parts: string[] = [];
  const candidateTexts: string[] = [];
  if (browser.success && browser.data) {
    parts.push(`=== LOCAL BROWSER FIXTURE DISCOVERY ===\n${browser.data}`);
    candidateTexts.push(browser.data);
  }
  if (api.success && api.data) {
    parts.push(`=== STRUCTURED FIXTURE API ===\n${api.data}`);
    candidateTexts.push(api.data);
  }
  searches.forEach((r, i) => {
    if (r.success && r.data) {
      parts.push(`=== DISCOVERY SEARCH ${i + 1} (${r.source || 'search'}) ===\n${r.data}`);
      candidateTexts.push(r.data);
    }
  });

  if (!parts.length) {
    return { success: false, data: '', error: 'All broad fixture sources failed', source: 'broad_fixture_discovery' };
  }

  // IMPORTANT: do not make the LLM the sole source of temporal fixture parsing.
  // Produce a deterministic candidate block from the exact source text. The
  // orchestrator can parse this even when the model returns malformed JSON.
  const candidates = candidateTexts.flatMap((text, i) =>
    extractFixtureCandidates(text, date, MARKET_TIMEZONE, `broad-source-${i + 1}`),
  );
  const deduped = new Map<string, typeof candidates[number]>();
  for (const candidate of candidates) {
    const key = `${candidate.fixture.toLowerCase()}|${candidate.kickoff}`;
    if (!deduped.has(key)) deduped.set(key, candidate);
  }
  const deterministic = [...deduped.values()].slice(0, Math.max(MAX_SEARCH_RESULTS * 3, 90));

  const payload = [
    `[Broad football discovery date=${date}; localDate=${todayInZone(new Date())}; targetPool=${MAX_SEARCH_RESULTS}; localBrowser=${browser.success ? 'available' : 'failed'}]`,
    `=== DETERMINISTIC FIXTURE CANDIDATES ===`,
    `These candidates are extracted directly from source text. They are not model-generated. The orchestrator must still apply the future/live/stale gate before analysis.`,
    serializeFixtureCandidates(deterministic),
    ...parts,
  ].join('\n\n');

  return {
    success: true,
    data: payload.slice(0, 100000),
    source: 'broad_fixture_discovery',
  };
}
