import * as cheerio from 'cheerio';

const DDG_HTML = 'https://html.duckduckgo.com/html/';
const FETCH_TIMEOUT = 10_000;
const MAX_RESULTS = 12;
const MAX_CHARS = 9_000;

export type FeedItem = {
  title: string;
  snippet: string;
  url: string;
  sourceDomain: string;
};

export type DuckDuckGoFeedResult = {
  success: boolean;
  items: FeedItem[];
  data: string;
  error?: string;
  source: 'duckduckgo_feed';
  query: string;
  retrievedAt: string;
};

const cache = new Map<string, { expires: number; value: DuckDuckGoFeedResult }>();
const inflight = new Map<string, Promise<DuckDuckGoFeedResult>>();
const CACHE_TTL = 45_000;

async function fetchTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Odessyus-Quant-Punter/2.1 duckduckgo-feed',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function dedupe(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.url || `${item.title}|${item.snippet}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function format(items: FeedItem[], query: string, retrievedAt: string): string {
  const rows = items.slice(0, MAX_RESULTS).map((item, index) => [
    `#${index + 1} ${item.title}`,
    `URL: ${item.url}`,
    `DOMAIN: ${item.sourceDomain}`,
    `SNIPPET: ${item.snippet}`,
  ].join('\n')).join('\n---\n');
  return `DuckDuckGo lightweight feed\nQUERY: ${query}\nRETRIEVED_AT: ${retrievedAt}\n${rows}`.slice(0, MAX_CHARS);
}

export function duckDuckGoFeedSearch(query: string): Promise<DuckDuckGoFeedResult> {
  const normalized = query.trim().replace(/\s+/g, ' ');
  const key = normalized.toLowerCase();
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
  const pending = inflight.get(key);
  if (pending) return pending;

  const work: Promise<DuckDuckGoFeedResult> = (async () => {
    const retrievedAt = new Date().toISOString();
    try {
      const url = `${DDG_HTML}?${new URLSearchParams({ q: normalized, kl: 'us-en', kp: '-2' })}`;
      const response = await fetchTimeout(url);
      if (!response.ok) {
        const failure: DuckDuckGoFeedResult = {
          success: false,
          items: [],
          data: '',
          error: `DuckDuckGo HTTP ${response.status}`,
          source: 'duckduckgo_feed',
          query: normalized,
          retrievedAt,
        };
        return failure;
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const items: FeedItem[] = [];

      $('.result').each((_, el) => {
        const title = cleanText($(el).find('.result__title').text());
        const snippet = cleanText($(el).find('.result__snippet').text());
        const href = $(el).find('.result__a').attr('href') || $(el).find('a.result__url').attr('href') || '';
        const displayedUrl = cleanText($(el).find('.result__url').text());
        let urlValue = href || displayedUrl;
        if (urlValue.startsWith('//')) urlValue = `https:${urlValue}`;
        if (!/^https?:\/\//i.test(urlValue) && displayedUrl) {
          const candidate = displayedUrl.startsWith('http') ? displayedUrl : `https://${displayedUrl}`;
          urlValue = candidate;
        }
        if (!title && !snippet) return;
        let sourceDomain = '';
        try {
          sourceDomain = new URL(urlValue).hostname.replace(/^www\./, '');
        } catch {
          sourceDomain = displayedUrl.replace(/^https?:\/\//, '').split('/')[0];
        }
        items.push({ title, snippet, url: urlValue, sourceDomain });
      });

      const cleanItems = dedupe(items).slice(0, MAX_RESULTS);
      if (!cleanItems.length) {
        const failure: DuckDuckGoFeedResult = {
          success: false,
          items: [],
          data: '',
          error: 'No DuckDuckGo results',
          source: 'duckduckgo_feed',
          query: normalized,
          retrievedAt,
        };
        return failure;
      }

      const value: DuckDuckGoFeedResult = {
        success: true,
        items: cleanItems,
        data: format(cleanItems, normalized, retrievedAt),
        source: 'duckduckgo_feed',
        query: normalized,
        retrievedAt,
      };
      cache.set(key, { expires: Date.now() + CACHE_TTL, value });
      return value;
    } catch (error) {
      const failure: DuckDuckGoFeedResult = {
        success: false,
        items: [],
        data: '',
        error: String(error),
        source: 'duckduckgo_feed',
        query: normalized,
        retrievedAt,
      };
      return failure;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, work);
  return work;
}
