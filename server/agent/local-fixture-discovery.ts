import { scrape, LIVE_MATCH_SOURCES, type ToolResult } from './tools.js';

const DISCOVERY_SOURCES = LIVE_MATCH_SOURCES.filter((url) =>
  /flashscore|sofascore|livescore|bbc\.com\/sport\/football|skysports|footystats|soccerway|365scores|scoreboard|espn\.com\/soccer|goal\.com\/en\/fixtures|oddsportal|betexplorer|oddschecker|fotmob/i.test(url),
);
const MAX_SOURCE_CHARS = 7000;
const CONFIGURED_CONCURRENCY = Number(process.env.LOCAL_DISCOVERY_CONCURRENCY || 2);
const SOURCE_CONCURRENCY = Math.max(1, Math.min(2, Number.isFinite(CONFIGURED_CONCURRENCY) ? CONFIGURED_CONCURRENCY : 2));
const WAIT_MS = Math.max(2500, Math.min(8000, Number(process.env.LOCAL_DISCOVERY_WAIT_MS || 4500)));
const RSS_HIGH_WATER_MARK = 430 * 1024 * 1024;

/**
 * Sites expose fixture data through different containers. Start with
 * source-specific semantic selectors instead of blindly asking for `body`.
 * The shared scrape() routine still inspects the live DOM and recovers a
 * selector when the site changes.
 */
const SOURCE_SELECTORS: Array<[RegExp, string]> = [
  [/flashscore/i, '#main, main, [role="main"], body'],
  [/sofascore/i, 'main, [role="main"], #content, body'],
  [/livescore/i, 'main, [role="main"], #main, body'],
  [/bbc\.com\/sport\/football/i, 'main, [role="main"], #main-content, body'],
  [/skysports/i, 'main, [role="main"], #main, body'],
  [/footystats/i, 'main, [role="main"], .container, body'],
  [/soccerway/i, '#page_team_1_block_team_matches_10, table.match-table, main, .container, body'],
  [/365scores/i, 'main, [role="main"], #root, .container, body'],
  [/scoreboard\.com/i, 'main, [role="main"], #content, .container, body'],
  [/espn\.com\/soccer/i, 'main, [role="main"], #content, #global-viewport, body'],
  [/goal\.com\/en\/fixtures/i, 'main, [role="main"], #content, .page, body'],
  [/oddsportal/i, 'div.main-bgcolor, main, [role="main"], body'],
  [/betexplorer/i, 'main, [role="main"], #content, body'],
  [/oddschecker/i, 'main, [role="main"], #app, body'],
  [/fotmob/i, 'main, [role="main"], #__next, body'],
];

function selectorsFor(url: string): string {
  return SOURCE_SELECTORS.find(([pattern]) => pattern.test(url))?.[1]
    || 'main, [role="main"], #content, #app, #root, body';
}

function concurrencyForBatch(): number {
  return process.memoryUsage().rss >= RSS_HIGH_WATER_MARK ? 1 : SOURCE_CONCURRENCY;
}

async function scrapeSource(url: string, matchDate: string): Promise<ToolResult> {
  const selector = selectorsFor(url);
  const result = await scrape(url, selector, WAIT_MS);
  if (!result.success) return result;
  return {
    ...result,
    data: `[LOCAL BROWSER DISCOVERY | ${matchDate} | ${url} | selector=${selector}]\n${result.data.slice(0, MAX_SOURCE_CHARS)}`,
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

    // Give Chromium/V8 a chance to reclaim renderer resources between batches.
    await new Promise((resolve) => setTimeout(resolve, 150));
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
