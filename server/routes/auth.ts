import { Router, Request, Response } from 'express';
import {
  verifyAccessKey,
  createSession,
  isValidSession,
  getCookie,
  gateEnabled,
  COOKIE_NAME,
} from '../middleware/auth.js';

const router = Router();
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: process.env.NODE_ENV === 'production',
  maxAge: 8 * 60 * 60 * 1000, // 8 hours in ms
  path: '/',
};

// POST /api/auth/verify — submit access key, receive session cookie
router.post('/verify', (req: Request, res: Response) => {
  if (!gateEnabled()) {
    return res.json({ ok: true, message: 'Gate disabled' });
  }

  const { key } = req.body as { key?: string };
  if (!key || !verifyAccessKey(key)) {
    return res.status(401).json({ ok: false, error: 'Invalid access key' });
  }

  const token = createSession();
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.json({ ok: true });
});

// GET /api/auth/status — check if the current session cookie is valid
router.get('/status', (req: Request, res: Response) => {
  if (!gateEnabled()) return res.json({ authenticated: true, gateEnabled: false });

  const token = getCookie(req, COOKIE_NAME);
  const authenticated = isValidSession(token);
  res.json({ authenticated, gateEnabled: true });
});

// POST /api/auth/logout — clear session cookie
router.post('/logout', (req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

export default router;
