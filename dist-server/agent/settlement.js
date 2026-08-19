/**
 * Settlement Cron Job
 *
 * Runs every 30 minutes. For each prediction with status='pending' whose
 * kickoff time has passed, it:
 *   1. Waits until T+2h after kickoff before first attempt (stoppage + delays)
 *   2. Fetches the final score from an independent results API (AllSportsAPI)
 *   3. Applies market-rule-aware settlement (DNB voids on draw, AH push/half-win)
 *   4. Retries at T+6h if no score found, then flags manual_review
 *   5. Logs the result to Airtable
 */
import cron from 'node-cron';
import { query } from '../db/index.js';
import { logResult } from './airtable-logger.js';
import { allSportsLivescore } from './tools.js';
const MAX_RETRY_HOURS = 6;
const INITIAL_DELAY_HOURS = 2;
export function initSettlementCron() {
    console.log('[Settlement] Cron job scheduled (every 30 min)');
    cron.schedule('*/30 * * * *', async () => {
        try {
            await runSettlementPass();
        }
        catch (err) {
            console.error('[Settlement] Error:', err instanceof Error ? err.message : String(err));
        }
    });
}
async function runSettlementPass() {
    const pending = await query(`
    SELECT id, fixture, prediction_market, event_date, recommended_odds, created_at
    FROM predictions
    WHERE status = 'pending'
      AND event_date IS NOT NULL
    LIMIT 50
  `);
    if (!pending.length)
        return;
    const now = Date.now();
    for (const pick of pending) {
        const kickoff = pick.event_date ? new Date(pick.event_date).getTime() : new Date(pick.created_at).getTime();
        const hoursSinceKickoff = (now - kickoff) / (1000 * 60 * 60);
        if (hoursSinceKickoff < INITIAL_DELAY_HOURS)
            continue;
        if (hoursSinceKickoff > MAX_RETRY_HOURS + 24) {
            await flagManualReview(pick.id, 'Exceeded retry window — no score found within 30h');
            continue;
        }
        const score = await fetchScore(pick.fixture);
        if (!score.found) {
            if (hoursSinceKickoff > MAX_RETRY_HOURS) {
                await flagManualReview(pick.id, 'No score found after 6h retry window');
            }
            continue;
        }
        if (score.status && !['Finished', 'FT', 'Full Time', 'Match Finished', 'AP', 'AET'].includes(score.status)) {
            continue;
        }
        const settlement = settleMarket(pick.prediction_market, score.homeScore, score.awayScore);
        await applySettlement(pick, settlement, score);
    }
}
async function fetchScore(fixture) {
    const result = await allSportsLivescore();
    if (!result.success || !result.data)
        return { homeScore: -1, awayScore: -1, status: '', found: false };
    const lines = result.data.split('\n');
    for (const line of lines) {
        if (line.toLowerCase().includes(fixture.toLowerCase().split(' vs ')[0]?.toLowerCase() || '___')) {
            const scoreMatch = line.match(/(\d+)\s*[-:]\s*(\d+)/);
            if (scoreMatch) {
                return {
                    homeScore: parseInt(scoreMatch[1]),
                    awayScore: parseInt(scoreMatch[2]),
                    status: 'FT',
                    found: true,
                };
            }
        }
    }
    return { homeScore: -1, awayScore: -1, status: '', found: false };
}
function settleMarket(market, home, away) {
    const m = market.toLowerCase();
    const totalGoals = home + away;
    const homeWin = home > away;
    const draw = home === away;
    if (m.includes('home win') || (m.includes('match result') && m.includes('home')) || m === '1x2') {
        if (homeWin)
            return { outcome: 'won', actualOutcome: 'home_win', roi: 0 };
        if (draw)
            return { outcome: 'lost', actualOutcome: 'draw', roi: -1 };
        return { outcome: 'lost', actualOutcome: 'away_win', roi: -1 };
    }
    if (m.includes('away win') || (m.includes('match result') && m.includes('away'))) {
        if (!homeWin && !draw)
            return { outcome: 'won', actualOutcome: 'away_win', roi: 0 };
        return { outcome: 'lost', actualOutcome: draw ? 'draw' : 'home_win', roi: -1 };
    }
    if (m.includes('draw')) {
        if (draw)
            return { outcome: 'won', actualOutcome: 'draw', roi: 0 };
        return { outcome: 'lost', actualOutcome: homeWin ? 'home_win' : 'away_win', roi: -1 };
    }
    if (m.includes('dnb') && m.includes('home')) {
        if (homeWin)
            return { outcome: 'won', actualOutcome: 'home_win', roi: 0 };
        if (draw)
            return { outcome: 'void', actualOutcome: 'draw', voidReason: 'DNB — draw refunds stake', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'away_win', roi: -1 };
    }
    if (m.includes('dnb') && m.includes('away')) {
        if (!homeWin && !draw)
            return { outcome: 'won', actualOutcome: 'away_win', roi: 0 };
        if (draw)
            return { outcome: 'void', actualOutcome: 'draw', voidReason: 'DNB — draw refunds stake', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'home_win', roi: -1 };
    }
    if (m.includes('btts') || m.includes('both teams')) {
        const bttsYes = home >= 1 && away >= 1;
        const bttsNo = !bttsYes;
        if (m.includes('yes') && bttsYes)
            return { outcome: 'won', actualOutcome: 'btts_yes', roi: 0 };
        if (m.includes('no') && bttsNo)
            return { outcome: 'won', actualOutcome: 'btts_no', roi: 0 };
        return { outcome: 'lost', actualOutcome: bttsYes ? 'btts_yes' : 'btts_no', roi: -1 };
    }
    if (m.includes('over 2.5') || m.includes('over2.5') || (m.includes('over') && m.includes('2.5'))) {
        if (totalGoals > 2.5)
            return { outcome: 'won', actualOutcome: 'over_2.5', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'under_2.5', roi: -1 };
    }
    if (m.includes('under 2.5') || m.includes('under2.5') || (m.includes('under') && m.includes('2.5'))) {
        if (totalGoals < 2.5)
            return { outcome: 'won', actualOutcome: 'under_2.5', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'over_2.5', roi: -1 };
    }
    if (m.includes('over 3.5') || m.includes('over3.5')) {
        if (totalGoals > 3.5)
            return { outcome: 'won', actualOutcome: 'over_3.5', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'under_3.5', roi: -1 };
    }
    if (m.includes('under 3.5') || m.includes('under3.5')) {
        if (totalGoals < 3.5)
            return { outcome: 'won', actualOutcome: 'under_3.5', roi: 0 };
        return { outcome: 'lost', actualOutcome: 'over_3.5', roi: -1 };
    }
    if (m.includes('asian') || m.includes(' ah ') || m.includes('ah ')) {
        return settleAsianHandicap(market, home, away);
    }
    if (m.includes('double chance') || m.includes('1x') || m.includes('x2') || m.includes('12')) {
        if (m.includes('1x') || (m.includes('home') && m.includes('draw'))) {
            if (homeWin || draw)
                return { outcome: 'won', actualOutcome: '1x', roi: 0 };
            return { outcome: 'lost', actualOutcome: 'away_win', roi: -1 };
        }
        if (m.includes('x2') || (m.includes('away') && m.includes('draw'))) {
            if (!homeWin)
                return { outcome: 'won', actualOutcome: 'x2', roi: 0 };
            return { outcome: 'lost', actualOutcome: 'home_win', roi: -1 };
        }
        if (m.includes('12') || m.includes('home or away')) {
            if (!draw)
                return { outcome: 'won', actualOutcome: '12', roi: 0 };
            return { outcome: 'lost', actualOutcome: 'draw', roi: -1 };
        }
    }
    return { outcome: 'manual_review', actualOutcome: 'unknown_market', voidReason: `Unrecognized market: ${market}`, roi: 0 };
}
function settleAsianHandicap(market, home, away) {
    const m = market.toLowerCase();
    const ahMatch = m.match(/([+-]?\d+\.?\d*)/);
    if (!ahMatch)
        return { outcome: 'manual_review', actualOutcome: 'unknown_ah', voidReason: 'Could not parse AH line', roi: 0 };
    const line = parseFloat(ahMatch[1]);
    const isHome = !m.includes('away');
    const margin = isHome ? home - away + line : away - home + line;
    if (margin > 0.25)
        return { outcome: 'won', actualOutcome: `ah_${isHome ? 'home' : 'away'}_${line}`, roi: 0 };
    if (margin < -0.25)
        return { outcome: 'lost', actualOutcome: `ah_${isHome ? 'home' : 'away'}_${line}`, roi: -1 };
    if (margin === 0)
        return { outcome: 'push', actualOutcome: `ah_${isHome ? 'home' : 'away'}_${line}`, voidReason: 'AH push — stake refunded', roi: 0 };
    if (margin === 0.25)
        return { outcome: 'half_loss', actualOutcome: `ah_${isHome ? 'home' : 'away'}_${line}`, voidReason: 'AH half-loss', roi: -0.5 };
    if (margin === -0.25)
        return { outcome: 'half_win', actualOutcome: `ah_${isHome ? 'home' : 'away'}_${line}`, voidReason: 'AH half-win', roi: 0.5 };
    return { outcome: 'manual_review', actualOutcome: 'unknown_ah', voidReason: `Unresolved AH margin: ${margin}`, roi: 0 };
}
async function applySettlement(pick, settlement, score) {
    const odds = Number(pick.recommended_odds) || 0;
    let roi = settlement.roi;
    if (settlement.outcome === 'won' && odds > 1)
        roi = odds - 1;
    if (settlement.outcome === 'half_win' && odds > 1)
        roi = (odds - 1) * 0.5;
    if (settlement.outcome === 'half_loss')
        roi = -0.5;
    const status = settlement.outcome === 'manual_review' ? 'pending' : settlement.outcome;
    await query(`UPDATE predictions SET
       status = ?,
       actual_result = ?,
       roi = ?,
       closing_odds = COALESCE(closing_odds, recommended_odds)
     WHERE id = ?`, [status, settlement.actualOutcome, roi, pick.id]);
    await logResult({
        predictionId: pick.id,
        fixture: pick.fixture,
        market: pick.prediction_market,
        actualOutcome: settlement.actualOutcome,
        result: settlement.outcome,
        voidReason: settlement.voidReason || '',
        finalScore: `${score.homeScore}-${score.awayScore}`,
        roi,
    }).catch(err => console.error('[Settlement] Airtable log error:', err instanceof Error ? err.message : String(err)));
    console.log(`[Settlement] ${pick.fixture} | ${pick.prediction_market} → ${settlement.outcome} | ${score.homeScore}-${score.awayScore} | ROI: ${roi}`);
}
async function flagManualReview(predictionId, reason) {
    await query('UPDATE predictions SET status = ? WHERE id = ?', ['manual_review', predictionId]);
    await logResult({
        predictionId,
        fixture: '',
        market: '',
        actualOutcome: 'no_score',
        result: 'manual_review',
        voidReason: reason,
        finalScore: '',
        roi: 0,
    }).catch(() => { });
    console.warn(`[Settlement] ${predictionId} flagged for manual review: ${reason}`);
}
//# sourceMappingURL=settlement.js.map