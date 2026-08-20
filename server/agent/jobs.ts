import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { runOrchestrator } from './orchestrator.js';
import type { ReActStep } from './react-engine.js';
import { getAgentPreset } from './presets.js';

export type AgentJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface AgentJobResult {
  success: boolean;
  finalAnswer: string;
  stepCount: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

interface AgentJob {
  id: string;
  sessionId: string;
  status: AgentJobStatus;
  steps: ReActStep[];
  result?: AgentJobResult;
  predictionId?: string;
  error?: string;
  emitter: EventEmitter;
  promise: Promise<void>;
}

const jobs = new Map<string, AgentJob>();
const MAX_MEMORY_JOBS = 100;

function serialize(value: unknown): string {
  try { return JSON.stringify(value); } catch { return '{}'; }
}

async function persist(job: AgentJob) {
  try {
    await query(
      `INSERT INTO agent_jobs (id, session_id, status, steps, result, prediction_id, error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON DUPLICATE KEY UPDATE status=VALUES(status), steps=VALUES(steps), result=VALUES(result),
       prediction_id=VALUES(prediction_id), error=VALUES(error), updated_at=CURRENT_TIMESTAMP`,
      [job.id, job.sessionId, job.status, serialize(job.steps), job.result ? serialize(job.result) : null, job.predictionId || null, job.error || null]
    );
  } catch (err) {
    console.error('[Jobs] Persist failed:', err instanceof Error ? err.message : String(err));
  }
}

function trimMemoryJobs() {
  if (jobs.size <= MAX_MEMORY_JOBS) return;
  for (const [id, job] of jobs) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      jobs.delete(id);
      if (jobs.size <= MAX_MEMORY_JOBS) break;
    }
  }
}

export async function createAgentJob(input: { sessionId: string; message?: string; preset?: string }) {
  const internalPreset = input.preset ? getAgentPreset(input.preset) : null;
  const effectiveMessage = internalPreset || input.message?.trim();
  if (!effectiveMessage) throw new Error('message or preset required');

  const id = uuidv4();
  const emitter = new EventEmitter();
  const job: AgentJob = {
    id, sessionId: input.sessionId, status: 'queued', steps: [], emitter,
    promise: Promise.resolve(),
  };
  jobs.set(id, job);
  trimMemoryJobs();
  await persist(job);

  job.promise = (async () => {
    job.status = 'running';
    await persist(job);
    emitter.emit('connected', { jobId: job.id, sessionId: job.sessionId, status: job.status });

    try {
      const result = await runOrchestrator(effectiveMessage, job.sessionId, async (step: ReActStep) => {
        job.steps.push(step);
        // Persist periodically rather than on every token/step to avoid DB pressure.
        if (job.steps.length === 1 || job.steps.length % 3 === 0) await persist(job);
        emitter.emit('step', step);
      });
      job.result = {
        success: result.success,
        finalAnswer: result.finalAnswer,
        stepCount: result.steps.length,
        metadata: result.metadata,
        error: result.error,
      };
      job.status = result.success ? 'completed' : 'failed';
      job.error = result.error;
      await persist(job);
      emitter.emit('complete', job.result);
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.result = { success: false, finalAnswer: '', stepCount: job.steps.length, error: job.error };
      await persist(job);
      emitter.emit('error', { message: 'Agent error. Please try again.' });
      emitter.emit('complete', job.result);
    }
    trimMemoryJobs();
  })();

  // Never let an unhandled background rejection take down the web process.
  void job.promise.catch(err => console.error('[Jobs] Background job failure:', err));
  return { jobId: id, sessionId: input.sessionId };
}

export async function getAgentJob(id: string): Promise<AgentJob | null> {
  const live = jobs.get(id);
  if (live) return live;

  try {
    const rows = await query<any[]>(
      'SELECT id, session_id, status, steps, result, prediction_id, error FROM agent_jobs WHERE id = ? LIMIT 1', [id]
    );
    const row = rows[0];
    if (!row) return null;
    const emitter = new EventEmitter();
    const restored: AgentJob = {
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      steps: typeof row.steps === 'string' ? JSON.parse(row.steps || '[]') : (row.steps || []),
      result: row.result ? (typeof row.result === 'string' ? JSON.parse(row.result) : row.result) : undefined,
      predictionId: row.prediction_id || undefined,
      error: row.error || undefined,
      emitter,
      promise: Promise.resolve(),
    };
    jobs.set(id, restored);
    return restored;
  } catch (err) {
    console.error('[Jobs] Load failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function cancelAgentJob(id: string): Promise<boolean> {
  const job = await getAgentJob(id);
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return false;
  job.status = 'cancelled';
  job.error = 'Cancelled by user';
  await persist(job);
  job.emitter.emit('error', { message: 'Request cancelled.' });
  return true;
}

export function subscribeAgentJob(job: AgentJob, handlers: {
  onStep: (step: ReActStep) => void;
  onComplete: (result: AgentJobResult) => void;
  onError: (data: { message: string }) => void;
}) {
  const onStep = handlers.onStep;
  const onComplete = handlers.onComplete;
  const onError = handlers.onError;
  job.emitter.on('step', onStep);
  job.emitter.on('complete', onComplete);
  job.emitter.on('error', onError);
  return () => {
    job.emitter.off('step', onStep);
    job.emitter.off('complete', onComplete);
    job.emitter.off('error', onError);
  };
}
