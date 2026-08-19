import { scrape, LIVE_MATCH_SOURCES, type ToolResult } from './tools.js';

const DISCOVERY_SOURCES = LIVE_MATCH_SOURCES.filter((url) =>
  /flashscore|sofascore|livescore|bbc\.com\/sport\/football|skysports|footystats|soccerway|365scores|scoreboard|espn\.com\/soccer|goal\.com\/en\/fixtures|oddsportal|betexplorer|oddschecker|fotmob/i.test(url),
);
const MAX_SOURCE_CHARS = 7000;
const SOURCE_CONCURRENCY = Number(process.env.LOCAL_DISCOVERY_CONCURRENCY || 6);

async function scrapeSource(url: string, matchDate: string): Promise<ToolResult> {
  const result = await scrape(url, 'body', Number(process.env.LOCAL_DISCOVERY_WAIT_MS || 5000));
  if (!result.success) return result;
  return { ...result, data: `[LOCAL BROWSER DISCOVERY | ${matchDate} | ${url}]\n${result.data.slice(0, MAX_SOURCE_CHARS)}`, source: 'local-browser-fixture-discovery' };
}

export async function localBrowserFixtureDiscovery(matchDate: string, sport = 'football'): Promise<ToolResult> {
  if (sport.toLowerCase() !== 'football') return { success: false, data: '', error: 'Local browser fixture discovery currently supports football', source: 'local-browser-fixture-discovery' };
  const successful: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < DISCOVERY_SOURCES.length; i += SOURCE_CONCURRENCY) {
    const batch = DISCOVERY_SOURCES.slice(i, i + SOURCE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((url) => scrapeSource(url, matchDate)));
    results.forEach((result, index) => {
      const url = batch[index];
      if (result.status === 'fulfilled' && result.value.success && result.value.data) successful.push(result.value.data);
      else failed.push(url);
    });
  }
  if (!successful.length) return { success: false, data: '', error: `Local browser could not extract a usable fixture page from ${DISCOVERY_SOURCES.length} discovery sources`, source: 'local-browser-fixture-discovery' };
  return { success: true, data: `[LOCAL BROWSER FIXTURE DISCOVERY]\nDate: ${matchDate}\nSources succeeded: ${successful.length}/${DISCOVERY_SOURCES.length}\nSources requiring fallback/failed: ${failed.length}\n\n${successful.join('\n\n--- LOCAL SOURCE ---\n\n')}`, source: 'local-browser-fixture-discovery' };
}
