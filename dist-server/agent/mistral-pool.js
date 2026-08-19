/**
 * MistralKeyPool — multi-key rotation with per-key 429 cooldown tracking.
 *
 * Keys are loaded from env vars:
 *   MISTRAL_API_KEY          (primary)
 *   MISTRAL_API_KEY_1        (secondary)
 *   MISTRAL_API_KEY_2        (tertiary)
 *   … up to MISTRAL_API_KEY_9
 *
 * On a 429 the key is cooled-down for `cooldownMs` (default 60 s).
 * If every key is in cooldown the pool waits for the soonest to recover,
 * then retries — it never silently drops a request.
 */
import { Mistral } from '@mistralai/mistralai';
const DEFAULT_COOLDOWN_MS = 60_000; // 60 s per key after a 429
const MAX_WAIT_MS = 300_000; // give up waiting after 5 min total
const BASE_BACKOFF_MS = 2_000; // initial backoff between key attempts
const CALL_TIMEOUT_MS = 90_000; // abort a single hanging Mistral call after 90 s
function loadKeys() {
    const raw = [];
    const primary = process.env.MISTRAL_API_KEY;
    if (primary)
        raw.push(primary);
    for (let i = 1; i <= 20; i++) {
        const k = process.env[`MISTRAL_API_KEY_${i}`];
        if (k)
            raw.push(k);
    }
    if (raw.length === 0)
        throw new Error('[MistralPool] No Mistral API keys configured.');
    const unique = [...new Set(raw)];
    console.log(`[MistralPool] Loaded ${unique.length} API key(s).`);
    return unique.map(key => ({ key, client: new Mistral({ apiKey: key }), cooldownUntil: 0, uses: 0 }));
}
class MistralKeyPool {
    entries;
    constructor() {
        this.entries = loadKeys();
    }
    /** Pick the entry with the lowest cooldownUntil that is currently available. */
    pick() {
        const now = Date.now();
        const available = this.entries.filter(e => e.cooldownUntil <= now);
        if (!available.length)
            return null;
        // prefer the one used least recently (lowest uses among available)
        return available.reduce((a, b) => (a.uses <= b.uses ? a : b));
    }
    /** Earliest time any key becomes available again (ms from now). */
    msUntilAvailable() {
        const now = Date.now();
        return Math.max(0, Math.min(...this.entries.map(e => e.cooldownUntil - now)));
    }
    markRateLimited(entry, retryAfterMs = DEFAULT_COOLDOWN_MS) {
        entry.cooldownUntil = Date.now() + retryAfterMs;
        console.warn(`[MistralPool] Key …${entry.key.slice(-6)} rate-limited. Cooled for ${retryAfterMs / 1000}s.`);
    }
    /**
     * Execute `fn(client)` using an available key.
     * Rotates keys on 429, waits if all are in cooldown, re-throws on other errors.
     */
    async call(fn) {
        const deadline = Date.now() + MAX_WAIT_MS;
        let attempt = 0;
        while (Date.now() < deadline) {
            const entry = this.pick();
            if (!entry) {
                // All keys in cooldown — wait for the soonest recovery
                const wait = Math.min(this.msUntilAvailable() + 100, 5_000);
                console.warn(`[MistralPool] All keys in cooldown. Waiting ${wait}ms…`);
                await new Promise(r => setTimeout(r, wait));
                continue;
            }
            try {
                entry.uses++;
                // Race the actual API call against a hard timeout so a hanging network
                // call can never stall the whole agent pipeline indefinitely.
                const result = await Promise.race([
                    fn(entry.client),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Mistral call timeout (${CALL_TIMEOUT_MS / 1000}s)`)), CALL_TIMEOUT_MS)),
                ]);
                return result;
            }
            catch (err) {
                const msg = String(err);
                const is429 = msg.includes('429') || msg.includes('rate_limited') || msg.includes('Rate limit');
                const isTimeout = msg.includes('Mistral call timeout');
                // Timeouts: cool the key briefly then rotate — don't propagate as crash
                if (isTimeout) {
                    this.markRateLimited(entry, 15_000); // 15 s cooldown for timeout keys
                    console.warn(`[MistralPool] Key …${entry.key.slice(-6)} timed out. Rotating.`);
                    attempt++;
                    continue;
                }
                if (!is429)
                    throw err; // non-rate-limit, non-timeout errors propagate immediately
                // Parse Retry-After if embedded in the error message
                const retryM = msg.match(/retry.?after[:\s]+(\d+)/i);
                const coolMs = retryM ? parseInt(retryM[1]) * 1_000 : DEFAULT_COOLDOWN_MS;
                this.markRateLimited(entry, coolMs);
                // Exponential back-off before trying the next key
                const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
                attempt++;
                console.warn(`[MistralPool] Attempt ${attempt} failed (429). Backing off ${backoff}ms before next key.`);
                await new Promise(r => setTimeout(r, Math.min(backoff, 10_000)));
            }
        }
        throw new Error('[MistralPool] All keys exhausted and max wait exceeded. Request dropped.');
    }
    /** Convenience: get a Mistral client for one-off use (returns first available) */
    getClient() {
        const entry = this.pick() ?? this.entries[0];
        return entry.client;
    }
    status() {
        const now = Date.now();
        const cooled = this.entries.filter(e => e.cooldownUntil > now).length;
        return { total: this.entries.length, available: this.entries.length - cooled, cooled };
    }
}
// Singleton — one pool shared across the whole process
export const mistralPool = new MistralKeyPool();
//# sourceMappingURL=mistral-pool.js.map