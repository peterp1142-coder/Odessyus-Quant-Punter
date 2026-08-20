import type { BrowserContext, Page } from 'puppeteer-core';

export type VerificationStatus = 'none' | 'required' | 'resuming' | 'completed' | 'expired';

export interface VerificationSnapshot {
  sessionId: string;
  status: VerificationStatus;
  url: string;
  title: string;
  challengeType?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

interface VerificationSession {
  sessionId: string;
  page: Page;
  context: BrowserContext;
  release: () => void;
  createdAt: number;
  updatedAt: number;
  status: VerificationStatus;
  challengeType?: string;
  reason?: string;
  resumeRequested: boolean;
  maxLifetimeMs: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 20 * 60_000;
const sessions = new Map<string, VerificationSession>();

function now(): number {
  return Date.now();
}

function timeoutForSession(): number {
  const configured = Number(process.env.BROWSER_VERIFICATION_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  return Math.max(60_000, Math.min(MAX_TIMEOUT_MS, Number.isFinite(configured) ? configured : DEFAULT_TIMEOUT_MS));
}

export function holdVerificationSession(
  sessionId: string,
  page: Page,
  context: BrowserContext,
  release: () => void,
  details: { challengeType?: string; reason?: string } = {},
): void {
  const existing = sessions.get(sessionId);
  if (existing && existing.page !== page) return;

  const timestamp = now();
  sessions.set(sessionId, {
    sessionId,
    page,
    context,
    release,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    status: 'required',
    challengeType: details.challengeType,
    reason: details.reason,
    resumeRequested: false,
    maxLifetimeMs: existing?.maxLifetimeMs ?? timeoutForSession(),
  });
}

export function getVerificationSession(sessionId: string): VerificationSession | null {
  const session = sessions.get(sessionId);
  if (!session) return null;

  if (now() - session.createdAt > session.maxLifetimeMs) {
    session.status = 'expired';
    sessions.delete(sessionId);
    void session.context.close().catch(() => {});
    try { session.release(); } catch {}
    return null;
  }

  return session;
}

export async function getVerificationSnapshot(sessionId: string): Promise<VerificationSnapshot | null> {
  const session = getVerificationSession(sessionId);
  if (!session) return null;

  let title = '';
  let url = '';
  try {
    title = await session.page.title();
    url = session.page.url();
  } catch {}

  return {
    sessionId,
    status: session.status,
    url,
    title,
    challengeType: session.challengeType,
    reason: session.reason,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

export function requestVerificationResume(sessionId: string): boolean {
  const session = getVerificationSession(sessionId);
  if (!session) return false;
  session.resumeRequested = true;
  session.status = 'resuming';
  session.updatedAt = now();
  return true;
}

export function wasVerificationResumeRequested(sessionId: string): boolean {
  return getVerificationSession(sessionId)?.resumeRequested === true;
}

/**
 * Human-controlled actions for the live browser session.
 * These do not attempt to solve or bypass the challenge; they only expose the
 * same basic interactions a user performs in a browser page.
 */
export async function performVerificationAction(
  sessionId: string,
  action:
    | { type: 'click'; x: number; y: number }
    | { type: 'scroll'; deltaY?: number }
    | { type: 'key'; key: string }
    | { type: 'text'; text: string },
): Promise<boolean> {
  const session = getVerificationSession(sessionId);
  if (!session || session.status !== 'required') return false;

  try {
    switch (action.type) {
      case 'click': {
        const x = Number(action.x);
        const y = Number(action.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
        const viewport = await session.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        const cx = Math.max(0, Math.min(x, viewport.width));
        const cy = Math.max(0, Math.min(y, viewport.height));
        await session.page.mouse.click(cx, cy, { clickCount: 1 });
        session.updatedAt = now();
        return true;
      }
      case 'scroll': {
        const deltaY = Number(action.deltaY ?? 600);
        const bounded = Math.max(-1500, Math.min(1500, Number.isFinite(deltaY) ? deltaY : 600));
        await session.page.evaluate((dy) => window.scrollBy({ top: dy, left: 0, behavior: 'instant' }), bounded);
        session.updatedAt = now();
        return true;
      }
      case 'key': {
        if (!action.key || action.key.length > 32) return false;
        await session.page.keyboard.press(action.key as any);
        session.updatedAt = now();
        return true;
      }
      case 'text': {
        if (typeof action.text !== 'string' || action.text.length > 1000) return false;
        await session.page.keyboard.type(action.text, { delay: 20 });
        session.updatedAt = now();
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

export async function waitForVerificationResume(
  sessionId: string,
  timeoutMs = timeoutForSession(),
): Promise<boolean> {
  const session = getVerificationSession(sessionId);
  if (!session) return false;

  const deadline = Math.min(session.createdAt + session.maxLifetimeMs, now() + timeoutMs);
  while (now() < deadline) {
    const current = getVerificationSession(sessionId);
    if (!current) return false;

    if (current.resumeRequested) {
      current.status = 'resuming';
      current.updatedAt = now();
      // The caller owns continuation. Do not close the context here.
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }

  clearVerificationSession(sessionId);
  return false;
}

export function completeVerificationSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = 'completed';
  session.updatedAt = now();
}

export function clearVerificationSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (!session) return;
  void session.context.close().catch(() => {});
  try { session.release(); } catch {}
}

export function verificationSessionCount(): number {
  return sessions.size;
}
