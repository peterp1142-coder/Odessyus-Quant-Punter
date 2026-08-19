const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const RecaptchaPlugin = require('puppeteer-extra-plugin-recaptcha');

// Activate stealth plugins to mask automation markers
puppeteer.use(StealthPlugin());
puppeteer.use(
    RecaptchaPlugin({
        provider: {
            id: '2captcha',
            token: process.env.CAPTCHA_2CAPTCHA_TOKEN || '',
        },
    })
);

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const SECRET_TOKEN = process.env.SECRET_TOKEN || "MySecretToken123";

// Session management
const sessions = new Map();
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// Security Middleware
const verifyToken = (req, res, next) => {
    const token = req.query.token || req.headers.authorization?.split(' ')[1];
    if (!token || token !== SECRET_TOKEN) {
        return res.status(401).json({ error: "Unauthorized: Invalid or missing token." });
    }
    next();
};

// Advanced browser launch options for maximum stealth
const getBrowserOptions = () => ({
    headless: 'new',
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-component-extensions-with-background-pages',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-prompt-on-repost',
        '--enable-automation',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--no-service-autorun',
        '--disable-extensions',
        '--disable-plugins',
        '--disable-plugin-power-saver',
        '--disable-bundled-ppapi-flash',
        '--disable-flash-3d',
        '--disable-flash-stage3d',
        '--disable-pepper-3d',
        '--disable-device-discovery-notifications',
        '--disable-translate',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
    ],
});

// Stealth page configuration
const configureStealthPage = async (page) => {
    // Set realistic viewport
    await page.setViewport({
        width: 1920 + Math.floor(Math.random() * 100),
        height: 1080 + Math.floor(Math.random() * 100),
        deviceScaleFactor: 1,
    });

    // Set random but realistic user agent
    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    ];
    const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
    await page.setUserAgent(userAgent);

    // Inject stealth scripts
    await page.evaluateOnNewDocument(() => {
        // Remove headless indicator
        Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
        });

        // Override chrome check
        window.chrome = {
            runtime: {},
        };

        // Remove plugins array manipulation
        Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5],
        });

        // Remove languages manipulation
        Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
        });

        // Spoof permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) =>
            parameters.name === 'notifications'
                ? Promise.resolve({ state: Notification.permission })
                : originalQuery(parameters);

        // Random timezone
        Intl.DateTimeFormat.prototype.resolvedOptions = function () {
            return {
                locale: 'en-US',
                calendar: 'gregory',
                numberingSystem: 'latn',
                timeZone: 'America/New_York',
                year: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            };
        };

        // Spoof screen resolution
        Object.defineProperty(window.screen, 'width', {
            get: () => 1920 + Math.floor(Math.random() * 100),
        });
        Object.defineProperty(window.screen, 'height', {
            get: () => 1080 + Math.floor(Math.random() * 100),
        });
    });

    // Set realistic headers
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'max-age=0',
        'Upgrade-Insecure-Requests': '1',
    });

    // Reduce resource loading for speed
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
            request.abort();
        } else {
            request.continue();
        }
    });

    // Random delays between actions to simulate human behavior
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);

    return page;
};

// Random delay to simulate human thinking
const humanDelay = (min = 500, max = 3000) => {
    return new Promise(resolve => 
        setTimeout(resolve, min + Math.random() * (max - min))
    );
};

// Session class
class BrowserSession {
    constructor(sessionId) {
        this.sessionId = sessionId;
        this.browser = null;
        this.page = null;
        this.createdAt = Date.now();
        this.lastActivity = Date.now();
    }

    async initialize() {
        try {
            this.browser = await puppeteer.launch(getBrowserOptions());
            this.page = await this.browser.newPage();
            await configureStealthPage(this.page);
            console.log(`[Session] ${this.sessionId} initialized`);
        } catch (error) {
            console.error(`[Session Error] ${this.sessionId}:`, error.message);
            throw error;
        }
    }

    async close() {
        try {
            if (this.browser) {
                await this.browser.close();
                console.log(`[Session] ${this.sessionId} closed`);
            }
        } catch (error) {
            console.error(`[Session Error] ${this.sessionId} cleanup:`, error.message);
        }
    }

    updateActivity() {
        this.lastActivity = Date.now();
    }

    isExpired() {
        return Date.now() - this.lastActivity > SESSION_TIMEOUT;
    }
}

