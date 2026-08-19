import * as cheerio from 'cheerio';
const SCRAPER_BASE = 'https://odessyuspicks.onrender.com';
const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';
const TALORDATA_SERP = 'https://serpapi.talordata.net/serp/v1/request';
const SERPER_URL = 'https://google.serper.dev/search';
const ALLSPORTS_URL = 'https://apiv2.allsportsapi.com/football/';
// Per-tool timeouts
const FETCH_TIMEOUT = 14_000;
const SCRAPE_TIMEOUT = 45_000;
const SEARCH_TIMEOUT = 12_000;
const MAX_CONTENT = 12_000;
// ─── Talordata SERP key pool ──────────────────────────────────────────────
function buildTaloredataPool() {
    const raw = process.env.SEARCH_APIs || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}
let _taloredataIdx = 0;
// ─── Serper.dev key pool ──────────────────────────────────────────────────
function buildSerperPool() {
    const raw = process.env.SERP_APIs || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}
let _serperIdx = 0;
// ─── AllSportsAPI key pool ────────────────────────────────────────────────
function buildAllSportsPool() {
    const raw = process.env.ALL_SPORTS_APIs || '';
    return raw.split(',').map(k => k.trim()).filter(Boolean);
}
let _allSportsIdx = 0;
// ─── Live-match source dictionary ────────────────────────────────────────
export const LIVE_MATCH_SOURCES = [
    'https://www.flashscore.mobi/',
    'https://m.flashscore.com/',
    'https://m.sofascore.com/football',
    'https://www.livescore.com/en/',
    'https://www.bbc.com/sport/football/scores-fixtures',
    'https://www.skysports.com/football/scores',
    'https://footystats.org/today/',
    'https://www.soccerway.com/',
    'https://www.365scores.com/',
    'https://www.scoreboard.com/en/',
    'https://www.espn.com/soccer/schedule/',
    'https://www.goal.com/en/fixtures',
    'https://www.oddsportal.com/matches/football/',
    'https://www.betexplorer.com/soccer/',
    'https://www.oddschecker.com/football',
    'https://understat.com/',
    'https://fbref.com/en/matches/',
    'https://www.fotmob.com/',
    'https://www.azscore.com/football/today.html',
    'https://www.windrawwin.com/',
    'https://www.predictz.com/',
    'https://www.pinnacle.com/en/soccer/matchups',
];
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
    'User-Agent': DESKTOP_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
};
function isBlocked(text) {
    if (!text || text.length < 400)
        return true;
    const blockSignals = [
        'cloudflare', 'security verification', 'ray id', 'access denied',
        'captcha', 'verify you are human', 'ddos protection', 'just a moment',
        'please wait', 'checking your browser', 'enable javascript',
    ];
    const lower = text.toLowerCase();
    return blockSignals.some(sig => lower.includes(sig));
}
function truncate(text, max = MAX_CONTENT) {
    if (!text)
        return '';
    return text.length > max ? text.substring(0, max) + '\n...[truncated]' : text;
}
async function fetchWithTimeout(url, options, timeout) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return res;
    }
    catch (err) {
        clearTimeout(id);
        throw err;
    }
}
// ─── Tool: serper_search (Google via Serper.dev, key rotation) ───────────
export async function serpSearch(query) {
    const pool = buildSerperPool();
    if (!pool.length) {
        // No Serper keys — fall through to DuckDuckGo
        return webSearch(query);
    }
    for (let attempt = 0; attempt < pool.length; attempt++) {
        const key = pool[_serperIdx % pool.length];
        try {
            const res = await fetchWithTimeout(SERPER_URL, {
                method: 'POST',
                headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: query, num: 10 }),
            }, SEARCH_TIMEOUT);
            if (res.status === 401 || res.status === 403) {
                // Bad key — rotate and try next
                _serperIdx++;
                continue;
            }
            if (!res.ok) {
                _serperIdx++;
                continue;
            }
            const json = await res.json();
            const parts = [];
            if (json.answerBox?.answer)
                parts.push(`[Answer] ${json.answerBox.answer}`);
            if (json.answerBox?.snippet)
                parts.push(`[Snippet] ${json.answerBox.snippet}`);
            if (json.knowledgeGraph?.description)
                parts.push(`[KG] ${json.knowledgeGraph.description}`);
            const organic = json.organic || [];
            if (!organic.length && !parts.length) {
                _serperIdx++;
                continue;
            }
            organic.slice(0, 10).forEach(r => {
                parts.push([r.title, r.snippet, r.link].filter(Boolean).join('\n'));
            });
            const data = parts.join('\n---\n');
            return { success: true, data: truncate(data, 8000), source: 'serper_search' };
        }
        catch {
            _serperIdx++;
        }
    }
    // All keys failed — fall back to DuckDuckGo
    return webSearch(query);
}
// ─── Tool: allsports_fixtures (AllSportsAPI, key rotation) ───────────────
// Fetches scheduled fixtures for a given date range.
// met=Fixtures returns all matches for the date window.
// met=Livescore returns matches currently in progress.
export async function allSportsFixtures(dateFrom, dateTo) {
    const pool = buildAllSportsPool();
    if (!pool.length) {
        return { success: false, data: '', error: 'No ALL_SPORTS_APIs keys configured', source: 'allsports_fixtures' };
    }
    const to = dateTo || dateFrom;
    for (let attempt = 0; attempt < pool.length; attempt++) {
        const key = pool[_allSportsIdx % pool.length];
        try {
            const params = new URLSearchParams({ met: 'Fixtures', APIkey: key, from: dateFrom, to });
            const res = await fetchWithTimeout(`${ALLSPORTS_URL}?${params}`, { headers: { 'Accept': 'application/json' } }, SEARCH_TIMEOUT);
            if (res.status === 401 || res.status === 403) {
                _allSportsIdx++;
                continue;
            }
            if (!res.ok) {
                _allSportsIdx++;
                continue;
            }
            const json = await res.json();
            if (!json.success || !json.result?.length) {
                if (json.error) {
                    _allSportsIdx++;
                    continue;
                }
                return { success: true, data: `No fixtures found for ${dateFrom}–${to}`, source: 'allsports_fixtures' };
            }
            const lines = json.result.map(e => `${e.event_date} ${e.event_time || ''} | ${e.event_home_team} vs ${e.event_away_team}` +
                ` | ${e.event_league_name || e.league_name || ''} (${e.event_country_name || ''})` +
                (e.event_final_result ? ` | Result: ${e.event_final_result}` : '') +
                (e.event_status ? ` | Status: ${e.event_status}` : '') +
                (e.event_stadium ? ` | Venue: ${e.event_stadium}` : ''));
            return {
                success: true,
                data: truncate(`[AllSports Fixtures ${dateFrom}–${to}]\n${lines.join('\n')}`, 12000),
                source: 'allsports_fixtures',
            };
        }
        catch {
            _allSportsIdx++;
        }
    }
    return { success: false, data: '', error: 'All AllSports API keys failed', source: 'allsports_fixtures' };
}
// ─── Tool: allsports_livescore (AllSportsAPI live matches) ────────────────
export async function allSportsLivescore() {
    const pool = buildAllSportsPool();
    if (!pool.length) {
        return { success: false, data: '', error: 'No ALL_SPORTS_APIs keys configured', source: 'allsports_livescore' };
    }
    for (let attempt = 0; attempt < pool.length; attempt++) {
        const key = pool[_allSportsIdx % pool.length];
        try {
            const params = new URLSearchParams({ met: 'Livescore', APIkey: key });
            const res = await fetchWithTimeout(`${ALLSPORTS_URL}?${params}`, { headers: { 'Accept': 'application/json' } }, SEARCH_TIMEOUT);
            if (res.status === 401 || res.status === 403) {
                _allSportsIdx++;
                continue;
            }
            if (!res.ok) {
                _allSportsIdx++;
                continue;
            }
            const json = await res.json();
            if (!json.success || !json.result?.length) {
                return { success: true, data: 'No live matches currently in progress', source: 'allsports_livescore' };
            }
            const lines = json.result.map(e => `${e.event_home_team} ${e.event_home_team_score ?? '-'}:${e.event_away_team_score ?? '-'} ${e.event_away_team}` +
                ` | ${e.event_league_name || ''} (${e.event_country_name || ''})` +
                ` | ${e.event_status || ''} ${e.event_time || ''}`.trimEnd());
            return {
                success: true,
                data: truncate(`[AllSports Livescore]\n${lines.join('\n')}`, 8000),
                source: 'allsports_livescore',
            };
        }
        catch {
            _allSportsIdx++;
        }
    }
    return { success: false, data: '', error: 'All AllSports API keys failed', source: 'allsports_livescore' };
}
// ─── Tool: web_search (DuckDuckGo) ───────────────────────────────────────
export async function webSearch(query) {
    try {
        const params = new URLSearchParams({ q: query });
        const res = await fetchWithTimeout(`${DUCKDUCKGO_URL}?${params}`, { headers: { ...BROWSER_HEADERS } }, SEARCH_TIMEOUT);
        const html = await res.text();
        const $ = cheerio.load(html);
        const results = [];
        $('.result__body').each((_, el) => {
            const title = $(el).find('.result__title').text().trim();
            const snippet = $(el).find('.result__snippet').text().trim();
            const url = $(el).find('a.result__url').text().trim();
            if (title || snippet)
                results.push(`${title}\n${snippet}\n${url}`);
        });
        const data = results.slice(0, 10).join('\n---\n');
        if (!data || data.length < 100) {
            return { success: false, data: '', error: 'No search results', source: 'web_search' };
        }
        return { success: true, data: truncate(data), source: 'web_search' };
    }
    catch (err) {
        return { success: false, data: '', error: String(err), source: 'web_search' };
    }
}
// ─── Tool: talordata_search (SERP API with key rotation) ─────────────────
export async function taloredataSearch(query) {
    const pool = buildTaloredataPool();
    if (!pool.length) {
        return webSearch(query);
    }
    for (let attempt = 0; attempt < pool.length; attempt++) {
        const currentKey = pool[_taloredataIdx % pool.length];
        try {
            const body = new URLSearchParams({ engine: 'google', json: '2', q: query });
            const res = await fetchWithTimeout(TALORDATA_SERP, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${currentKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString(),
            }, SEARCH_TIMEOUT);
            const envelope = await res.json();
            if (envelope.code === 400)
                break;
            if (envelope.code !== 0 || !envelope.data?.json) {
                _taloredataIdx++;
                continue;
            }
            const charMap = envelope.data.json;
            const jsonStr = Object.keys(charMap).sort((a, b) => Number(a) - Number(b)).map(k => charMap[k]).join('');
            const parsed = JSON.parse(jsonStr);
            const organic = parsed.organic || [];
            if (organic.length === 0) {
                _taloredataIdx++;
                continue;
            }
            const data = organic.slice(0, 12).map(r => [r.title, r.description, r.link].filter(Boolean).join('\n')).join('\n---\n');
            return { success: true, data: truncate(data, 6000), source: 'talordata_search' };
        }
        catch {
            _taloredataIdx++;
        }
    }
    return webSearch(query);
}
// ─── Tool: fetch_url ──────────────────────────────────────────────────────
export async function fetchUrl(url, useMobile = false) {
    try {
        const res = await fetchWithTimeout(url, { headers: { ...BROWSER_HEADERS, 'User-Agent': useMobile ? MOBILE_UA : DESKTOP_UA } }, FETCH_TIMEOUT);
        if (!res.ok) {
            return { success: false, data: '', error: `HTTP ${res.status}`, source: 'fetch_url' };
        }
        const html = await res.text();
        const $ = cheerio.load(html);
        $('script, style, nav, header, footer, .ad, .ads, .cookie-banner, [class*="cookie"], [id*="cookie"]').remove();
        const text = $('body').text().replace(/\s+/g, ' ').trim();
        if (!text || text.length < 100) {
            return { success: false, data: '', error: 'Page too short or empty', source: 'fetch_url' };
        }
        return { success: true, data: truncate(text), source: 'fetch_url' };
    }
    catch (err) {
        return { success: false, data: '', error: String(err), source: 'fetch_url' };
    }
}
// ─── Tool: scrape (Stealth Puppeteer via Render service or local Chromium) ──
//
// Browser connection priority:
//   1. BROWSER_WS_URL env → connect to remote browser via WebSocket (e.g. ws://host:3000)
//   2. Local Chromium binary (installed via replit.nix) with --no-sandbox flags
//   3. Legacy HTTP scrape endpoint at SCRAPER_BASE (Render service)
//
// Scrape-first fallback: if the provided selector yields no content, the function
// automatically scrapes the full page body, searches for a CSS selector that
// contains the target data, and retries with the discovered selector.
import puppeteer from 'puppeteer-core';
let _browser = null;
async function getBrowser() {
    if (_browser && _browser.connected)
        return _browser;
    const wsUrl = process.env.BROWSER_WS_URL || '';
    if (wsUrl) {
        _browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
        return _browser;
    }
    // Local Chromium — find the binary installed by replit.nix
    const fs = await import('node:fs');
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/nix/var/nix/profiles/default/bin/chromium',
        '/nix/var/nix/profiles/default/bin/chromium-browser',
    ].filter(Boolean);
    let executablePath = '';
    for (const p of candidates) {
        try {
            if (fs.existsSync(p)) {
                executablePath = p;
                break;
            }
        }
        catch { }
    }
    if (!executablePath)
        executablePath = 'chromium';
    _browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-sync',
            '--disable-extensions',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-hang-monitor',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-client-side-phishing-detection',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-default-browser-check',
            '--no-first-run',
            '--password-store=basic',
            '--use-mock-keychain',
            '--no-service-autorun',
            '--disable-plugins',
            '--disable-plugin-power-saver',
            '--disable-device-discovery-notifications',
            '--disable-translate',
            '--disable-background-timer-throttling',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--disable-background-networking',
        ],
    });
    return _browser;
}
const STEALTH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
async function stealthNavigate(page, url, waitTime) {
    await page.setUserAgent(STEALTH_UA);
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await new Promise(r => setTimeout(r, waitTime));
}
/**
 * Scrape the full page body text and search for a CSS selector whose content
 * matches the expected data pattern. Returns the best selector found.
 */
