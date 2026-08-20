import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../agent/orchestrator.js';
import type { ReActStep } from '../agent/react-engine.js';
import { query } from '../db/index.js';
import { getAgentPreset } from '../agent/presets.js';

const router = Router();

type JobStatus = 'running' | 'completed' | 'failed';
type JobEvent = { event: string; data: unknown };
type BackgroundJob = {
  jobId: string;
  sessionId: string;
  message: string;
  preset?: string;
  status: JobStatus;
  steps: ReActStep[];
  finalAnswer: string;
  metadata?: Record<string, unknown>;
  error?: string;
  listeners: Set<(event: JobEvent) => void>;
  startedAt: number;
};

// A conversation can contain many tasks. jobId is therefore deliberately
// separate from sessionId. SSE connections are observers only.
const jobs = new Map<string, BackgroundJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function emit(job: BackgroundJob, event: string, data: unknown) {
  for (const listener of job.listeners) {
    try { listener({ event, data }); } catch { /* disconnected observer */ }
  }
}

async function checkpoint(job: BackgroundJob, status = job.status) {
  try {
    await query(
      `INSERT INTO jobs_state (job_id, status, current_checkpoint)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), current_checkpoint = VALUES(current_checkpoint), last_updated = CURRENT_TIMESTAMP`,
      [job.jobId, status, JSON.stringify({
        sessionId: job.sessionId,
        message: job.message,
        preset: job.preset,
        stepCount: job.steps.length,
        finalAnswer: job.finalAnswer || undefined,
        metadata: job.metadata,
        error: job.error,
      })]
    );
  } catch (err) { console.error('[Chat] Job checkpoint failed:', err); }
}

async function persistPrediction(job: BackgroundJob, result: { finalAnswer: string; metadata?: Record<string, unknown> }) {
  if (!result.finalAnswer) return;
  const m = result.metadata || {};
  const mc = (m.monteCarlo || {}) as Record<string, unknown>;
  const predId = uuidv4();
  const recommendedOdds = Number(m.recommendedOdds) > 1
    ? Number(m.recommendedOdds)
    : (Number(m.impliedProb) > 0 ? parseFloat((1 / Number(m.impliedProb)).toFixed(3)) : null);
  const fixtureStr = String(m.fixture || '').slice(0, 490);
  const leagueStr = String(m.sport || '').slice(0, 190);
  const marketStr = String(m.market || '').slice(0, 190);
  const goalStr = String(m.goalStatement || '').slice(0, 490);
  const monteCarloStdDev = Number.isFinite(Number(mc.stdDev)) ? Number(mc.stdDev) : null;

  await query(
    `INSERT INTO predictions
      (id, session_id, fixture, league, prediction_market, goal_statement,
       probability, confidence_score, star_rating, recommended_odds,
       expected_value, data_completeness_score, status,
       raw_analysis, react_trace, feature_snapshot, model_weights, monte_carlo_variance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [predId, job.sessionId, fixtureStr, leagueStr, marketStr, goalStr,
      m.probability ?? m.trueProb ?? null, m.confidence ?? null, m.starRating ?? null, recommendedOdds,
      m.expectedValue ?? null, m.dataCompletenessScore ?? null, result.finalAnswer,
      JSON.stringify(job.steps), JSON.stringify(result.metadata),
      JSON.stringify({ agentsRun: m.agentsRun, subagentResults: m.subagentResults }),
      monteCarloStdDev]
  );

  if (Number.isFinite(Number(mc.home)) || Number.isFinite(Number(mc.draw)) || Number.isFinite(Number(mc.away)) || monteCarloStdDev !== null) {
    try {
      const impliedProbHome = m.impliedProb ?? null;
      const trueProb = m.trueProb ?? null;
      const valueEdge = (trueProb != null && impliedProbHome != null)
        ? parseFloat((Number(trueProb) - Number(impliedProbHome)).toFixed(4)) : null;
      await query(
        `INSERT INTO feature_vectors
          (id, prediction_id, monte_carlo_home_win, monte_carlo_draw, monte_carlo_away_win, monte_carlo_std_dev,
           implied_prob_home, true_prob_home, value_edge_home, confidence_tier)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), predId, mc.home ?? null, mc.draw ?? null, mc.away ?? null, monteCarloStdDev,
          impliedProbHome, trueProb, valueEdge, m.starRating ?? null]
      );
    } catch (fvErr) { console.error('[Chat] Save feature_vectors:', fvErr); }
  }
  emit(job, 'saved', { predictionId: predId });
}