// WebSocket connection handler
wss.on('connection', async (ws) => {
    let sessionId = null;
    let session = null;

    console.log('[WS] New client connected');

    ws.on('message', async (message) => {
        try {
            const command = JSON.parse(message);
            const { action, token, id, payload } = command;

            // Verify token on first connection
            if (!sessionId) {
                if (token !== SECRET_TOKEN) {
                    return ws.send(JSON.stringify({ error: 'Unauthorized' }));
                }
                sessionId = id || `session-${Date.now()}`;
            }

            // Get or create session
            if (!session) {
                if (!sessions.has(sessionId)) {
                    session = new BrowserSession(sessionId);
                    await session.initialize();
                    sessions.set(sessionId, session);
                } else {
                    session = sessions.get(sessionId);
                }
            }

            session.updateActivity();

            // Execute command
            let result = {};
            switch (action) {
                case 'navigate':
                    await humanDelay(500, 1500);
                    await session.page.goto(payload.url, {
                        waitUntil: 'networkidle2',
                        timeout: 30000,
                    });
                    await humanDelay(1000, 3000);
                    result = { status: 'success', url: session.page.url() };
                    break;

                case 'click':
                    await humanDelay(300, 800);
                    await session.page.click(payload.selector);
                    await humanDelay(500, 2000);
                    result = { status: 'success', clicked: payload.selector };
                    break;

                case 'type':
                    await humanDelay(300, 800);
                    await session.page.type(payload.selector, payload.text, {
                        delay: 50 + Math.random() * 150, // Variable typing speed
                    });
                    result = { status: 'success', typed: payload.text };
                    break;

                case 'search':
                    await humanDelay(300, 800);
                    await session.page.type(payload.selector, payload.query, {
                        delay: 50 + Math.random() * 150,
                    });
                    await humanDelay(200, 500);
                    await session.page.press(payload.enterKey || 'Enter');
                    await humanDelay(2000, 4000);
                    result = { status: 'success', searched: payload.query };
                    break;

                case 'wait_for_selector':
                    await session.page.waitForSelector(payload.selector, {
                        timeout: payload.timeout || 10000,
                    });
                    result = { status: 'success', found: payload.selector };
                    break;

                case 'get_text':
                    const text = await session.page.evaluate((sel) => {
                        const element = document.querySelector(sel);
                        return element ? element.innerText : null;
                    }, payload.selector);
                    result = { status: 'success', text };
                    break;

                case 'get_html':
                    const html = await session.page.evaluate((sel) => {
                        const element = document.querySelector(sel);
                        return element ? element.innerHTML : null;
                    }, payload.selector);
                    result = { status: 'success', html };
                    break;

                case 'extract_data':
                    const data = await session.page.evaluate((sel) => {
                        const elements = document.querySelectorAll(sel);
                        return Array.from(elements).map(el => ({
                            text: el.innerText,
                            html: el.innerHTML,
                        }));
                    }, payload.selector);
                    result = { status: 'success', count: data.length, data };
                    break;

                case 'screenshot':
                    const screenshot = await session.page.screenshot({
                        encoding: 'base64',
                        fullPage: payload.fullPage || false,
                    });
                    result = { status: 'success', screenshot };
                    break;

                case 'get_url':
                    result = { status: 'success', url: session.page.url() };
                    break;

                case 'get_title':
                    const title = await session.page.title();
                    result = { status: 'success', title };
                    break;

                case 'scroll':
                    await session.page.evaluate((x, y) => {
                        window.scrollBy(x, y);
                    }, payload.x || 0, payload.y || 500);
                    await humanDelay(500, 1500);
                    result = { status: 'success', scrolled: true };
                    break;

                case 'wait_time':
                    await new Promise(resolve => 
                        setTimeout(resolve, payload.ms || 2000)
                    );
                    result = { status: 'success', waited: payload.ms };
                    break;

                case 'handle_captcha':
                    // Attempt to solve recaptcha using 2captcha
                    await session.page.solveRecaptchas();
                    result = { status: 'success', captcha_attempt: true };
                    break;

                case 'close_session':
                    await session.close();
                    sessions.delete(sessionId);
                    result = { status: 'success', session_closed: true };
                    sessionId = null;
                    session = null;
                    break;

                default:
                    result = { error: `Unknown action: ${action}` };
            }

            ws.send(JSON.stringify({ sessionId, ...result }));
        } catch (error) {
            console.error('[WS Error]:', error.message);
            ws.send(JSON.stringify({ error: error.message }));
        }
    });

    ws.on('close', async () => {
        console.log('[WS] Client disconnected');
        if (session) {
            await session.close();
            if (sessionId) {
                sessions.delete(sessionId);
            }
        }
    });

    ws.on('error', (error) => {
        console.error('[WS Error]:', error);
    });
});

// Cleanup expired sessions every 5 minutes
setInterval(() => {
    for (const [id, sess] of sessions.entries()) {
        if (sess.isExpired()) {
            sess.close();
            sessions.delete(id);
            console.log(`[Cleanup] Closed expired session: ${id}`);
        }
    }
}, 5 * 60 * 1000);

// HTTP endpoint for quick scrapes (legacy support)
app.post('/scrape', verifyToken, async (req, res) => {
    const { url, selector, waitTime } = req.body;

    if (!url) {
        return res.status(400).json({ error: "Missing required parameter: 'url'" });
    }

    let session = null;
    try {
        session = new BrowserSession(`http-scrape-${Date.now()}`);
        await session.initialize();
        
        console.log(`[HTTP Scrape] Navigating to: ${url}`);
        await session.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        await new Promise(resolve => setTimeout(resolve, waitTime || 5000));

        let collectedText = "";
        if (selector) {
            try {
                await session.page.waitForSelector(selector, { timeout: 10000 });
                collectedText = await session.page.evaluate((sel) => {
                    const elements = document.querySelectorAll(sel);
                    return Array.from(elements).map(el => el.innerText).join("\n");
                }, selector);
            } catch (e) {
                console.log(`[Warning] Selector '${selector}' not found. Fallback to body text.`);
                collectedText = await session.page.evaluate(() => document.body.innerText);
            }
        } else {
            collectedText = await session.page.evaluate(() => document.body.innerText);
        }

        res.status(200).json({
            status: "success",
            finalUrl: session.page.url(),
            characterCount: collectedText.length,
            data: collectedText,
        });
    } catch (error) {
        console.error(`[HTTP Scrape Error]:`, error.message);
        res.status(500).json({ status: "error", error: error.message });
    } finally {
        if (session) {
            await session.close();
        }
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        activeSessions: sessions.size,
        uptime: process.uptime(),
    });
});

server.listen(PORT, () => {
    console.log(`🤖 Stealth Browser Automation Engine running on port ${PORT}`);
    console.log(`📡 WebSocket available at ws://localhost:${PORT}`);
    console.log(`🔐 Token authentication enabled`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    for (const [id, session] of sessions.entries()) {
        await session.close();
    }
    process.exit(0);
});
