import { Router } from 'express';
import { query } from '../db/index.js';
const router = Router();
router.get('/', async (_req, res) => {
    try {
        const rows = await query(`SELECT id, session_id, event_date, sport, fixture, league, prediction_market,
              goal_statement, probability, confidence_score, star_rating, recommended_odds,
              expected_value, closing_line_value, status, raw_analysis, created_at
       FROM predictions ORDER BY created_at DESC LIMIT 100`);
        res.json({ predictions: rows });
    }
    catch (err) {
        console.error('[Predictions] List:', err);
        res.status(500).json({ error: 'Failed to load predictions' });
    }
});
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const rows = await query(`SELECT p.*, fv.odds_data, fv.injuries_json, fv.player_data,
              fv.monte_carlo_home_win, fv.monte_carlo_draw, fv.monte_carlo_away_win,
              fv.monte_carlo_std_dev, fv.reverse_line_movement, fv.value_edge_home,
              fv.public_betting_pct, fv.handle_pct, fv.line_delta, fv.confidence_tier
       FROM predictions p
       LEFT JOIN feature_vectors fv ON fv.prediction_id = p.id
       WHERE p.id = ?`, [id]);
        if (!rows.length)
            return res.status(404).json({ error: 'Not found' });
        res.json({ prediction: rows[0] });
    }
    catch (err) {
        console.error('[Predictions] Get:', err);
        res.status(500).json({ error: 'Failed to load prediction' });
    }
});
router.patch('/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    const valid = ['pending', 'won', 'lost', 'void'];
    if (!status || !valid.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${valid.join(', ')}` });
    }
    try {
        await query('UPDATE predictions SET status = ? WHERE id = ?', [status, id]);
        const rows = await query('SELECT * FROM predictions WHERE id = ?', [id]);
        if (!rows.length)
            return res.status(404).json({ error: 'Not found' });
        res.json({ prediction: rows[0] });
    }
    catch (err) {
        console.error('[Predictions] Status update:', err);
        res.status(500).json({ error: 'Failed to update' });
    }
});
// PATCH /api/predictions/:id/result — record closing odds + actual result → compute CLV + ROI
// Call this after the market closes (e.g. from Telegram or a cron job).
//
// CLV = our opening odds edge vs closing line
//   If we bet at odds O and market closed at implied prob P_close:
//   CLV = (1/P_close) - O  → positive means we had value at bet time
//
router.patch('/:id/result', async (req, res) => {
    const { id } = req.params;
    const { closingOdds, actualResult, status } = req.body;
    const validStatus = ['won', 'lost', 'void'];
    if (status && !validStatus.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${validStatus.join(', ')}` });
    }
    try {
        const rows = await query('SELECT recommended_odds, probability, status FROM predictions WHERE id = ?', [id]);
        if (!rows.length)
            return res.status(404).json({ error: 'Not found' });
        const pred = rows[0];
        const openingOdds = Number(pred.recommended_odds) || 0;
        // CLV: closing implied prob vs our opening odds
        let clvAchieved = null;
        if (closingOdds && closingOdds > 1 && openingOdds > 1) {
            const closingImplied = 1 / closingOdds;
            const ourImplied = 1 / openingOdds;
            clvAchieved = ourImplied - closingImplied; // positive = we beat the close
        }
        // ROI: +odds-1 if won, -1 if lost, 0 if void
        let roi = null;
        const resolvedStatus = status || String(pred.status || 'pending');
        if (resolvedStatus === 'won' && openingOdds > 1)
            roi = openingOdds - 1;
        if (resolvedStatus === 'lost')
            roi = -1;
        if (resolvedStatus === 'void')
            roi = 0;
        await query(`UPDATE predictions SET
         closing_odds   = COALESCE(?, closing_odds),
         actual_result  = COALESCE(?, actual_result),
         clv_achieved   = COALESCE(?, clv_achieved),
         roi            = COALESCE(?, roi),
         status         = COALESCE(?, status)
       WHERE id = ?`, [
            closingOdds ?? null,
            actualResult ?? null,
            clvAchieved ?? null,
            roi ?? null,
            status ?? null,
            id,
        ]);
        const updated = await query('SELECT * FROM predictions WHERE id = ?', [id]);
        res.json({
            prediction: updated[0],
            computed: { clvAchieved, roi },
        });
    }
    catch (err) {
        console.error('[Predictions] Result update:', err);
        res.status(500).json({ error: 'Failed to record result' });
    }
});
// GET /api/predictions/stats/calibration — bucket predictions by prob range, compute actual win rates
router.get('/stats/calibration', async (_req, res) => {
    try {
        const rows = await query(`
      SELECT
        CASE
          WHEN probability >= 50 AND probability < 55 THEN '0.50–0.55'
          WHEN probability >= 55 AND probability < 60 THEN '0.55–0.60'
          WHEN probability >= 60 AND probability < 65 THEN '0.60–0.65'
          WHEN probability >= 65 AND probability < 70 THEN '0.65–0.70'
          WHEN probability >= 70                       THEN '0.70+'
          ELSE '<0.50'
        END                                                        AS bucket,
        COUNT(*)                                                   AS total_bets,
        ROUND(AVG(probability) / 100, 4)                          AS avg_predicted_prob,
        ROUND(SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) /
              NULLIF(COUNT(*), 0), 4)                              AS actual_win_rate,
        SUM(CASE WHEN status = 'won'  THEN 1 ELSE 0 END)          AS wins,
        SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END)          AS losses,
        ROUND(AVG(ABS(probability / 100 -
              CASE WHEN status = 'won' THEN 1 ELSE 0 END)), 4)    AS avg_brier_component,
        CASE
          WHEN ABS(AVG(probability) / 100 -
                   SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) /
                   NULLIF(COUNT(*), 0)) > 0.05
          THEN 'MIS-CALIBRATED'
          ELSE 'CALIBRATED'
        END                                                        AS calibration_status
      FROM predictions
      WHERE status IN ('won', 'lost')
      GROUP BY bucket
      ORDER BY bucket
    `);
        const totalBets = rows.reduce((s, r) => s + Number(r.total_bets || 0), 0);
        const totalWins = rows.reduce((s, r) => s + Number(r.wins || 0), 0);
        const miscalibrated = rows.some(r => r.calibration_status === 'MIS-CALIBRATED');
        res.json({
            calibration: rows,
            summary: {
                total_resolved: totalBets,
                overall_win_rate: totalBets > 0 ? (totalWins / totalBets).toFixed(4) : null,
                system_status: miscalibrated ? '⚠️ NEEDS CALIBRATION' : totalBets >= 10 ? '✅ VALIDATED' : '⏳ INSUFFICIENT DATA',
            },
        });
    }
    catch (err) {
        console.error('[Predictions] Calibration:', err);
        res.status(500).json({ error: 'Failed to compute calibration' });
    }
});
// GET /api/predictions/stats/edge — model probability vs implied probability (market edge)
router.get('/stats/edge', async (_req, res) => {
    try {
        const rows = await query(`
      SELECT
        id,
        fixture,
        prediction_market,
        probability                                          AS model_prob_pct,
        ROUND(probability / 100, 4)                         AS model_prob,
        recommended_odds,
        ROUND(1 / NULLIF(recommended_odds, 0), 4)           AS implied_prob,
        ROUND(probability / 100 - 1 / NULLIF(recommended_odds, 0), 4)   AS edge,
        expected_value,
        clv_achieved,
        closing_odds,
        status,
        star_rating,
        created_at
      FROM predictions
      WHERE recommended_odds > 1
      ORDER BY created_at DESC
      LIMIT 100
    `);
        const resolved = rows.filter(r => r.clv_achieved !== null);
        const positiveClv = resolved.filter(r => Number(r.clv_achieved) > 0).length;
        const avgClv = resolved.length
            ? (resolved.reduce((s, r) => s + Number(r.clv_achieved), 0) / resolved.length).toFixed(4)
            : null;
        const clvBeatPct = resolved.length ? ((positiveClv / resolved.length) * 100).toFixed(1) : null;
        res.json({
            predictions: rows,
            summary: {
                total: rows.length,
                resolved_count: resolved.length,
                positive_clv_count: positiveClv,
                clv_beat_pct: clvBeatPct ? `${clvBeatPct}%` : null,
                avg_clv: avgClv,
                edge_verdict: resolved.length < 10
                    ? '⏳ INSUFFICIENT DATA'
                    : Number(clvBeatPct) >= 52
                        ? '✅ VALIDATED EDGE'
                        : '❌ NO EDGE',
            },
        });
    }
    catch (err) {
        console.error('[Predictions] Edge:', err);
        res.status(500).json({ error: 'Failed to compute edge stats' });
    }
});
// GET /api/predictions/stats/clv — CLV & ROI summary for calibration analysis
router.get('/stats/clv', async (_req, res) => {
    try {
        const rows = await query(`
      SELECT
        COUNT(*)                                          AS total,
        SUM(CASE WHEN status = 'won'  THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS losses,
        AVG(clv_achieved)                                 AS avg_clv,
        AVG(roi)                                          AS avg_roi,
        AVG(data_completeness_score)                      AS avg_completeness,
        SUM(CASE WHEN clv_achieved > 0 THEN 1 ELSE 0 END) AS positive_clv_count,
        COUNT(closing_odds)                               AS results_recorded
      FROM predictions
      WHERE status IN ('won', 'lost', 'void') OR closing_odds IS NOT NULL
    `);
        res.json({ stats: rows[0] });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to compute CLV stats' });
    }
});
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await query('DELETE FROM predictions WHERE id = ?', [id]);
        res.json({ success: true });
    }
    catch (err) {
        console.error('[Predictions] Delete:', err);
        res.status(500).json({ error: 'Failed to delete' });
    }
});
export default router;
//# sourceMappingURL=predictions.js.map