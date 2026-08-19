/**
 * Odessyus Booking Engine — Puppeteer-powered bet placement
 *
 * Uses puppeteer-core + system Chromium to execute platform-specific
 * login → search → betslip → stake → confirm flows.
 *
 * Credentials are read from env vars:
 *   BOOKING_PLATFORM   = 'sportybet' (default platform)
 *   BOOKING_USERNAME   = platform login username/phone
 *   BOOKING_PASSWORD   = platform login password
 *   BOOKING_STAKE_UNIT = 10 (currency units per stake unit)
 *   BROWSER_WS_URL     = ws://host:port (remote browser, optional)
 *
 * Scrape-then-select fallback: when a configured CSS selector fails to match,
 * the engine scrapes the page body, discovers the correct selector by
 * analysing element content patterns, and retries automatically.
 */

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { getPlatform } from './platforms.js';
import type { BookingRequest, BookingResult, PlatformConfig } from './types.js';

// Browser instance pool (one per process)
let activeBrowser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (activeBrowser) {
    try {
      await activeBrowser.version();
      return activeBrowser;
    } catch {
      activeBrowser = null;
    }
  }

  // Priority 1: connect to remote browser via WebSocket (BROWSER_WS_URL env)
  const wsUrl = process.env.BROWSER_WS_URL || '';
  if (wsUrl) {
    try {
      activeBrowser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      console.log('[Booking] Connected to remote browser via WS:', wsUrl);
      return activeBrowser;
    } catch (err) {
      console.warn('[Booking] WS connect failed, falling back to local:', err instanceof Error ? err.message : String(err));
    }
  }

  // Priority 2: local Chromium binary
  const fs = await import('node:fs');
  const chromePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH || '',
    process.env.CHROME_PATH || '',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/nix/var/nix/profiles/default/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium-browser',
  ].filter(Boolean);

  let executablePath = '';
  for (const p of chromePaths) {
    try { if (fs.existsSync(p)) { executablePath = p; break; } } catch {}
  }

  // Fall back to nix store glob search
  if (!executablePath) {
    try {
      const { execSync } = await import('child_process');
      const found = execSync('find /nix/store -name "chromium" -type f -path "*/bin/*" 2>/dev/null | head -1').toString().trim();
      if (found) executablePath = found;
    } catch { /* ignore */ }
  }

  if (!executablePath) {
    try {
      const { execSync } = await import('child_process');
      const found = execSync('which chromium || which chromium-browser || which google-chrome 2>/dev/null').toString().trim();
      if (found) executablePath = found.split('\n')[0];
    } catch { /* ignore */ }
  }

  console.log('[Booking] Using Chromium at:', executablePath || 'default');

  const browser = await puppeteer.launch({
    executablePath: executablePath || undefined,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1280,900',
      '--disable-blink-features=AutomationControlled',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  activeBrowser = browser;
  return browser;
}

async function closeBrowser() {
  if (activeBrowser) {
    await activeBrowser.close().catch(() => {});
    activeBrowser = null;
  }
}

async function delay(ms: number) {
  return new Promise(res => setTimeout(res, ms));
}

async function screenshot(page: Page): Promise<string> {
  try {
    const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
    return Buffer.from(buf).toString('base64');
  } catch { return ''; }
}

// ─── Scrape-then-select fallback ─────────────────────────────────────────────
//
// When a configured selector fails, we scrape the page and search for an
// element whose content matches the expected pattern. This makes the booking
// engine resilient to platform UI changes without requiring selector updates.

type SelectorKind = 'username' | 'password' | 'loginButton' | 'searchBox'
  | 'stakeInput' | 'confirmButton' | 'confirmationMsg' | 'cookieBanner';

/**
 * Discover the correct CSS selector by analysing page content.
 * Returns the best selector found, or null if nothing matches.
 */
async function discoverSelectorBooking(
  page: Page,
  kind: SelectorKind,
  hint?: string,
): Promise<string | null> {
  const result = await page.evaluate((k: string, h?: string) => {
    const scored: Array<{ selector: string; score: number }> = [];

    function makeSelector(el: Element): string {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const cls = (el as HTMLElement).className;
      if (cls && typeof cls === 'string') {
        const firstClass = cls.trim().split(/\s+/)[0];
        if (firstClass) return `${el.tagName.toLowerCase()}.${firstClass.replace(/[^a-zA-Z0-9_-]/g, '')}`;
      }
      return el.tagName.toLowerCase();
    }

    const elements = Array.from(document.querySelectorAll<HTMLElement>(
      'input, button, a, div, span, [role="button"], [role="textbox"], [contenteditable]',
    ));

    for (const el of elements) {
      const text = el.innerText || el.textContent || '';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const name = (el.getAttribute('name') || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const cls = ((el as HTMLElement).className || '').toLowerCase();
      let score = 0;

      switch (k) {
        case 'username':
          if (type === 'email' || type === 'tel' || type === 'text') score += 3;
          if (placeholder.includes('email') || placeholder.includes('phone') || placeholder.includes('user') || placeholder.includes('account')) score += 4;
          if (name.includes('email') || name.includes('phone') || name.includes('user') || name.includes('login')) score += 4;
          if (cls.includes('user') || cls.includes('email') || cls.includes('phone') || cls.includes('login')) score += 2;
          if (el.tagName === 'INPUT') score += 1;
          break;
        case 'password':
          if (type === 'password') score += 10;
          if (name.includes('pass') || name.includes('pwd')) score += 3;
          if (placeholder.includes('password') || placeholder.includes('pass')) score += 3;
          break;
        case 'loginButton':
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 2;
          if (type === 'submit') score += 5;
          if (text.match(/log\s*in|sign\s*in|enter|submit|continue/i)) score += 5;
          if (cls.includes('login') || cls.includes('submit') || cls.includes('btn')) score += 2;
          break;
        case 'searchBox':
          if (el.tagName === 'INPUT') score += 2;
          if (type === 'search' || type === 'text') score += 2;
          if (placeholder.includes('search') || placeholder.includes('find') || placeholder.includes('team') || placeholder.includes('match')) score += 4;
          if (name.includes('search') || name.includes('query')) score += 3;
          if (cls.includes('search')) score += 2;
          break;
        case 'stakeInput':
          if (el.tagName === 'INPUT') score += 3;
          if (type === 'number' || type === 'text') score += 2;
          if (placeholder.includes('stake') || placeholder.includes('amount') || placeholder.includes('bet')) score += 5;
          if (name.includes('stake') || name.includes('amount')) score += 3;
          if (cls.includes('stake') || cls.includes('amount')) score += 2;
          if (ariaLabel.includes('stake') || ariaLabel.includes('amount')) score += 3;
          break;
        case 'confirmButton':
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 2;
          if (type === 'submit') score += 3;
          if (text.match(/place\s*bet|confirm|submit|bet\s*now|accept/i)) score += 6;
          if (cls.includes('place') || cls.includes('confirm') || cls.includes('submit') || cls.includes('bet')) score += 3;
          break;
        case 'confirmationMsg':
          if (text.match(/success|confirmed|accepted|placed|bet\s*id|booking|ticket|receipt|reference/i)) score += 5;
          if (cls.includes('success') || cls.includes('confirm') || cls.includes('receipt') || cls.includes('message')) score += 3;
          if (text.length > 10 && text.length < 500) score += 1;
          break;
        case 'cookieBanner':
          if (text.match(/cookie|consent|accept\s*all|agree/i)) score += 5;
          if (el.tagName === 'BUTTON') score += 2;
          if (cls.includes('cookie') || cls.includes('consent') || cls.includes('gdpr')) score += 3;
          break;
      }

      // Hint boost
      if (h && (text.toLowerCase().includes(h.toLowerCase()) || placeholder.includes(h.toLowerCase()) || name.includes(h.toLowerCase()))) {
        score += 5;
      }

      if (score >= 4) {
        scored.push({ selector: makeSelector(el), score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(s => s.selector);
  }, kind, hint);

  return result?.[0] ?? null;
}

/**
 * Wait for a selector with fallback: try the configured selector first,
 * then scrape the page to discover the correct one if it fails.
 */
async function waitForSelectorWithFallback(
  page: Page,
  primarySelector: string,
  kind: SelectorKind,
  timeout = 10000,
  hint?: string,
): Promise<string> {
  // Attempt 1: configured selector
  try {
    await page.waitForSelector(primarySelector, { timeout: Math.min(timeout, 5000) });
    return primarySelector;
  } catch { /* fall through to discovery */ }

  // Attempt 2: scrape page and discover the correct selector
  console.log(`[Booking] Selector "${primarySelector}" (${kind}) failed. Discovering correct selector…`);
  const discovered = await discoverSelectorBooking(page, kind, hint);
  if (discovered) {
    console.log(`[Booking] Discovered selector "${discovered}" for ${kind}`);
    try {
      await page.waitForSelector(discovered, { timeout: 4000 });
      return discovered;
    } catch { /* fall through */ }
  }

  // Attempt 3: try each comma-separated alternative from the original selector
  const alternatives = primarySelector.split(',').map(s => s.trim());
  for (const alt of alternatives) {
    try {
      await page.waitForSelector(alt, { timeout: 2000 });
      return alt;
    } catch { /* try next */ }
  }

  throw new Error(`Could not find ${kind} selector (tried "${primarySelector}" + discovery)`);
}

async function dismissCookies(page: Page, platform: PlatformConfig) {
  const sel = platform.selectors.cookieBanner;
  if (!sel) return;
  try {
    const found = await waitForSelectorWithFallback(page, sel, 'cookieBanner', 4000);
    await page.click(found);
    await delay(1000);
  } catch { /* no cookie banner */ }
}

async function login(page: Page, platform: PlatformConfig, username: string, password: string): Promise<boolean> {
  try {
    await page.goto(platform.loginUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await dismissCookies(page, platform);
    await delay(1500);

    // Username — with scrape-then-select fallback
    const usernameSel = await waitForSelectorWithFallback(page, platform.selectors.usernameInput, 'username', 10000, 'email');
    await page.click(usernameSel);
    await page.type(usernameSel, username, { delay: 60 });
    await delay(500);

    // Password — with scrape-then-select fallback
    const passwordSel = await waitForSelectorWithFallback(page, platform.selectors.passwordInput, 'password', 8000);
    await page.click(passwordSel);
    await page.type(passwordSel, password, { delay: 60 });
    await delay(500);

    // Submit — with scrape-then-select fallback
    const loginBtnSel = await waitForSelectorWithFallback(page, platform.selectors.loginButton, 'loginButton', 8000, 'login');
    await page.click(loginBtnSel);
    await page.waitForNavigation({ timeout: 15000, waitUntil: 'networkidle2' }).catch(() => {});
    await delay(2000);

    // Verify login succeeded (no login form visible)
    const stillLogin = await page.$(platform.selectors.loginButton).catch(() => null);
    const stillPasswordInput = await page.$(platform.selectors.passwordInput).catch(() => null);
    return !stillPasswordInput || !stillLogin;
  } catch (err) {
    console.error('[Booking] Login error:', err);
    return false;
  }
}

async function findAndBookSportyBet(
  page: Page,
  req: BookingRequest,
  platform: PlatformConfig
): Promise<{ oddsObtained: number; betId: string; confirmText: string }> {
  // Search for the fixture
  const searchUrl = `${platform.baseUrl}/ng/#/sport/soccer?keyword=${encodeURIComponent(req.fixture)}`;
  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
  await delay(3000);

  // Try to use search box if available — with fallback
  if (platform.selectors.searchBox) {
    try {
      const searchSel = await waitForSelectorWithFallback(page, platform.selectors.searchBox, 'searchBox', 5000, 'search');
      await page.click(searchSel);
      await page.type(searchSel, req.fixture, { delay: 50 });
      await delay(2000);
    } catch { /* no search box */ }
  }

  // Find an element matching our selection text
  const selectionEl = await page.evaluateHandle((selectionText: string, market: string) => {
    const allEls = Array.from(document.querySelectorAll('*'));
    return allEls.find(el =>
      el.textContent?.includes(selectionText) &&
      (el.classList.contains('odd') || el.classList.contains('odds') ||
       el.getAttribute('data-odd') || el.closest('[class*="odds"]'))
    ) || null;
  }, req.selection, req.market);

  let oddsObtained = 0;

  if (selectionEl) {
    // Get odds text before clicking
    const oddsText = await page.evaluate((el) => {
      const oddsEl = el?.querySelector('[class*="odds"], .price, .coefficient') ||
                     el?.closest('[class*="odd"]')?.querySelector('[class*="price"]') ||
                     el;
      return oddsEl?.textContent?.trim() || '';
    }, selectionEl);

    const parsedOdds = parseFloat(oddsText.replace(',', '.'));
    if (!isNaN(parsedOdds)) oddsObtained = parsedOdds;

    if (oddsObtained < req.minOdds && oddsObtained > 0) {
      throw new Error(`Odds dropped: obtained ${oddsObtained}, minimum required ${req.minOdds}`);
    }

    // Click the selection to add to betslip
    await (selectionEl as unknown as { click: () => Promise<void> }).click();
    await delay(2000);
  }

  return { oddsObtained, betId: '', confirmText: 'Selection added to betslip' };
}

async function enterStakeAndConfirm(
  page: Page,
  platform: PlatformConfig,
  stakeAmount: number
): Promise<{ betId: string; confirmText: string; potentialReturn: number }> {
  // Wait for betslip stake input — with scrape-then-select fallback
  const stakeSel = await waitForSelectorWithFallback(
    page, platform.selectors.betslipStakeInput, 'stakeInput', 10000, 'stake',
  );
  await delay(1000);

  // Clear existing value and enter stake
  await page.click(stakeSel, { clickCount: 3 });
  await page.type(stakeSel, String(stakeAmount), { delay: 80 });
  await delay(1000);

  // Read potential return
  let potentialReturn = 0;
  try {
    const returnText = await page.evaluate(() => {
      const el = document.querySelector('[class*="potential"], [class*="return"], [class*="payout"], [class*="win"]');
      return el?.textContent?.trim() || '';
    });
    potentialReturn = parseFloat(returnText.replace(/[^0-9.]/g, '')) || 0;
  } catch { /* ignore */ }

  // Click confirm — with scrape-then-select fallback
  const confirmSel = await waitForSelectorWithFallback(
    page, platform.selectors.betslipConfirmButton, 'confirmButton', 8000, 'place bet',
  );
  await page.click(confirmSel);
  await delay(3000);

  // Capture confirmation — with scrape-then-select fallback
  let confirmText = 'Bet placed';
  let betId = '';
  try {
    if (platform.selectors.confirmationMsg) {
      try {
        const confirmMsgSel = await waitForSelectorWithFallback(
          page, platform.selectors.confirmationMsg, 'confirmationMsg', 8000, 'success',
        );
        confirmText = await page.$eval(confirmMsgSel, el => el.textContent?.trim() || 'Bet placed');
      } catch { /* no confirmation element found */ }
    }

    // Try to find a bet reference/ID — check multiple selector patterns
    betId = await page.evaluate(() => {
      const selectors = [
        '[class*="bet-id"]', '[class*="betId"]', '[class*="bet_id"]',
        '[class*="slip-id"]', '[class*="slipId"]', '[class*="slip_id"]',
        '[class*="ticket"]', '[class*="ref"]', '[class*="reference"]',
        '[class*="booking"]', '[class*="confirmation"]', '[class*="receipt"]',
        '[data-bet-id]', '[data-booking-id]', '[id*="bet-id"]', '[id*="slip-id"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = el.textContent?.trim() || '';
          const idMatch = text.match(/[A-Z0-9]{6,}/i);
          if (idMatch) return idMatch[0];
        }
      }
      // Fallback: scan full page text for a booking/bet ID pattern
      const bodyText = document.body?.innerText || '';
      const patterns = [
        /Booking\s*(?:ID|Number|Ref(?:erence)?)?\s*:?\s*([A-Z0-9]{6,})/i,
        /Bet\s*(?:ID|Number|Ref(?:erence)?)?\s*:?\s*([A-Z0-9]{6,})/i,
        /Ticket\s*(?:ID|Number)?\s*:?\s*([A-Z0-9]{6,})/i,
        /Slip\s*(?:ID|Number)?\s*:?\s*([A-Z0-9]{6,})/i,
        /Ref(?:erence)?\s*:?\s*([A-Z0-9]{6,})/i,
        /Confirmation\s*(?:ID|Number|Code)?\s*:?\s*([A-Z0-9]{6,})/i,
        /ID\s*:?\s*([A-Z0-9]{6,})/i,
      ];
      for (const p of patterns) {
        const m = bodyText.match(p);
        if (m) return m[1];
      }
      return '';
    }) || '';
  } catch { /* no confirmation element */ }

  return { betId, confirmText, potentialReturn };
}

/** Generic selector set for platforms not in the known list */
function createGenericPlatform(id: string): PlatformConfig {
  const base = id.startsWith('http') ? id : `https://www.${id}`;
  return {
    id,
    name: id,
    baseUrl: base,
    loginUrl: `${base}/login`,
    searchable: true,
    selectors: {
      usernameInput: 'input[type="email"], input[type="text"], input[name="username"], input[name="email"], input[name="phone"]',
      passwordInput: 'input[type="password"]',
      loginButton: 'button[type="submit"]',
      searchBox: 'input[placeholder*="search" i], .search-input input',
      betslipStakeInput: 'input[placeholder*="stake" i], input[placeholder*="amount" i], input[type="number"]',
      betslipConfirmButton: 'button[type="submit"]',
      oddsDisplay: '.odds, .price, [class*="odds"]',
      confirmationMsg: '.success, [class*="success"]',
      cookieBanner: '.accept-cookies, [class*="cookie"] button',
    },
  };
}

export async function placeBet(req: BookingRequest): Promise<BookingResult> {
  const timestamp = new Date().toISOString();
  const platform = getPlatform(req.platform) ?? createGenericPlatform(req.platform);

  const username = process.env.BOOKING_USERNAME || '';
  const password = process.env.BOOKING_PASSWORD || '';
  const stakeUnit = parseFloat(process.env.BOOKING_STAKE_UNIT || '10');
  const stakeAmount = req.stakeOverride ?? (req.stakeUnits * stakeUnit);

  if (!username || !password) {
    return {
      success: false,
      platform: req.platform,
      fixture: req.fixture,
      market: req.market,
      selection: req.selection,
      error: 'BOOKING_USERNAME and BOOKING_PASSWORD env vars not set',
      reason: 'Missing credentials — add them in Replit Secrets',
      timestamp,
    };
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    console.log(`[Booking] Placing bet on ${platform.name}: ${req.fixture} | ${req.market} | ${req.selection} @ min ${req.minOdds} | stake ${stakeAmount}`);

    browser = await getBrowser();
    page = await browser.newPage();

    // Anti-bot: extra headers + disable webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      (window as Window & { chrome?: unknown }).chrome = { runtime: {} };
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    // Step 1: Login
    const loggedIn = await login(page, platform, username, password);
    if (!loggedIn) {
      const ss = await screenshot(page);
      await page.close();
      return {
        success: false,
        platform: req.platform,
        fixture: req.fixture,
        market: req.market,
        selection: req.selection,
        error: 'Login failed — check BOOKING_USERNAME and BOOKING_PASSWORD',
        reason: 'Authentication failed',
        screenshotBase64: ss,
        timestamp,
      };
    }

    console.log(`[Booking] Logged in to ${platform.name} successfully`);

    // Step 2: Find bet and add to betslip (platform-specific)
    let oddsObtained = 0;
    try {
      if (req.platform === 'sportybet') {
        const r = await findAndBookSportyBet(page, req, platform);
        oddsObtained = r.oddsObtained;
      } else {
        // Generic: navigate to platform home and let user-defined search work
        await page.goto(platform.baseUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await delay(2000);
        await dismissCookies(page, platform);

        if (platform.selectors.searchBox) {
          try {
            const searchSel = await waitForSelectorWithFallback(
              page, platform.selectors.searchBox, 'searchBox', 8000, 'search',
            );
            await page.type(searchSel, req.fixture, { delay: 50 });
            await delay(2000);
          } catch { /* no search box */ }
        }
      }
    } catch (err) {
      const ss = await screenshot(page);
      await page.close();
      return {
        success: false,
        platform: req.platform,
        fixture: req.fixture,
        market: req.market,
        selection: req.selection,
        error: String(err),
        reason: `Could not find bet selection on ${platform.name}`,
        screenshotBase64: ss,
        timestamp,
      };
    }

    // Step 3: Enter stake and confirm
    const { betId, confirmText, potentialReturn } = await enterStakeAndConfirm(page, platform, stakeAmount);
    const ss = await screenshot(page);

    await page.close();

    console.log(`[Booking] Bet placed! ID: ${betId} | Confirm: ${confirmText}`);

    return {
      success: true,
      platform: req.platform,
      fixture: req.fixture,
      market: req.market,
      selection: req.selection,
      oddsObtained: oddsObtained || req.minOdds,
      stakeAmount,
      potentialReturn,
      betId,
      confirmationText: confirmText,
      screenshotBase64: ss,
      timestamp,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Booking] Error:', msg);
    let ss = '';
    if (page) { ss = await screenshot(page); await page.close().catch(() => {}); }
    return {
      success: false,
      platform: req.platform,
      fixture: req.fixture,
      market: req.market,
      selection: req.selection,
      error: msg,
      reason: 'Unexpected booking error — see logs for details',
      screenshotBase64: ss,
      timestamp,
    };
  }
}

export { closeBrowser };