async function discoverSelector(page, hint) {
    const candidates = await page.evaluate((h) => {
        const elements = Array.from(document.querySelectorAll('div, table, ul, ol, section, article, main, tbody, tr'));
        const scored = [];
        for (const el of elements) {
            const text = el.innerText || '';
            if (text.length < 200 || text.length > 20000)
                continue;
            let score = 0;
            // Look for odds-like patterns (1.xx, 2.xx, 3.xx)
            if (/\b[1-9]\.\d{2}\b/.test(text))
                score += 3;
            // Look for team names or fixture patterns
            if (/[A-Z][a-z]+ [-–] [A-Z][a-z]+/.test(text))
                score += 2;
            // Look for kickoff times
            if (/\b\d{1,2}:\d{2}\b/.test(text))
                score += 2;
            // Look for common odds/fixture keywords
            if (/odds|bet|kickoff|vs|match|fixture|score/i.test(text))
                score += 1;
            // If we have a hint, boost elements containing it
            if (h && text.toLowerCase().includes(h.toLowerCase()))
                score += 5;
            if (score >= 3) {
                const id = el.id;
                const cls = el.className;
                let selector = el.tagName.toLowerCase();
                if (id)
                    selector = `#${id}`;
                else if (cls && typeof cls === 'string') {
                    const firstClass = cls.trim().split(/\s+/)[0];
                    if (firstClass)
                        selector = `${el.tagName.toLowerCase()}.${firstClass.replace(/[^a-zA-Z0-9_-]/g, '')}`;
                }
                scored.push({ selector, score });
            }
        }
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, 5).map(s => s.selector);
    }, hint);
    return candidates?.[0] ?? null;
}
export async function scrape(url, selector, waitTime = 7000) {
    const wsUrl = process.env.BROWSER_WS_URL || '';
    const scraperToken = process.env.PUPPETEER_TOKEN || process.env.SCRAPER_TOKEN || '';
    // ── Path A: Local/WS Puppeteer with scrape-first fallback ──
    if (wsUrl || !scraperToken) {
        let browser = null;
        let page = null;
        try {
            browser = await getBrowser();
            page = await browser.newPage();
            await stealthNavigate(page, url, waitTime);
            // Attempt 1: use the provided selector
            let text = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.innerText : null;
            }, selector);
            // Attempt 2: scrape-first fallback — discover the right selector
            if (!text || text.length < 100) {
                console.log(`[SCRAPE] Selector "${selector}" yielded no data. Discovering correct selector…`);
                const discovered = await discoverSelector(page, url);
                if (discovered && discovered !== selector) {
                    console.log(`[SCRAPE] Found selector "${discovered}". Retrying…`);
                    text = await page.evaluate((sel) => {
                        const el = document.querySelector(sel);
                        return el ? el.innerText : null;
                    }, discovered);
                }
            }
            // Attempt 3: fall back to full body text
            if (!text || text.length < 100) {
                text = await page.evaluate(() => document.body?.innerText ?? '');
            }
            if (!text || text.length < 100) {
                return { success: false, data: '', error: 'Scrape yielded insufficient content', source: 'scrape' };
            }
            if (isBlocked(text)) {
                return { success: false, data: text, blocked: true, error: 'Content blocked', source: 'scrape' };
            }
            return { success: true, data: truncate(text, 14000), source: 'scrape' };
        }
        catch (err) {
            return { success: false, data: '', error: String(err), source: 'scrape' };
        }
        finally {
            if (page)
                await page.close().catch(() => { });
            // Don't close the browser if we connected via WS (shared session)
            if (browser && !wsUrl) {
                await browser.close().catch(() => { });
                _browser = null;
            }
        }
    }
    // ── Path B: Legacy HTTP scrape endpoint (Render service) ──
    const endpoint = scraperToken
        ? `${SCRAPER_BASE}/scrape?token=${encodeURIComponent(scraperToken)}`
        : `${SCRAPER_BASE}/scrape`;
    try {
        const res = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, selector, waitTime }),
        }, SCRAPE_TIMEOUT);
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            return { success: false, data: '', error: `Scraper HTTP ${res.status}: ${body.slice(0, 200)}`, source: 'scrape' };
        }
        const json = await res.json();
        if (json?.status !== 'success' || !json?.data) {
            return { success: false, data: '', error: `Scraper: ${json?.error || JSON.stringify(json).slice(0, 200)}`, source: 'scrape' };
        }
        if (isBlocked(json.data)) {
            return { success: false, data: json.data, blocked: true, error: `Content blocked`, source: 'scrape' };
        }
        return { success: true, data: truncate(json.data, 14000), source: 'scrape' };
    }
    catch (err) {
        return { success: false, data: '', error: String(err), source: 'scrape' };
    }
}
// ─── Tool: scrape_flashscore ───────────────────────────────────────────────
export async function scrapeFlashscore(dateStr) {
    const today = dateStr || new Date().toISOString().slice(0, 10);
    const mobileUrls = [
        'https://www.flashscore.mobi/?d=0&s=1',
        'https://www.flashscore.mobi/?s=2',
        'https://www.flashscore.mobi/',
    ];
    for (const url of mobileUrls) {
        try {
            const res = await fetchWithTimeout(url, { headers: { 'User-Agent': MOBILE_UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' } }, FETCH_TIMEOUT);
            if (!res.ok)
                continue;
            const html = await res.text();
            const $ = cheerio.load(html);
            $('script, style').remove();
            let extracted = '';
            for (const sel of ['#main', '.soccer', 'body']) {
                const text = $(sel).text().replace(/\s+/g, ' ').trim();
                if (text.length > 500) {
                    extracted = text;
                    break;
                }
            }
            if (!extracted || isBlocked(extracted))
                continue;
            const hasMatches = /\d{1,2}:\d{2}|\b[A-Z][a-zA-Z]+ [-–] [A-Z][a-zA-Z]+/.test(extracted);
            if (!hasMatches && extracted.length < 1000)
                continue;
            return { success: true, data: `[Date: ${today}] [Source: ${url}]\n${truncate(extracted, 12000)}`, source: 'flashscore:static' };
        }
        catch { /* try next */ }
    }
    console.log('[TOOL] scrapeFlashscore: static failed, trying puppeteer');
    const puppeteerResult = await scrape('https://www.flashscore.mobi/?d=0&s=1', '#main', 6000);
    if (puppeteerResult.success) {
        return { ...puppeteerResult, data: `[Date: ${today}] [Source: flashscore.mobi:puppeteer]\n${puppeteerResult.data}`, source: 'flashscore:puppeteer' };
    }
    const fsResult = await scrape('https://www.flashscore.com/football/', '.leagues--live, .event__match, body', 7000);
    if (fsResult.success) {
        return { ...fsResult, data: `[Date: ${today}] [Source: flashscore.com:puppeteer]\n${fsResult.data}`, source: 'flashscore:puppeteer' };
    }
    return { success: false, data: '', error: 'All flashscore sources failed', source: 'flashscore' };
}
// ─── Tool: fetch_matches_today ────────────────────────────────────────────
export async function fetchMatchesToday(sport = 'football', dateStr) {
    const today = dateStr || new Date().toISOString().slice(0, 10);
    const flashscoreResult = scrapeFlashscore(dateStr);
    const staticSources = [
        { url: 'https://www.livescore.com/en/', mobile: false },
        { url: 'https://www.livescore.in/', mobile: true },
        { url: 'https://www.bbc.com/sport/football/scores-fixtures', mobile: false },
        { url: 'https://www.azscore.com/football/today.html', mobile: false },
        { url: 'https://www.scoreboard.com/en/', mobile: false },
        { url: 'https://www.livescores.biz/', mobile: false },
        { url: 'https://footystats.org/today/', mobile: false },
        { url: 'https://www.soccer24.com/', mobile: false },
    ];
    const [flashResult, ...staticResults] = await Promise.allSettled([
        flashscoreResult,
        ...staticSources.map(({ url, mobile }) => fetchUrl(url, mobile)),
    ]);
    const collected = [];
    if (flashResult.status === 'fulfilled' && flashResult.value.success) {
        collected.push(`=== FLASHSCORE ===\n${flashResult.value.data}`);
    }
    staticResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success && !r.value.blocked && r.value.data.length >= 500) {
            collected.push(`=== ${staticSources[i].url} ===\n${r.value.data.substring(0, 4000)}`);
        }
    });
    if (collected.length > 0) {
        return { success: true, data: `[Date: ${today}] [Sport: ${sport}]\n${collected.join('\n\n').substring(0, 20000)}`, source: 'fetch_matches_today:parallel' };
    }
    // Tier 2: Puppeteer
    const puppeteerSources = [
        { url: 'https://www.sofascore.com/football', selector: '.sc-hLBbgP, body', waitTime: 7000 },
        { url: 'https://www.espn.com/soccer/schedule/', selector: '.ScheduleTable, body', waitTime: 5000 },
        { url: 'https://www.oddsportal.com/matches/football/', selector: '.table-main, body', waitTime: 6000 },
    ];
    const puppeteerResults = await Promise.allSettled(puppeteerSources.map(({ url, selector, waitTime }) => scrape(url, selector, waitTime)));
    puppeteerResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success && !r.value.blocked) {
            collected.push(`=== ${puppeteerSources[i].url} ===\n${r.value.data.substring(0, 4000)}`);
        }
    });
    if (collected.length > 0) {
        return { success: true, data: `[Date: ${today}] [Sport: ${sport}]\n${collected.join('\n\n').substring(0, 20000)}`, source: 'fetch_matches_today:puppeteer' };
    }
    const q = `football matches fixtures today ${today} kickoff times schedule`;
    const searchResult = await taloredataSearch(q);
    return { ...searchResult, source: 'fetch_matches_today:search' };
}
// ─── Tool: multi_source_odds ──────────────────────────────────────────────
export async function multiSourceOdds(fixture) {
    const encoded = encodeURIComponent(fixture);
    const puppeteerTargets = [
        { url: `https://www.oddsportal.com/search/results/?q=${encoded}`, selector: '.table-main, body', waitTime: 7000 },
        { url: `https://www.betexplorer.com/results/?sport=soccer&q=${encoded}`, selector: 'body', waitTime: 6000 },
        { url: `https://www.oddschecker.com/football`, selector: 'body', waitTime: 6000 },
        { url: `https://www.pinnacle.com/en/soccer/matchups`, selector: 'body', waitTime: 8000 },
    ];
    const staticTargets = [
        `https://www.tipsscore.com/football/odds`,
        `https://www.betshoot.com/`,
        `https://www.bettingexpert.com/en/football`,
    ];
    const combined = [];
    const [puppeteerResults, staticResults] = await Promise.all([
        Promise.allSettled(puppeteerTargets.map(({ url, selector, waitTime }) => scrape(url, selector, waitTime))),
        Promise.allSettled(staticTargets.map(url => fetchUrl(url))),
    ]);
    puppeteerResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success && !r.value.blocked) {
            combined.push(`--- ${puppeteerTargets[i].url} ---\n${r.value.data.substring(0, 3000)}`);
        }
    });
    staticResults.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success && !r.value.blocked) {
            combined.push(`--- ${staticTargets[i]} ---\n${r.value.data.substring(0, 2000)}`);
        }
    });
    if (combined.length) {
        return { success: true, data: truncate(combined.join('\n\n'), 16000), source: 'multi_source_odds' };
    }
    return taloredataSearch(`${fixture} odds today site:oddsportal.com OR site:betexplorer.com OR site:pinnacle.com`);
}
// ─── Tool: fetch_fbref_stats ──────────────────────────────────────────────
// Dedicated FBref scraper for xG, form, and advanced stats
export async function fetchFbrefStats(team, league) {
    const teamSlug = team.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const leagueSlug = (league || 'premier-league').toLowerCase().replace(/\s+/g, '-');
    // Try direct team stats page first
    const searchQuery = `${team} xG stats ${new Date().getFullYear()} site:fbref.com`;
    const searchResult = await taloredataSearch(searchQuery);
    if (searchResult.success && searchResult.data.length > 200) {
        // Extract fbref URL from search results and fetch it
        const urlMatch = searchResult.data.match(/fbref\.com\/en\/squads\/[^\s"]+/);
        if (urlMatch) {
            const fbrefUrl = `https://www.${urlMatch[0]}`;
            const pageResult = await scrape(fbrefUrl, '#stats_shooting, #stats_standard, body', 8000);
            if (pageResult.success) {
                return { ...pageResult, data: `[FBref Stats: ${team}]\n${pageResult.data.substring(0, 10000)}`, source: 'fetch_fbref_stats' };
            }
        }
    }
    // Fallback: direct URL attempt
    const directResult = await scrape(`https://fbref.com/en/squads/${teamSlug}/`, '#stats_shooting, #stats_standard, body', 8000);
    if (directResult.success) {
        return { ...directResult, data: `[FBref: ${team}]\n${directResult.data.substring(0, 10000)}`, source: 'fetch_fbref_stats' };
    }
    return { ...searchResult, source: 'fetch_fbref_stats:search' };
}
// ─── Tool: fetch_understat_xg ─────────────────────────────────────────────
// Dedicated Understat scraper for xG data
export async function fetchUnderstatXg(team) {
    // Understat uses full team names — search for the page first
    const searchQuery = `${team} understat xG per game season ${new Date().getFullYear()}`;
    const searchResult = await taloredataSearch(searchQuery);
    if (searchResult.success) {
        // Also try direct fetch
        const teamSlug = team.replace(/\s+/g, '_');
        const directResult = await fetchUrl(`https://understat.com/team/${teamSlug}`);
        if (directResult.success) {
            return { ...directResult, data: `[Understat xG: ${team}]\n${directResult.data.substring(0, 8000)}`, source: 'fetch_understat_xg' };
        }
    }
    return { ...searchResult, source: 'fetch_understat_xg:search' };
}
// ─── Tool: fetch_lineups ──────────────────────────────────────────────────
// Dedicated lineup fetcher from multiple sources
export async function fetchLineups(fixture) {
    const today = new Date().toISOString().split('T')[0];
    const encoded = encodeURIComponent(fixture);
    // Search for confirmed lineups
    const queries = [
        `${fixture} confirmed starting lineup ${today}`,
        `${fixture} team news predicted XI ${today}`,
    ];
    const [r1, r2] = await Promise.allSettled([
        taloredataSearch(queries[0]),
        scrape(`https://www.sofascore.com/search/events/${encoded}`, 'body', 8000),
    ]);
    const combined = [];
    if (r1.status === 'fulfilled' && r1.value.success)
        combined.push(r1.value.data.substring(0, 4000));
    if (r2.status === 'fulfilled' && r2.value.success && !r2.value.blocked)
        combined.push(r2.value.data.substring(0, 4000));
    if (combined.length > 0) {
        return { success: true, data: combined.join('\n---\n'), source: 'fetch_lineups' };
    }
    return taloredataSearch(queries[1]);
}
// ─── Tool: calculate_kelly ────────────────────────────────────────────────
// Pure math — Kelly Criterion calculator
export async function calculateKelly(trueProbability, decimalOdds, bankroll = 1000) {
    if (decimalOdds <= 1 || trueProbability <= 0 || trueProbability >= 1) {
        return { success: false, data: '', error: 'Invalid inputs for Kelly Criterion' };
    }
    const b = decimalOdds - 1;
    const q = 1 - trueProbability;
    const fullKelly = Math.max(0, (b * trueProbability - q) / b);
    const halfKelly = fullKelly / 2;
    const quarterKelly = fullKelly / 4;
    const ev = trueProbability * decimalOdds - 1;
    const result = {
        true_probability: (trueProbability * 100).toFixed(1) + '%',
        decimal_odds: decimalOdds,
        implied_prob: ((1 / decimalOdds) * 100).toFixed(1) + '%',
        edge: (ev * 100).toFixed(2) + '%',
        full_kelly_pct: (fullKelly * 100).toFixed(2) + '%',
        full_kelly_amount: (fullKelly * bankroll).toFixed(2),
        half_kelly_pct: (halfKelly * 100).toFixed(2) + '%',
        half_kelly_amount: (halfKelly * bankroll).toFixed(2),
        quarter_kelly_pct: (quarterKelly * 100).toFixed(2) + '%',
        recommendation: fullKelly <= 0
            ? 'NO BET — negative expected value'
            : fullKelly < 0.02
                ? 'MICRO STAKE only — edge too thin'
                : fullKelly < 0.05
                    ? `SMALL STAKE: ${(halfKelly * 100).toFixed(1)}% of bankroll (half-Kelly)`
                    : fullKelly < 0.15
                        ? `STANDARD STAKE: ${(halfKelly * 100).toFixed(1)}% of bankroll (half-Kelly)`
                        : `STRONG STAKE: ${(quarterKelly * 100).toFixed(1)}% of bankroll (quarter-Kelly, capped for risk)`,
    };
    return {
        success: true,
        data: JSON.stringify(result, null, 2),
        source: 'calculate_kelly',
    };
}
// ─── Tool: book_slip ───────────────────────────────────────────────────────
export async function bookSlip(url, selector, waitTime = 7000) {
    return scrape(url, selector, waitTime);
}
// ─── Tool: place_bet ──────────────────────────────────────────────────────
export async function placeBetTool(input) {
    try {
        const { placeBet } = await import('../booking/engine.js');
        const result = await placeBet({
            platform: String(input.platform || process.env.BOOKING_PLATFORM || 'sportybet'),
            fixture: String(input.fixture || ''),
            market: String(input.market || 'Match Result'),
            selection: String(input.selection || ''),
            minOdds: Number(input.min_odds ?? input.minOdds ?? 1.5),
            stakeUnits: Number(input.stake_units ?? input.stakeUnits ?? 1),
        });
        if (result.success) {
            return {
                success: true,
                data: `✅ BET PLACED\nPlatform: ${result.platform}\nBet ID: ${result.betId || 'N/A'}\nStake: ${result.stakeAmount}\nOdds: ${result.oddsObtained}\nReturn: ${result.potentialReturn}\n${result.confirmationText}`,
                source: 'place_bet',
            };
        }
        return { success: false, data: '', error: result.reason || result.error || 'Booking failed', source: 'place_bet' };
    }
    catch (err) {
        return { success: false, data: '', error: `Booking engine: ${String(err)}`, source: 'place_bet' };
    }
}
// ─── URL block registry ────────────────────────────────────────────────────
const BLOCKED_URLS = new Map();
const BLOCK_TTL_MS = 60_000;
function isUrlBlocked(url) {
    const until = BLOCKED_URLS.get(url) ?? 0;
    if (Date.now() < until)
        return true;
    BLOCKED_URLS.delete(url);
    return false;
}
function markUrlBlocked(url) {
    BLOCKED_URLS.set(url, Date.now() + BLOCK_TTL_MS);
}
function classifyUrl(url) {
    const u = url.toLowerCase();
    if (u.includes('oddsportal') || u.includes('sportybet') || u.includes('oddschecker') ||
        u.includes('betexplorer') || u.includes('betway') || u.includes('pinnacle'))
        return 'odds';
    if (u.includes('transfermarkt') || u.includes('premierinjuries') || u.includes('physioroom') || u.includes('sofascore'))
        return 'lineup';
    if (u.includes('soccerway') || u.includes('fbref') || u.includes('flashscore'))
        return 'h2h';
    if (u.includes('footystats') || u.includes('understat') || u.includes('whoscored'))
        return 'stats';
    if (u.includes('bbc') || u.includes('skysports') || u.includes('goal.com'))
        return 'news';
    return 'other';
}
function buildFallbackQuery(url, toolInput) {
    const kind = classifyUrl(url);
    const base = String(toolInput.fixture || toolInput.query || '');
    switch (kind) {
        case 'odds': return `${base} odds bookmaker comparison today`;
        case 'lineup': return `${base} confirmed lineup starting XI today`;
        case 'h2h': return `${base} head to head record soccerway`;
        case 'stats': return `${base} xG stats form this season`;
        case 'news': return `${base} team news injury latest`;
        default: return base || url;
    }
}
// ─── Tool Dispatcher ───────────────────────────────────────────────────────
export async function dispatchTool(toolName, toolInput) {
    console.log(`[TOOL] ${toolName}:`, JSON.stringify(toolInput).substring(0, 120));
    switch (toolName) {
        case 'web_search':
            return webSearch(String(toolInput.query || ''));
        case 'serper_search':
            return serpSearch(String(toolInput.query || ''));
        case 'talordata_search':
            return taloredataSearch(String(toolInput.query || ''));
        case 'allsports_fixtures':
            return allSportsFixtures(String(toolInput.date || toolInput.from || new Date().toISOString().slice(0, 10)), toolInput.to ? String(toolInput.to) : undefined);
        case 'allsports_livescore':
            return allSportsLivescore();
        case 'fetch_url': {
            const url = String(toolInput.url || '');
            if (isUrlBlocked(url)) {
                return taloredataSearch(buildFallbackQuery(url, toolInput));
            }
            const result = await fetchUrl(url, Boolean(toolInput.mobile));
            if (!result.success || result.blocked) {
                markUrlBlocked(url);
                return taloredataSearch(buildFallbackQuery(url, toolInput));
            }
            return result;
        }
        case 'scrape': {
            const url = String(toolInput.url || '');
            if (isUrlBlocked(url)) {
                return taloredataSearch(buildFallbackQuery(url, toolInput));
            }
            const result = await scrape(url, String(toolInput.selector || 'body'), Number(toolInput.waitTime ?? 7000));
            if (!result.success || result.blocked) {
                markUrlBlocked(url);
                return taloredataSearch(buildFallbackQuery(url, toolInput));
            }
            return result;
        }
        case 'book_slip':
            return bookSlip(String(toolInput.url || toolInput.bookmaker_url || ''), String(toolInput.selector || 'body'), Number(toolInput.waitTime ?? 7000));
        case 'fetch_matches_today':
            return fetchMatchesToday(String(toolInput.sport || 'football'), String(toolInput.date || ''));
        case 'scrape_flashscore':
            return scrapeFlashscore(String(toolInput.date || ''));
        case 'multi_source_odds':
            return multiSourceOdds(String(toolInput.fixture || toolInput.query || ''));
        case 'fetch_fbref_stats':
            return fetchFbrefStats(String(toolInput.team || toolInput.fixture || ''), String(toolInput.league || ''));
        case 'fetch_understat_xg':
            return fetchUnderstatXg(String(toolInput.team || ''));
        case 'fetch_lineups':
            return fetchLineups(String(toolInput.fixture || ''));
        case 'calculate_kelly':
            return calculateKelly(Number(toolInput.true_probability || toolInput.prob || 0), Number(toolInput.decimal_odds || toolInput.odds || 0), Number(toolInput.bankroll || 1000));
        case 'place_bet':
            return placeBetTool(toolInput);
        default:
            return { success: false, data: '', error: `Unknown tool: ${toolName}` };
    }
}
//# sourceMappingURL=tools.js.map