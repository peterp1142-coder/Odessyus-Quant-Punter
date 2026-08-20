import { AsyncLocalStorage } from 'node:async_hooks';

export type VerificationStatus = 'none' | 'required' | 'resuming';

export interface LiveVisual {
  sessionId: string;
  image: string;
  url?: string;
  hint?: string;
  capturedAt: string;
  interactive?: boolean;
  verificationStatus?: VerificationStatus;
  verificationType?: string;
  verificationReason?: string;
}

const TTL_MS = Math.max(30_000, Number(process.env.LIVE_VISUAL_TTL_MS || 10 * 60_000));
const latest = new Map<string, LiveVisual>();
const visualContext = new AsyncLocalStorage<string>();

export function runWithVisualContext<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return visualContext.run(sessionId, fn);
}

export function currentVisualSessionId(): string | undefined {
  return visualContext.getStore();
}

export function publishVisual(visual: Omit<LiveVisual, 'capturedAt'>): void {
  latest.set(visual.sessionId, { ...visual, capturedAt: new Date().toISOString() });
}

export function getLatestVisual(sessionId: string): LiveVisual | null {
  const visual = latest.get(sessionId);
  if (!visual) return null;
  if (Date.now() - Date.parse(visual.capturedAt) > TTL_MS) {
    latest.delete(sessionId);
    return null;
  }
  return visual;
}

export function publishVerification(
  sessionId: string,
  data: Pick<LiveVisual, 'url' | 'hint' | 'image' | 'verificationType' | 'verificationReason'>,
): void {
  publishVisual({
    sessionId,
    image: data.image,
    url: data.url,
    hint: data.hint,
    interactive: true,
    verificationStatus: 'required',
    verificationType: data.verificationType,
    verificationReason: data.verificationReason,
  });
}

export function markVerificationResuming(sessionId: string): void {
  const current = latest.get(sessionId);
  if (!current) return;
  latest.set(sessionId, {
    ...current,
    verificationStatus: 'resuming',
    capturedAt: new Date().toISOString(),
  });
}

export function clearVisual(sessionId: string): void {
  latest.delete(sessionId);
}
