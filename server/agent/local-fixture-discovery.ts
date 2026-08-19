import { scrape, LIVE_MATCH_SOURCES, type ToolResult } from './tools.js';

const DISCOVERY_SOURCES = LIVE_MATCH_SOURCES.filter((url) =>
  /flashscore|sofascore|livescore|bbc\.com\/sport\/football|skysports|footystats|soccerway|365scores|scoreboard|espn\.com\/soccer|goal\.com\/en\/fixtures|oddsportal|betexplorer|oddschecker|fotmob/i.test(url),
);
const MAX_SOURCE_CHARS = 7000;
// Render's 512 MB instance limit makes six simultaneous Chromium pages too expensive.
// Keep parallelism, but default to two pages and never allow an accidental high setting.
const CONFIGURED_CONCURRENCY = Number(process.env.LOCAL_DISCOVERY_CONCURRENCY || 2);
const SOURCE_CONCURRENCY = Math.max(1, Math.min(3, Number.isFinite(CONFIGURED_CONCURRENCY) ? CONFIGURED_CONCURRENCY : 2));
const WAIT_MS = Math.max(1500, Math.min(5000, Number(process.env.LOCAL_DISCOVERY_WAIT_MS || 3500)));
const RSS_HIGH_WATER_MARK = 430 * 1024 * 1024;

function concurrencyForBatch(): number {
  const rss = process.memoryUsage().rss;
  // If Node is already close to Render's 512 MB ceiling, finish the current work
  // with a single browser page rather than opening more Chromium renderer processes.
  return rss >= RSS_HIGH_WATER_MARK ? 1 : SOURCE_CONCURRENCY;
}

async function scrapeSource(url: string, matchDate: string): Promise<ToolResult> {
  const result = await scrape(url, 'body', WAIT_MS);
  if (!result.success) return result;
  return {
    ...result,
    data: `[LOCAL BROWSER DISCOVERY | ${matchDate} | ${url}]\n${result.data.slice(0, MAX_SOURCE_CHARS)}`,
    source: 'local-browser-fixture-discovery',
  };
}

export async function localBrowserFixtureDiscovery(matchDate: string, sport = 'football'): Promise<ToolResult> {
  if (sport.toLowerCase() !== 'football') {
    return {
      success: false,
      data: '',
      error: 'Local browser fixture discovery currently supports football',
      source: 'local-browser-fixture-discovery',
    };
  }

  const successful: string[] = [];
  const failed: string[] = [];

  for (let i = 0; i < DISCOVERY_SOURCES.length;) {
    const concurrency = concurrencyForBatch();
    const batch = DISCOVERY_SOURCES.slice(i, i + concurrency);
    i += batch.length;

    const results = await Promise.allSettled(batch.map((url) => scrapeSource(url, matchDate)));
    results.forEach((result, index) => {
      const url = batch[index];
      if (result.status === 'fulfilled' && result.value.success && result.value.data) {
        successful.push(result.value.data);
      } else {
        failed.push(url);
      }
    });

    // Give V8/Chromium a chance to release renderer resources between batches.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!successful.length) {
    return {
      success: false,
      data: '',
      error: `Local browser could not extract a usable fixture page from ${DISCOVERY_SOURCES.length} discovery sources`,
      source: 'local-browser-fixture-discovery',
    };
  }

  return {
    success: true,
    data: `[LOCAL BROWSER FIXTURE DISCOVERY]\nDate: ${matchDate}\nSources succeeded: ${successful.length}/${DISCOVERY_SOURCES.length}\nSources requiring fallback/failed: ${failed.length}\n\n${successful.join('\n\n--- LOCAL SOURCE ---\n\n')}`,
    source: 'local-browser-fixture-discovery',
  };
}
