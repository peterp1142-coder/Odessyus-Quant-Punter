import type { BrowserContext, Page } from 'puppeteer-core';

interface VerificationSession {
  sessionId: string;
  page: Page;
  context: BrowserContext;
  resumeRequested: boolean;
  createdAt: number;
  release: () => void;
}

const sessions = new Map<string, VerificationSession>();

export function holdVerificationSession(
  sessionId: string,
  page: Page,
  context: BrowserContext,
  release: () => void,
): void {
  const existing = sessions.get(sessionId);
  if (existing && existing.page !== page) return;
  sessions.set(sessionId, {
    sessionId,
    page,
    context,
    resumeRequested: false,
    createdAt: Date.now(),
    release,
  });
}

export function getVerificationSession(sessionId: string): VerificationSession | null {
  return sessions.get(sessionId) || null;
}

export function requestVerificationResume(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.resumeRequested = true;
  return true;
}

export function wasVerificationResumeRequested(sessionId: string): boolean {
  return sessions.get(sessionId)?.resumeRequested === true;
}

export async function performVerificationAction(
  sessionId: string,
  action: { type: 'click' | 'scroll' | 'key' | 'text'; x?: number; y?: number; deltaY?: number; key?: string; text?: string },
): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) return false;
  const { page } = session;
  try {
    if (action.type === 'click') {
      const x = Number(action.x);
      const y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      await page.mouse.click(Math.max(0, Math.min(x, 5000)), Math.max(0, Math.min(y, 5000)), { clickCount: 1 });
      return true;
    }
    if (action.type === 'scroll') {
      const deltaY = Number(action.deltaY || 600);
      await page.evaluate((dy) => window.scrollBy({ top: dy, left: 0, behavior: 'instant' }), Math.max(-1500, Math.min(1500, deltaY)));
      return true;
    }
    if (action.type === 'key') {
      if (!action.key || action.key.length > 40) return false;
      await page.keyboard.press(action.key as any);
      return true;
    }
    if (action.type === 'text') {
      if (typeof action.text !== 'string' || action.text.length > 2000) return false;
      await page.keyboard.type(action.text, { delay: 20 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function waitForVerificationResume(sessionId: string, timeoutMs = 10 * 60_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.resumeRequested) {
      sessions.delete(sessionId);
      try { await session.context.close(); } catch {}
      try { session.release(); } catch {}
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const session = sessions.get(sessionId);
  if (session) {
    sessions.delete(sessionId);
    try { await session.context.close(); } catch {}
    try { session.release(); } catch {}
  }
  return false;
}

export function clearVerificationSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (session) {
    void session.context.close().catch(() => {});
    try { session.release(); } catch {}
  }
}
