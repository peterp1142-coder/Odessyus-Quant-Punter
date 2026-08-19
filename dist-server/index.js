import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import dotenv from 'dotenv';
import { rateLimit } from 'express-rate-limit';
dotenv.config();
import { initSchema } from './db/schema.js';
import { purgeExpiredCheckpoints } from './agent/checkpoint.js';
import authRouter from './routes/auth.js';
import chatRouter from './routes/chat.js';
import predictionsRouter from './routes/predictions.js';
import statsRouter from './routes/stats.js';
import bookingRouter from './routes/booking.js';
import { requireAuth } from './middleware/auth.js';
import { initTelegram } from './telegram.js';
import { initAirtable } from './agent/airtable-logger.js';
import { initSettlementCron } from './agent/settlement.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// In production (built dist/ present), default to port 5000 (mapped to external :80).
// In development, concurrently runs server on 3001 + Vite on 5000.
const PORT = parseInt(process.env.PORT || process.env.API_PORT || '5000', 10);
const app = express();
const httpServer = createServer(app);
// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors({
    origin: true,
    credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
// Trust the Replit/Cloud Run reverse proxy so express-rate-limit
// can correctly identify clients via X-Forwarded-For.
app.set('trust proxy', 1);
// Rate limiting for chat endpoint
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a minute.' },
});
// ─── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth', authRouter); // public — no auth
app.use('/api/chat', chatLimiter, requireAuth, chatRouter); // gated
app.use('/api/predictions', requireAuth, predictionsRouter); // gated
app.use('/api/stats', requireAuth, statsRouter); // gated
app.use('/api/booking', requireAuth, bookingRouter); // gated
// ─── Health check ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        service: 'Odessyus Agent API',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
    });
});
// ─── Serve frontend build (production) ────────────────────────────────────
const distPath = join(__dirname, '..', 'dist');
if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
        res.sendFile(join(distPath, 'index.html'));
    });
}
// ─── WebSocket Server ───────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
wss.on('connection', (ws, req) => {
    const url = new URL(req.url || '/', `http://localhost`);
    const sessionId = url.searchParams.get('session') || 'anonymous';
    console.log(`[WS] Client connected: ${sessionId}`);
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        }
        catch { /* ignore */ }
    });
    ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${sessionId}`);
    });
    ws.send(JSON.stringify({ type: 'welcome', message: 'Odessyus WebSocket connected' }));
});
// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
    // Start HTTP server immediately so health checks pass during async init
    await new Promise((resolve) => {
        httpServer.listen(PORT, '0.0.0.0', () => {
            console.log(`[Server] Odessyus API running on port ${PORT}`);
            console.log(`[Server] WebSocket on ws://0.0.0.0:${PORT}/ws`);
            resolve();
        });
    });
    // Async init (non-blocking for health checks)
    try {
        await initSchema();
        purgeExpiredCheckpoints().catch(() => { });
        initTelegram();
        // Airtable logging (auto-creates base/tables on first run, reuses on restart)
        initAirtable().catch(err => console.error('[Server] Airtable init error:', err instanceof Error ? err.message : String(err)));
        // Settlement cron — settles finished matches every 30 min
        initSettlementCron();
    }
    catch (err) {
        console.error('[Server] Startup error:', err);
    }
}
start();
export default app;
//# sourceMappingURL=index.js.map