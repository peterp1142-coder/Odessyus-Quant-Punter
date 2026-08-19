/**
 * Broad fixture discovery using every available layer: local browser,
 * structured fixture APIs, and search providers. The local browser is now a
 * first-class discovery source rather than only a deep-analysis scraper.
 */
import { serpSearch, taloredataSearch, allSportsFixtures, type ToolResult } from './tools.js';
import { localBrowserFixtureDiscovery } from './local-fixture-discovery.js';

const MAX_SEARCH_RESULTS = Number(process.env.MAX_DISCOVERY_FIXTURES || 30);

function todayInZone(date: Date, timeZone = process.env.MARKET_TIMEZONE || 'Africa/Lagos'): string {
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

  // Run local browser discovery in parallel with API/search discovery. A
  // broken browser source must not collapse the wider discovery pool, while a
  // browser-only source can still rescue matches missed by APIs/search engines.
  const [browser, api, ...searches] = await Promise.all([
    localBrowserFixtureDiscovery(date, sport),
    allSportsFixtures(date, date),
    ...queries.map(q => serpSearch(q)),
    ...queries.slice(0, 3).map(q => taloredataSearch(q)),
  ]);

  const parts: string[] = [];
  if (browser.success && browser.data) parts.push(`=== LOCAL BROWSER FIXTURE DISCOVERY ===\n${browser.data}`);
  if (api.success && api.data) parts.push(`=== STRUCTURED FIXTURE API ===\n${api.data}`);
  searches.forEach((r, i) => {
    if (r.success && r.data) parts.push(`=== DISCOVERY SEARCH ${i + 1} (${r.source || 'search'}) ===\n${r.data}`);
  });

  if (!parts.length) {
    return { success: false, data: '', error: 'All broad fixture sources failed', source: 'broad_fixture_discovery' };
  }

  return {
    success: true,
    data: `[Broad football discovery date=${date}; localDate=${todayInZone(new Date())}; targetPool=${MAX_SEARCH_RESULTS}; localBrowser=${browser.success ? 'available' : 'failed'}]\n${parts.join('\n\n').slice(0, 80000)}`,
    source: 'broad_fixture_discovery',
  };
}
