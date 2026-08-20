import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../agent/orchestrator.js';
import type { ReActStep } from '../agent/react-engine.js';
import { query } from '../db/index.js';
import { getAgentPreset } from '../agent/presets.js';

const router = Router();
type JobRow = { id:string; session_id:string; message:string|null; preset:string|null; status:string; steps:string|ReActStep[]|null; final_answer:string|null; error:string|null; result_metadata:string|Record<string,unknown>|null };

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') { try { return JSON.parse(value) as T; } catch { return fallback; } }
  return value as T;
}

async function persistPrediction(sessionId:string, result:{ finalAnswer:string; steps:ReActStep[]; metadata?:Record<string,any> }) {
  const m = result.metadata || {};
  const mc = m.monteCarlo || {};
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
    [predId, sessionId, fixtureStr, leagueStr, marketStr, goalStr,
      m.probability ?? m.trueProb ?? null, m.confidence ?? null, m.starRating ?? null, recommendedOdds,
      m.expectedValue ?? null, m.dataCompletenessScore ?? null, result.finalAnswer,
      JSON.stringify(result.steps), JSON.stringify(result.metadata),
      JSON.stringify({ agentsRun: m.agentsRun, subagentResults: m.subagentResults }), monteCarloStdDev]
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
  return predId;
}

async function executeJob(jobId:string, sessionId:string, effectiveMessage:string) {
  try {
    await query(`UPDATE agent_jobs SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=?`, [jobId]);
    const result = await runOrchestrator(effectiveMessage, sessionId, async (step:ReActStep) => {
      try {
        const rows = await query<{steps:string|null}[]>(`SELECT steps FROM agent_jobs WHERE id=? LIMIT 1`, [jobId]);
        const current = parseJson<ReActStep[]>(rows[0]?.steps, []);
        await query(`UPDATE agent_jobs SET steps=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [JSON.stringify([...current, step]), jobId]);
      } catch (err) { console.warn('[Chat] Job progress save failed:', err); }
    });

    let predictionId:string|undefined;
    if (result.success && result.finalAnswer) {
      try { predictionId = await persistPrediction(sessionId, result); }
      catch (err) { console.error('[Chat] Save prediction:', err); }
      try {
        await query(`INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)`, [uuidv4(), sessionId, 'web', 'assistant', result.finalAnswer]);
      } catch (err) { console.error('[Chat] Save assistant msg:', err); }
    }

    const metadata = { ...(result.metadata || {}), ...(predictionId ? { predictionId } : {}) };
    await query(`UPDATE agent_jobs SET status=?, final_answer=?, result_metadata=?, error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [result.success ? 'completed' : 'failed', result.finalAnswer || null, JSON.stringify(metadata), result.error || null, jobId]);
  } catch (err) {
    console.error('[Chat] Background orchestrator error:', err);
    await query(`UPDATE agent_jobs SET status='failed', error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`, [err instanceof Error ? err.message : String(err), jobId]).catch(()=>{});
  }
}

// POST /api/chat — enqueue a durable background job. The HTTP request is never the lifetime of the agent run.
router.post('/', async (req:Request,res:Response) => {
  const { message, sessionId: existing, preset } = req.body as { message?:string; sessionId?:string; preset?:string };
  const internalPreset = preset ? getAgentPreset(preset) : null;
  if (!message?.trim() && !internalPreset) return res.status(400).json({error:'Message is required'});
  if (preset && !internalPreset) return res.status(400).json({error:'Unknown agent preset'});
  const sessionId = existing || uuidv4();

  try {
    const active = await query<JobRow[]>(`SELECT * FROM agent_jobs WHERE session_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    if (active.length) return res.json({sessionId, jobId:active[0].id, status:active[0].status, resumed:true});

    if (message?.trim() && !internalPreset) {
      await query(`INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)`, [uuidv4(), sessionId, 'web', 'user', message.trim()]);
    }
    const jobId = uuidv4();
    await query(`INSERT INTO agent_jobs (id, session_id, message, preset, status, steps) VALUES (?, ?, ?, ?, 'queued', ?)`, [jobId, sessionId, message?.trim() || null, preset || null, JSON.stringify([])]);
    void executeJob(jobId, sessionId, internalPreset || message!.trim());
    res.json({sessionId, jobId, status:'queued'});
  } catch (err) {
    console.error('[Chat] Queue job:', err);
    res.status(500).json({error:'Failed to start agent job'});
  }
});

// GET /api/chat/stream/:sessionId — attach to an existing durable job. Empty query means "resume the active job".
router.get('/stream/:sessionId', async (req:Request,res:Response) => {
  const {sessionId} = req.params;
  const {message, preset} = req.query as {message?:string;preset?:string};
  let jobRows:JobRow[] = [];
  try {
    if (message?.trim() || preset) {
      jobRows = await query<JobRow[]>(`SELECT * FROM agent_jobs WHERE session_id=? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    } else {
      jobRows = await query<JobRow[]>(`SELECT * FROM agent_jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 1`, [sessionId]);
    }
  } catch { return res.status(500).json({error:'Failed to load agent job'}); }
  if (!jobRows.length) return res.status(404).json({error:'No agent job found for session'});
  const job = jobRows[0];

  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();
  const sse = (event:string,data:unknown) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(()=>{if(!res.writableEnded)res.write(': heartbeat\n\n');},15000);
  let sentSteps = 0;
  let connected = false;

  sse('connected',{sessionId,jobId:job.id,engine:'orchestrator-v2-background',preset:job.preset || undefined,resumed:!message && !preset});

  const tick = async () => {
    try {
      const rows = await query<JobRow[]>(`SELECT * FROM agent_jobs WHERE id=? LIMIT 1`, [job.id]);
      const current = rows[0];
      if (!current) { sse('error',{message:'Agent job disappeared'}); return true; }
      const steps = parseJson<ReActStep[]>(current.steps, []);
      for (let i=sentSteps;i<steps.length;i++) sse('step',steps[i]);
      sentSteps = steps.length;
      connected = true;
      if (current.status === 'completed' || current.status === 'failed') {
        const metadata = parseJson<Record<string,unknown>>(current.result_metadata, {});
        sse('complete',{success:current.status==='completed',finalAnswer:current.final_answer || '',stepCount:steps.length,metadata,error:current.error || undefined});
        const predictionId = typeof metadata.predictionId === 'string' ? metadata.predictionId : null;
        if (predictionId) sse('saved',{predictionId});
        return true;
      }
    } catch (err) { if (!connected) sse('error',{message:'Agent stream error'}); }
    return false;
  };

  await tick();
  const timer = setInterval(async()=>{ if (res.writableEnded) return; const done=await tick(); if(done){clearInterval(timer);clearInterval(heartbeat);res.end();} },1000);
  req.on('close',()=>{ clearInterval(timer); clearInterval(heartbeat); });
});

router.get('/history/:sessionId', async (req:Request,res:Response) => {
  try {
    const rows = await query<{id:string;role:string;content:string;created_at:Date}[]>(`SELECT id, role, content, created_at FROM conversations WHERE session_id=? ORDER BY created_at ASC LIMIT 100`, [req.params.sessionId]);
    res.json({messages:rows,sessionId:req.params.sessionId});
  } catch { res.status(500).json({error:'Failed to load history'}); }
});

export default router;
