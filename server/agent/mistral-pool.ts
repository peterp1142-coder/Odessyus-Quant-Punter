/**
 * MistralKeyPool — multi-key rotation with per-key 429 cooldown tracking.
 *
 * The pool exposes both SDK calls and a raw vision call. The raw vision path is
 * intentional: the pinned SDK (1.3.x) validates content blocks differently from
 * the current Mistral vision API. Vision screenshots are therefore sent as
 * base64 image URLs directly to /v1/chat/completions, which is the documented
 * vision transport and avoids ephemeral file-ID propagation problems.
 */

import { Mistral } from '@mistralai/mistralai';

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_WAIT_MS = 300_000;
const BASE_BACKOFF_MS = 2_000;
const CALL_TIMEOUT_MS = 90_000;
const VISION_CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.MISTRAL_VISION_CONCURRENCY || 2)));

interface KeyEntry {
  key: string;
  client: Mistral;
  cooldownUntil: number;
  uses: number;
}

interface VisionRequest {
  model: string;
  prompt: string;
  imageBase64: string;
  temperature?: number;
  maxTokens?: number;
}

function loadKeys(): KeyEntry[] {
  const raw: string[] = [];
  const primary = process.env.MISTRAL_API_KEY;
  if (primary) raw.push(primary);
  for (let i = 1; i <= 20; i++) {
    const k = process.env[`MISTRAL_API_KEY_${i}`];
    if (k) raw.push(k);
  }
  if (raw.length === 0) throw new Error('[MistralPool] No Mistral API keys configured.');
  const unique = [...new Set(raw)];
  console.log(`[MistralPool] Loaded ${unique.length} API key(s).`);
  return unique.map(key => ({ key, client: new Mistral({ apiKey: key }), cooldownUntil: 0, uses: 0 }));
}

class MistralKeyPool {
  private entries: KeyEntry[];
  private visionActive = 0;
  private visionQueue: Array<() => void> = [];

  constructor() {
    this.entries = loadKeys();
  }

  private pick(): KeyEntry | null {
    const now = Date.now();
    const available = this.entries.filter(e => e.cooldownUntil <= now);
    if (!available.length) return null;
    return available.reduce((a, b) => (a.uses <= b.uses ? a : b));
  }

  private msUntilAvailable(): number {
    const now = Date.now();
    return Math.max(0, Math.min(...this.entries.map(e => e.cooldownUntil - now)));
  }

  private markRateLimited(entry: KeyEntry, retryAfterMs = DEFAULT_COOLDOWN_MS): void {
    entry.cooldownUntil = Date.now() + retryAfterMs;
    console.warn(`[MistralPool] Key …${entry.key.slice(-6)} rate-limited. Cooled for ${retryAfterMs / 1000}s.`);
  }