function startBackgroundJob(jobId: string, sessionId: string, message: string, preset?: string) {
  const existing = jobs.get(jobId);
  if (existing) return existing;

  const job: BackgroundJob = {
    jobId, sessionId, message, preset, status: 'running', steps: [], finalAnswer: '',
    listeners: new Set(), startedAt: Date.now(),
  };
  jobs.set(jobId, job);
  void checkpoint(job, 'running');

  void (async () => {
    try {
      const result = await runOrchestrator(message, sessionId, (step: ReActStep) => {
        job.steps.push(step);
        emit(job, 'step', step);
        if (job.steps.length === 1 || job.steps.length % 5 === 0) void checkpoint(job, 'running');
      });

      job.status = result.success ? 'completed' : 'failed';
      job.finalAnswer = result.finalAnswer || '';
      job.metadata = result.metadata;
      job.error = result.error;
      await checkpoint(job, job.status);
      emit(job, 'complete', {
        success: result.success,
        finalAnswer: result.finalAnswer,
        stepCount: result.steps.length,
        metadata: result.metadata,
        error: result.error,
      });

      if (result.success && result.finalAnswer) {
        try { await persistPrediction(job, result); }
        catch (err) { console.error('[Chat] Save prediction:', err); }
        try {
          await query('INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)',
            [uuidv4(), sessionId, 'web', 'assistant', result.finalAnswer]);
        } catch (err) { console.error('[Chat] Save assistant message:', err); }
      }
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      await checkpoint(job, 'failed');
      console.error('[Chat] Orchestrator error:', err);
      emit(job, 'error', { message: 'Agent error. Please try again.' });
    }
  })();

  return job;
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && job.startedAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

router.post('/', async (req: Request, res: Response) => {
  const { message, sessionId: existingSessionId, preset } = req.body as { message?: string; sessionId?: string; preset?: string };
  const internalPreset = preset ? getAgentPreset(preset) : null;
  if (!message?.trim() && !internalPreset) return res.status(400).json({ error: 'Message is required' });
  if (preset && !internalPreset) return res.status(400).json({ error: 'Unknown agent preset' });

  const sessionId = existingSessionId || uuidv4();
  if (message?.trim() && !internalPreset) {
    try {
      await query('INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)', [uuidv4(), sessionId, 'web', 'user', message.trim()]);
    } catch (err) { console.error('[Chat] Save user msg:', err); }
  }

  const jobId = uuidv4();
  const job = startBackgroundJob(jobId, sessionId, internalPreset || message!.trim(), preset);
  res.json({ sessionId, jobId, status: job.status });
});

// GET /api/chat/stream/:jobId — reconnectable SSE observer.
router.get('/stream/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const { message, preset, sessionId } = req.query as { message?: string; preset?: string; sessionId?: string };
  let job = jobs.get(jobId);

  if (!job) {
    const internalPreset = preset ? getAgentPreset(preset) : null;
    const effectiveMessage = internalPreset || message?.trim();
    if (!effectiveMessage || !sessionId) return res.status(404).json({ error: 'Task not found' });
    if (preset && !internalPreset) return res.status(400).json({ error: 'Unknown agent preset' });
    job = startBackgroundJob(jobId, sessionId, effectiveMessage, preset);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sse = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': heartbeat\n\n'); }, 15_000);
  const listener = ({ event, data }: JobEvent) => sse(event, data);
  job.listeners.add(listener);

  sse('connected', { sessionId: job.sessionId, jobId: job.jobId, engine: 'orchestrator-v2-background', preset: job.preset, status: job.status });
  if (job.steps.length) for (const step of job.steps) sse('step', step);
  if (job.status === 'completed') {
    sse('complete', { success: true, finalAnswer: job.finalAnswer, stepCount: job.steps.length, metadata: job.metadata });
  } else if (job.status === 'failed') {
    sse('error', { message: job.error || 'Agent error. Please try again.' });
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    job?.listeners.delete(listener);
    // Refresh/navigation only closes this observer. The background job continues.
  });
});

router.get('/history/:sessionId', async (req: Request, res: Response) => {
  try {
    const rows = await query<{ id: string; role: string; content: string; created_at: Date }[]>(
      'SELECT id, role, content, created_at FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT 100',
      [req.params.sessionId]
    );
    res.json({ messages: rows, sessionId: req.params.sessionId });
  } catch (err) { res.status(500).json({ error: 'Failed to load history' }); }
});

export default router;
