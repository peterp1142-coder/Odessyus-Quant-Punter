import puppeteer, { type Browser, type Page, type BrowserContext } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MEMORY_GUARD_MB = 460;
const DEFAULT_MAX_PAGES = 1;
const MAX_ALLOWED_PAGES = 2;
const DEFAULT_IDLE_CLOSE_MS = 90_000;
const DEFAULT_QUEUE_LIMIT = 12;
const NAV_TIMEOUT_MS = 30_000;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;
let activePages = 0;
let idleCloseTimer: NodeJS.Timeout | null = null;
const waiters: Array<() => void> = [];

const memoryGuardMb = () => Math.max(256, Number(process.env.BROWSER_MEMORY_GUARD_MB || DEFAULT_MEMORY_GUARD_MB));
const maxPages = () => Math.min(MAX_ALLOWED_PAGES, Math.max(1, Number(process.env.BROWSER_MAX_CONCURRENCY || DEFAULT_MAX_PAGES)));
const queueLimit = () => Math.max(1, Number(process.env.BROWSER_QUEUE_LIMIT || DEFAULT_QUEUE_LIMIT));

function rssMb(): number {
  return process.memoryUsage().rss / 1024 / 1024;
}

function memorySafe(): boolean {
  const rss = rssMb();
  if (rss >= memoryGuardMb()) {
    console.warn(`[BROWSER] Memory guard active: Node RSS ${rss.toFixed(1)}MB >= ${memoryGuardMb()}MB; delaying browser work`);
    return false;
  }
  return true;
}

function candidateExecutables(): string[] {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/render/project/.chrome/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    '/opt/render/project/.chrome/chrome/linux-*/chrome-linux64/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/nix/var/nix/profiles/default/bin/chromium',
    '/nix/var/nix/profiles/default/bin/chromium-browser',
  ].filter(Boolean) as string[];

  const expanded: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.includes('*')) expanded.push(candidate);
    else {
      const parent = path.dirname(path.dirname(candidate));
      try {
        for (const versionDir of fs.readdirSync(parent, { withFileTypes: true })) {
          if (!versionDir.isDirectory()) continue;
          const executable = path.join(parent, versionDir.name, 'chrome-linux64', 'chrome');
          expanded.push(executable);
        }
      } catch {}
    }
  }
  return expanded;
}

function resolveExecutable(): string {
  for (const candidate of candidateExecutables()) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        console.log(`[BROWSER] Chrome executable: ${candidate}`);
        return candidate;
      }
    } catch {}
  }
  throw new Error(`Chrome executable not found. Set PUPPETEER_EXECUTABLE_PATH or install Chrome under /opt/render/project/.chrome. Checked: ${candidateExecutables().join(', ')}`);
}

const launchArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-plugins',
  '--disable-component-update',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--disable-client-side-phishing-detection',
  '--disable-default-apps',
  '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-service-autorun',
  '--force-color-profile=srgb',
];

async function launchBrowser(): Promise<Browser> {
  if (!memorySafe()) throw new Error(`Browser launch blocked by memory guard at ${rssMb().toFixed(1)}MB RSS`);
  const executablePath = resolveExecutable();
  console.log(`[BROWSER] Launching shared Chromium (max pages=${maxPages()}, memory guard=${memoryGuardMb()}MB)`);
  return puppeteer.launch({ headless: true, executablePath, args: launchArgs });
}

async function closeBrowser(reason: string): Promise<void> {
  if (idleCloseTimer) { clearTimeout(idleCloseTimer); idleCloseTimer = null; }
  const current = browser;
  browser = null;
  if (current) {
    try { await current.close(); } catch (error) { console.warn(`[BROWSER] Close failed (${reason}):`, String(error)); }
    console.log(`[BROWSER] Shared Chromium closed: ${reason}`);
  }
}

async function ensureBrowser(): Promise<Browser> {
  if (browser?.connected) {
    try {
      await browser.version();
      return browser;
    } catch {
      if (activePages === 0) await closeBrowser('health check failed');
    }
  }
  if (launchPromise) return launchPromise;
  launchPromise = launchBrowser().then(b => {
    browser = b;
    b.on('disconnected', () => {
      browser = null;
      console.warn('[BROWSER] Chromium disconnected; next request will restart it');
    });
    return b;
  }).finally(() => { launchPromise = null; });
  return launchPromise;
}

function scheduleIdleCleanup(): void {
  if (idleCloseTimer) clearTimeout(idleCloseTimer);
  if (activePages > 0 || waiters.length > 0) return;
  const idleMs = Math.max(15_000, Number(process.env.BROWSER_IDLE_CLOSE_MS || DEFAULT_IDLE_CLOSE_MS));
  idleCloseTimer = setTimeout(() => {
    if (activePages === 0 && waiters.length === 0) void closeBrowser('idle cleanup');
  }, idleMs);
  idleCloseTimer.unref?.();
}

async function acquireSlot(): Promise<void> {
  if (!memorySafe()) throw new Error(`Browser operation queued/blocked by memory guard at ${rssMb().toFixed(1)}MB RSS`);
  if (activePages < maxPages()) {
    activePages++;
    return;
  }
  if (waiters.length >= queueLimit()) throw new Error(`Browser queue is full (${queueLimit()}); refusing additional browser work`);
  await new Promise<void>(resolve => waiters.push(resolve));
  if (!memorySafe()) {
    const next = waiters.shift();
    if (next) next();
    throw new Error(`Browser operation cancelled by memory guard at ${rssMb().toFixed(1)}MB RSS`);
  }
  activePages++;
}

function releaseSlot(): void {
  activePages = Math.max(0, activePages - 1);
  const next = waiters.shift();
  if (next) next();
  else scheduleIdleCleanup();
}

async function configurePage(page: Page): Promise<void> {
  await page.setUserAgent(DESKTOP_UA);
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });
  await page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  await page.setDefaultTimeout(NAV_TIMEOUT_MS);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const type = request.resourceType();
    if (['image', 'stylesheet', 'font', 'media', 'manifest', 'texttrack'].includes(type)) request.abort().catch(() => {});
    else request.continue().catch(() => {});
  });
}

export async function withBrowserPage<T>(
  url: string,
  waitTimeMs: number,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  await acquireSlot();
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    const b = await ensureBrowser();
    context = await b.createBrowserContext();
    page = await context.newPage();
    await configurePage(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    if (waitTimeMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(waitTimeMs, 10_000)));
    return await operation(page);
  } catch (error) {
    if (browser && !browser.connected && activePages <= 1) void closeBrowser('unhealthy during scrape');
    throw error;
  } finally {
    try { if (page && !page.isClosed()) await page.close(); } catch {}
    try { if (context) await context.close(); } catch {}
    releaseSlot();
  }
}

export function browserDiagnostics(): Record<string, unknown> {
  return {
    connected: Boolean(browser?.connected),
    activePages,
    queuedPages: waiters.length,
    maxPages: maxPages(),
    nodeRssMb: Number(rssMb().toFixed(1)),
    memoryGuardMb: memoryGuardMb(),
  };
}

export async function shutdownBrowser(): Promise<void> {
  if (activePages === 0) await closeBrowser('process shutdown');
}

process.once('SIGTERM', () => { void shutdownBrowser(); });
process.once('SIGINT', () => { void shutdownBrowser(); });
