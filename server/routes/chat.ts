import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from '../agent/orchestrator.js';
import type { ReActStep } from '../agent/react-engine.js';
import { query } from '../db/index.js';

const router = Router();

// POST /api/chat — register session
router.post('/', async (req: Request, res: Response) => {
  const { message, sessionId: existing } = req.body as { message?: string; sessionId?: string };
  if (!message?.trim()) return res.status(400).json({ error: 'Message is required' });

  const sessionId = existing || uuidv4();
  try {
    await query(
      'INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), sessionId, 'web', 'user', message.trim()]
    );
  } catch (err) { console.error('[Chat] Save user msg:', err); }

  res.json({ sessionId, status: 'started' });
});

// GET /api/chat/stream/:sessionId — SSE stream
router.get('/stream/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;
  const { message } = req.query as { message?: string };
  if (!message?.trim()) return res.status(400).json({ error: 'message query param required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sse = (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat every 15s keeps the proxy from dropping the idle SSE connection
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15_000);

  const cleanup = () => { clearInterval(heartbeat); if (!res.writableEnded) res.end(); };
  req.on('close', () => clearInterval(heartbeat));

  sse('connected', { sessionId, engine: 'orchestrator-v2' });

  let finalAnswer = '';
  try {
    const result = await runOrchestrator(
      message.trim(),
      sessionId,
      (step: ReActStep) => sse('step', step),
    );

    finalAnswer = result.finalAnswer;
    sse('complete', {
      success: result.success,
      finalAnswer: result.finalAnswer,
      stepCount: result.steps.length,
      metadata: result.metadata,
      error: result.error,
    });

    if (result.success && result.finalAnswer) {
      const m = result.metadata;
      const predId = uuidv4();
      try {
        // Derive recommended_odds from implied probability when not parsed from text
        const recommendedOdds = m.recommendedOdds > 1
          ? m.recommendedOdds
          : (m.impliedProb > 0 ? parseFloat((1 / m.impliedProb).toFixed(3)) : null);

        // Truncate free-text fields to their column limits
        const fixtureStr     = String(m.fixture    || '').slice(0, 490);
        const leagueStr      = String(m.sport      || '').slice(0, 190);
        const marketStr      = String(m.market     || '').slice(0, 190);
        const goalStr        = String(m.goalStatement || '').slice(0, 490);

        await query(
          `INSERT INTO predictions
            (id, session_id, fixture, league, prediction_market, goal_statement,
             probability, confidence_score, star_rating, recommended_odds,
             expected_value, data_completeness_score, status,
             raw_analysis, react_trace, feature_snapshot, model_weights, monte_carlo_variance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [
            predId, sessionId, fixtureStr, leagueStr, marketStr, goalStr,
            m.probability, m.confidence, m.starRating,
            recommendedOdds,
            m.expectedValue, m.dataCompletenessScore ?? null,
            result.finalAnswer,
            JSON.stringify(result.steps),
            JSON.stringify(result.metadata),
            JSON.stringify({ agentsRun: m.agentsRun, subagentResults: m.subagentResults }),
            m.monteCarlo.stdDev,
          ]
        );

        // Persist Monte Carlo + market edge into feature_vectors
        try {
          const impliedProbHome = m.impliedProb ?? null;
          const trueProb        = m.trueProb ?? null;
          const valueEdge       = (trueProb != null && impliedProbHome != null)
            ? parseFloat((trueProb - impliedProbHome).toFixed(4))
            : null;

          await query(
            `INSERT INTO feature_vectors
              (id, prediction_id,
               monte_carlo_home_win, monte_carlo_draw, monte_carlo_away_win, monte_carlo_std_dev,
               implied_prob_home, true_prob_home, value_edge_home, confidence_tier)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(), predId,
              m.monteCarlo.home  ?? null,
              m.monteCarlo.draw  ?? null,
              m.monteCarlo.away  ?? null,
              m.monteCarlo.stdDev ?? null,
              impliedProbHome,
              trueProb,
              valueEdge,
              m.starRating ?? null,
            ]
          );
        } catch (fvErr) {
          console.error('[Chat] Save feature_vectors:', fvErr);
        }

        sse('saved', { predictionId: predId });
      } catch (e) { console.error('[Chat] Save prediction:', e); }
    }
  } catch (err) {
    console.error('[Chat] Orchestrator error:', err);
    sse('error', { message: 'Agent error. Please try again.' });
  }

  if (finalAnswer) {
    try {
      await query(
        'INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), sessionId, 'web', 'assistant', finalAnswer]
      );
    } catch { /* ignore */ }
  }

  cleanup();
});

// GET /api/chat/history/:sessionId
router.get('/history/:sessionId', async (req: Request, res: Response) => {
  try {
    const rows = await query<{ id: string; role: string; content: string; created_at: Date }[]>(
      'SELECT id, role, content, created_at FROM conversations WHERE session_id = ? ORDER BY created_at ASC LIMIT 100',
      [req.params.sessionId]
    );
    res.json({ messages: rows, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load history' });
  }
});

export default router;
