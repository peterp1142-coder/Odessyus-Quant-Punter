/**
 * Odessyus Access Gate
 *
 * Validates requests against BOOKING_ACCESS_KEY_HASH (SHA-256 of the raw key).
 * Auth flow:
 *   1. Client POSTs the raw key to /api/auth/verify
 *   2. Server hashes it, compares, and on success sets an httpOnly session cookie
 *   3. All subsequent requests (fetch + EventSource) carry the cookie automatically
 *
 * If BOOKING_ACCESS_KEY_HASH is not set the gate is disabled (dev mode).
 */
import { createHash, randomBytes } from 'crypto';
// ─── In-process session store ─────────────────────────────────────────────────
// Sessions live as long as the process — server restart requires re-auth, which is fine.
const SESSIONS = new Map(); // token → expiry (ms epoch)
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
export const COOKIE_NAME = 'ody_session';
export function createSession() {
    const token = randomBytes(32).toString('hex');
    SESSIONS.set(token, Date.now() + SESSION_TTL_MS);
    // Prune expired sessions occasionally
    if (SESSIONS.size > 1000) {
        const now = Date.now();
        for (const [k, exp] of SESSIONS)
            if (exp < now)
                SESSIONS.delete(k);
    }
    return token;
}
export function isValidSession(token) {
    if (!token)
        return false;
    const expiry = SESSIONS.get(token);
    if (!expiry)
        return false;
    if (Date.now() > expiry) {
        SESSIONS.delete(token);
        return false;
    }
    return true;
}
// ─── Key verification ─────────────────────────────────────────────────────────
export function verifyAccessKey(key) {
    const expectedHash = process.env.BOOKING_ACCESS_KEY_HASH;
    if (!expectedHash)
        return true; // gate disabled
    if (!key)
        return false;
    return createHash('sha256').update(key).digest('hex') === expectedHash;
}
export function gateEnabled() {
    return !!process.env.BOOKING_ACCESS_KEY_HASH;
}
// ─── Cookie helper ────────────────────────────────────────────────────────────
export function getCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1)
            continue;
        const k = part.slice(0, idx).trim();
        if (k === name)
            return part.slice(idx + 1).trim();
    }
    return undefined;
}
// ─── Express middleware ───────────────────────────────────────────────────────
export function requireAuth(req, res, next) {
    if (!gateEnabled()) {
        next();
        return;
    }
    const sessionToken = getCookie(req, COOKIE_NAME);
    if (isValidSession(sessionToken)) {
        next();
        return;
    }
    res.status(401).json({ error: 'Unauthorized — please authenticate first.' });
}
//# sourceMappingURL=auth.js.map