/**
 * AgentCheckpoint — file-based state persistence for ReAct agent loops.
 *
 * Each checkpoint stores the full message history, completed steps, iteration
 * counter, and raw output for one (sessionId + agentName) pair.  Agents load
 * their checkpoint at start and resume from the last saved iteration rather
 * than restarting from scratch on 429 or process restart.
 *
 * Files are written to /tmp/odessyus-checkpoints/ and expire after TTL_MS.
 */

import fs from 'fs/promises';
import path from 'path';

const CHECKPOINT_DIR = '/tmp/odessyus-checkpoints';
const TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

type MsgRole = 'user' | 'assistant' | 'system';
export interface CheckpointMessage { role: MsgRole; content: string; }

export interface AgentCheckpoint {
  sessionId: string;
  agentName: string;
  messages: CheckpointMessage[];
  iteration: number;
  steps: unknown[];          // ReActStep[] — kept generic to avoid circular import
  rawOutput: string;
  accumulatedData: Record<string, unknown>;  // structured data gathered so far
  savedAt: number;           // epoch ms
  version: 2 | 3;            // bump on breaking schema changes
}

// ─── Private helpers ─────────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  try { await fs.mkdir(CHECKPOINT_DIR, { recursive: true }); } catch { /* exists */ }
}

function filePath(sessionId: string, agentName: string): string {
  // sanitise to avoid directory traversal
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(CHECKPOINT_DIR, `${safe(sessionId)}__${safe(agentName)}.json`);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Persist current agent state to disk.  Fire-and-forget; errors are logged. */
export async function saveCheckpoint(cp: AgentCheckpoint): Promise<void> {
  try {
    await ensureDir();
    await fs.writeFile(filePath(cp.sessionId, cp.agentName), JSON.stringify({ ...cp, savedAt: Date.now() }), 'utf8');
  } catch (err) {
    console.warn(`[Checkpoint] Save failed (${cp.agentName}):`, err);
  }
}

/** Load a checkpoint.  Returns null if missing, expired, or corrupt. */
export async function loadCheckpoint(
  sessionId: string,
  agentName: string,
): Promise<AgentCheckpoint | null> {
  try {
    const raw = await fs.readFile(filePath(sessionId, agentName), 'utf8');
    const cp = JSON.parse(raw) as AgentCheckpoint;
    if (cp.version !== 2 && cp.version !== 3) return null;
    if (Date.now() - cp.savedAt > TTL_MS) {
      await clearCheckpoint(sessionId, agentName);
      return null;
    }
    console.log(`[Checkpoint] Resumed ${agentName} @ iteration ${cp.iteration} (session ${sessionId.slice(0, 8)}…)`);
    return cp;
  } catch {
    return null;
  }
}

/** Delete a checkpoint (call after successful completion). */
export async function clearCheckpoint(sessionId: string, agentName: string): Promise<void> {
  try { await fs.unlink(filePath(sessionId, agentName)); } catch { /* doesn't exist */ }
}

/** List all live checkpoints for a session (for debug / status endpoint). */
export async function listSessionCheckpoints(sessionId: string): Promise<string[]> {
  try {
    await ensureDir();
    const files = await fs.readdir(CHECKPOINT_DIR);
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return files.filter(f => f.startsWith(safe + '__')).map(f => f.replace(safe + '__', '').replace('.json', ''));
  } catch { return []; }
}

/** Purge all checkpoints older than TTL. Run on server start. */
export async function purgeExpiredCheckpoints(): Promise<void> {
  try {
    await ensureDir();
    const files = await fs.readdir(CHECKPOINT_DIR);
    for (const file of files) {
      const fp = path.join(CHECKPOINT_DIR, file);
      try {
        const raw = await fs.readFile(fp, 'utf8');
        const cp = JSON.parse(raw) as { savedAt?: number };
        if (!cp.savedAt || Date.now() - cp.savedAt > TTL_MS) await fs.unlink(fp);
      } catch { await fs.unlink(fp).catch(() => {}); }
    }
  } catch { /* ignore */ }
}
