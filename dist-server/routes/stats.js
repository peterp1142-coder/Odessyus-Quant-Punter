import { Router } from 'express';
import { query } from '../db/index.js';
const router = Router();
router.get('/', async (_req, res) => {
    try {
        const [overall, recent, daily, clv] = await Promise.all([
            query(`
        SELECT
          COUNT(*) AS total,
          SUM(status = 'won') AS won,
          SUM(status = 'lost') AS lost,
          SUM(status = 'pending') AS pending,
          ROUND(100.0 * SUM(status = 'won') /
            NULLIF(SUM(status IN ('won','lost')), 0), 1) AS win_rate_pct,
          ROUND(AVG(probability), 1) AS avg_probability,
          ROUND(AVG(confidence_score), 1) AS avg_confidence,
          ROUND(AVG(star_rating), 2) AS avg_star_rating,
          ROUND(AVG(expected_value), 4) AS avg_ev,
          ROUND(AVG(closing_line_value), 4) AS avg_clv
        FROM predictions
      `),
            query(`
        SELECT id, fixture, prediction_market, probability, confidence_score,
               star_rating, expected_value, status, created_at, goal_statement
        FROM predictions ORDER BY created_at DESC LIMIT 10
      `),
            query(`
        SELECT DATE(created_at) AS date,
          COUNT(*) AS total,
          SUM(status = 'won') AS won,
          SUM(status = 'lost') AS lost,
          ROUND(AVG(expected_value), 4) AS avg_ev
        FROM predictions
        WHERE created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY DATE(created_at)
        ORDER BY date DESC LIMIT 30
      `),
            query(`
        SELECT
          ROUND(AVG(fv.value_edge_home), 4) AS avg_edge,
          ROUND(AVG(fv.reverse_line_movement), 2) AS sharp_signal_rate,
          ROUND(AVG(fv.monte_carlo_std_dev), 4) AS avg_variance
        FROM predictions p
        JOIN feature_vectors fv ON fv.prediction_id = p.id
        WHERE p.created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      `),
        ]);
        res.json({
            overall: overall[0] || {},
            recent,
            daily,
            advanced: clv[0] || {},
        });
    }
    catch (err) {
        console.error('[Stats]:', err);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});
export default router;
//# sourceMappingURL=stats.js.map