  async call<T>(fn: (client: Mistral) => Promise<T>): Promise<T> {
    const deadline = Date.now() + MAX_WAIT_MS;
    let attempt = 0;

    while (Date.now() < deadline) {
      const entry = this.pick();
      if (!entry) {
        const wait = Math.min(this.msUntilAvailable() + 100, 5_000);
        console.warn(`[MistralPool] All keys in cooldown. Waiting ${wait}ms…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      try {
        entry.uses++;
        const result = await Promise.race([
          fn(entry.client),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Mistral call timeout (${CALL_TIMEOUT_MS / 1000}s)`)), CALL_TIMEOUT_MS)),
        ]);
        return result;
      } catch (err) {
        const msg = String(err);
        const is429 = msg.includes('429') || msg.includes('rate_limited') || msg.includes('Rate limit');
        const isTimeout = msg.includes('Mistral call timeout');
        if (isTimeout) {
          this.markRateLimited(entry, 15_000);
          console.warn(`[MistralPool] Key …${entry.key.slice(-6)} timed out. Rotating.`);
          attempt++;
          continue;
        }
        if (!is429) throw err;

        const retryM = msg.match(/retry.?after[:\s]+(\d+)/i);
        const coolMs = retryM ? parseInt(retryM[1]) * 1_000 : DEFAULT_COOLDOWN_MS;
        this.markRateLimited(entry, coolMs);
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        attempt++;
        console.warn(`[MistralPool] Attempt ${attempt} failed (429). Backing off ${backoff}ms before next key.`);
        await new Promise(r => setTimeout(r, Math.min(backoff, 10_000)));
      }
    }

    throw new Error('[MistralPool] All keys exhausted and max wait exceeded. Request dropped.');
  }

  private async acquireVisionSlot(): Promise<void> {
    if (this.visionActive < VISION_CONCURRENCY) {
      this.visionActive++;
      return;
    }
    await new Promise<void>(resolve => this.visionQueue.push(resolve));
    this.visionActive++;
  }

  private releaseVisionSlot(): void {
    this.visionActive = Math.max(0, this.visionActive - 1);
    const next = this.visionQueue.shift();
    if (next) next();
  }

  /**
   * Vision transport using the documented base64 image input. This deliberately
   * avoids uploading a temporary Mistral file because the pinned SDK's `fileId`
   * message path can race file availability and produced 404/invalid_request_file
   * errors in production.
   */
  async visionComplete(request: VisionRequest): Promise<string> {
    await this.acquireVisionSlot();
    try {
      return await this.rawRequest(async entry => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
        try {
          const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${entry.key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: request.model,
              temperature: request.temperature ?? 0,
              max_tokens: request.maxTokens ?? 750,
              messages: [{
                role: 'user',
                content: [
                  { type: 'text', text: request.prompt },
                  { type: 'image_url', image_url: `data:image/jpeg;base64,${request.imageBase64}` },
                ],
              }],
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            const err = new Error(`Mistral vision HTTP ${response.status}: ${JSON.stringify(payload)}`);
            (err as Error & { status?: number }).status = response.status;
            throw err;
          }
          const content = payload?.choices?.[0]?.message?.content;
          if (typeof content !== 'string') throw new Error('Mistral vision returned no text content.');
          return content;
        } finally {
          clearTimeout(timer);
        }
      });
    } finally {
      this.releaseVisionSlot();
    }
  }

  private async rawRequest<T>(fn: (entry: KeyEntry) => Promise<T>): Promise<T> {
    const deadline = Date.now() + MAX_WAIT_MS;
    let attempt = 0;
    while (Date.now() < deadline) {
      const entry = this.pick();
      if (!entry) {
        const wait = Math.min(this.msUntilAvailable() + 100, 5_000);
        console.warn(`[MistralPool] All keys in cooldown. Waiting ${wait}ms…`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      try {
        entry.uses++;
        return await Promise.race([
          fn(entry),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Mistral vision timeout (${CALL_TIMEOUT_MS / 1000}s)`)), CALL_TIMEOUT_MS)),
        ]);
      } catch (err) {
        const msg = String(err);
        const status = Number((err as Error & { status?: number }).status || 0);
        const is429 = status === 429 || msg.includes('429') || msg.includes('rate_limited') || msg.includes('Rate limit');
        if (!is429) throw err;
        const retryM = msg.match(/retry.?after[:\s]+(\d+)/i);
        const coolMs = retryM ? parseInt(retryM[1]) * 1_000 : DEFAULT_COOLDOWN_MS;
        this.markRateLimited(entry, coolMs);
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt++);
        console.warn(`[MistralPool] Vision attempt ${attempt} failed (429). Backing off ${backoff}ms before next key.`);
        await new Promise(r => setTimeout(r, Math.min(backoff, 10_000)));
      }
    }
    throw new Error('[MistralPool] Vision keys exhausted and max wait exceeded.');
  }

  getClient(): Mistral {
    const entry = this.pick() ?? this.entries[0];
    return entry.client;
  }

  status(): { total: number; available: number; cooled: number; visionActive: number; visionQueued: number } {
    const now = Date.now();
    const cooled = this.entries.filter(e => e.cooldownUntil > now).length;
    return {
      total: this.entries.length,
      available: this.entries.length - cooled,
      cooled,
      visionActive: this.visionActive,
      visionQueued: this.visionQueue.length,
    };
  }
}

export const mistralPool = new MistralKeyPool();
