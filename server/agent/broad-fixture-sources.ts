/**
 * Broad, scraper-independent fixture discovery.
 *
 * This module deliberately does not depend on Soccerway/Flashscore/Puppeteer.
 * Search providers are treated as discovery feeds, while the orchestrator's
 * future-fixture gate remains the authority on whether a match may be analysed.
 */
import { serpSearch, taloredataSearch, allSportsFixtures, type ToolResult } from './tools.js';

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

  const [api, ...searches] = await Promise.all([
    allSportsFixtures(date, date),
    ...queries.map(q => serpSearch(q)),
    ...queries.slice(0, 3).map(q => taloredataSearch(q)),
  ]);

  const parts: string[] = [];
  if (api.success && api.data) parts.push(`=== STRUCTURED FIXTURE API ===\n${api.data}`);
  searches.forEach((r, i) => {
    if (r.success && r.data) parts.push(`=== DISCOVERY SEARCH ${i + 1} (${r.source || 'search'}) ===\n${r.data}`);
  });

  if (!parts.length) {
    return { success: false, data: '', error: 'All broad fixture sources failed', source: 'broad_fixture_discovery' };
  }

  return {
    success: true,
    data: `[Broad football discovery date=${date}; localDate=${todayInZone(new Date())}; targetPool=${MAX_SEARCH_RESULTS}]\n${parts.join('\n\n').slice(0, 60000)}`,
    source: 'broad_fixture_discovery',
  };
}
