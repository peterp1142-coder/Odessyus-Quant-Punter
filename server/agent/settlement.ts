/**
 * Settlement Cron Job
 *
 * Settles the exact selected market for each prediction. A missing selection is
 * never guessed and is sent to manual review instead of silently defaulting to 1X2.
 */

import cron from 'node-cron';
import { query } from '../db/index.js';
import { logResult } from './airtable-logger.js';
import { allSportsFinalScores, allSportsLivescore } from './tools.js';

interface PendingPick {
  id: string;
  fixture: string;
  prediction_market: string;
  prediction_selection: string | null;
  goal_statement: string | null;
  event_date: Date | null;
  recommended_odds: number | null;
  created_at: Date;
}

interface ScoreResult {
  homeScore: number;
  awayScore: number;
  status: string;
  found: boolean;
}

interface SettlementResult {
  outcome: 'won' | 'lost' | 'void' | 'half_win' | 'half_loss' | 'push' | 'manual_review';
  actualOutcome: string;
  voidReason?: string;
  roi: number;
}

const MAX_RETRY_HOURS = 6;
const INITIAL_DELAY_HOURS = 2;

export function initSettlementCron(): void {
  console.log('[Settlement] Cron job scheduled (every 30 min)');

  cron.schedule('*/30 * * * *', async () => {
    try {
      await runSettlementPass();
    } catch (err) {
      console.error('[Settlement] Error:', err instanceof Error ? err.message : String(err));
    }
  });

  setTimeout(() => {
    void runSettlementPass().catch(err =>
      console.error('[Settlement] Startup pass error:', err instanceof Error ? err.message : String(err))
    );
  }, 60_000);
}

async function runSettlementPass(): Promise<void> {
  const pending = await query<PendingPick[]>(`
    SELECT id, fixture, prediction_market, prediction_selection, goal_statement, event_date, recommended_odds, created_at
    FROM predictions
    WHERE status = 'pending'
      AND event_date IS NOT NULL
    ORDER BY event_date ASC
    LIMIT 500
  `);

  if (!pending.length) return;

  const now = Date.now();

  for (const pick of pending) {
    const kickoff = pick.event_date
      ? new Date(pick.event_date).getTime()
      : new Date(pick.created_at).getTime();
    const hoursSinceKickoff = (now - kickoff) / (1000 * 60 * 60);

    if (hoursSinceKickoff < INITIAL_DELAY_HOURS) continue;
    if (hoursSinceKickoff > MAX_RETRY_HOURS + 24) {
      await flagManualReview(pick.id, 'Exceeded retry window — no final score found within 30h');
      continue;
    }

    const score = await fetchScore(pick.fixture, pick.event_date);
    if (!score.found) {
      if (hoursSinceKickoff > MAX_RETRY_HOURS) {
        await flagManualReview(pick.id, 'No final score found after 6h retry window');
      }
      continue;
    }

    if (score.status && !['Finished', 'FT', 'Full Time', 'Match Finished', 'AP', 'AET', 'final'].includes(score.status)) {
      continue;
    }

    const selection = resolveSelection(pick);
    const settlement = settleMarket(pick.prediction_market, selection, score.homeScore, score.awayScore);
    await applySettlement(pick, settlement, score, selection);
  }
}

function resolveSelection(pick: PendingPick): string | null {
  if (pick.prediction_selection && pick.prediction_selection.trim()) {
    return pick.prediction_selection.trim();
  }

  if (pick.goal_statement) {
    try {
      const parsed = JSON.parse(pick.goal_statement);
      const candidate = parsed?.primaryBet?.selection || parsed?.primaryBet?.pick || parsed?.primaryBet?.name;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    } catch {
      // Older rows may contain prose instead of the structured selection payload.
    }
  }

  return null;
}

function normalizeTeam(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function splitFixture(fixture: string): [string, string] {
  const parts = fixture.split(/\s+(?:vs\.?|v\.?)\s+/i).map(s => s.trim()).filter(Boolean);
  return [parts[0] || '', parts[1] || ''];
}

async function fetchScore(fixture: string, eventDate: Date | null): Promise<ScoreResult> {
  const [home, away] = splitFixture(fixture);
  if (!home || !away) return { homeScore: -1, awayScore: -1, status: '', found: false };

  const targetDate = eventDate
    ? new Date(eventDate).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const homeNorm = normalizeTeam(home);
  const awayNorm = normalizeTeam(away);

  const finished = await allSportsFinalScores(targetDate, targetDate).catch(() => ({ success: false, data: '' } as any));
  if (finished.success && finished.data) {
    for (const line of String(finished.data).split('\n')) {
      const parts = line.split(' | ').map(v => v.trim());
      const lineHome = normalizeTeam(parts[2] || '');
      const lineAway = normalizeTeam(parts[3] || '');
      const homeScore = Number(parts[4]);
      const awayScore = Number(parts[5]);
      if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
      const teamsMatch =
        (lineHome === homeNorm && lineAway === awayNorm) ||
        (lineHome.includes(homeNorm) && lineAway.includes(awayNorm));
      if (teamsMatch) {
        return {
          homeScore,
          awayScore,
          status: parts[6] || 'FT',
          found: true,
        };
      }
    }
  }

  const live = await allSportsLivescore().catch(() => ({ success: false, data: '' } as any));
  if (live.success && live.data) {
    for (const line of String(live.data).split('\n')) {
      const normalized = normalizeTeam(line);
      if (!normalized.includes(homeNorm) || !normalized.includes(awayNorm)) continue;
      const scoreMatch = line.match(/(\d+)\s*[-:]\s*(\d+)/);
      if (!scoreMatch) continue;
      return {
        homeScore: Number(scoreMatch[1]),
        awayScore: Number(scoreMatch[2]),
        status: 'FT',
        found: true,
      };
    }
  }

  return { homeScore: -1, awayScore: -1, status: '', found: false };
}

function settleMarket(market: string, selection: string | null, home: number, away: number): SettlementResult {
  const m = market.toLowerCase().trim();
  const s = String(selection || '').toLowerCase().trim();

  if (!s) {
    return {
      outcome: 'manual_review',
      actualOutcome: 'missing_selection',
      voidReason: `Missing exact selection for market: ${market}`,
      roi: 0,
    };
  }

  const totalGoals = home + away;
  const homeWin = home > away;
  const awayWin = away > home;
  const draw = home === away;

  const homeSelection = /\b(home|home win|1|1x2 home)\b/i.test(s);
  const awaySelection = /\b(away|away win|2|1x2 away)\b/i.test(s);
  const drawSelection = /^draw$|\bdraw\b/i.test(s);

  if (m.includes('1x2') || m.includes('match result') || m === 'result') {
    if (homeSelection) return homeWin ? { outcome: 'won', actualOutcome: 'home_win', roi: 0 } : { outcome: 'lost', actualOutcome: draw ? 'draw' : 'away_win', roi: -1 };
    if (awaySelection) return awayWin ? { outcome: 'won', actualOutcome: 'away_win', roi: 0 } : { outcome: 'lost', actualOutcome: draw ? 'draw' : 'home_win', roi: -1 };
    if (drawSelection) return draw ? { outcome: 'won', actualOutcome: 'draw', roi: 0 } : { outcome: 'lost', actualOutcome: homeWin ? 'home_win' : 'away_win', roi: -1 };
    return { outcome: 'manual_review', actualOutcome: 'unknown_1x2_selection', voidReason: `Unrecognized 1X2 selection: ${selection}`, roi: 0 };
  }

  if (m.includes('dnb') || m.includes('draw no bet')) {
    if (homeSelection) {
      if (homeWin) return { outcome: 'won', actualOutcome: 'home_win', roi: 0 };
      if (draw) return { outcome: 'void', actualOutcome: 'draw', voidReason: 'DNB — draw refunds stake', roi: 0 };
      return { outcome: 'lost', actualOutcome: 'away_win', roi: -1 };
    }
    if (awaySelection) {
      if (awayWin) return { outcome: 'won', actualOutcome: 'away_win', roi: 0 };
      if (draw) return { outcome: 'void', actualOutcome: 'draw', voidReason: 'DNB — draw refunds stake', roi: 0 };
      return { outcome: 'lost', actualOutcome: 'home_win', roi: -1 };
    }
    return { outcome: 'manual_review', actualOutcome: 'unknown_dnb_selection', voidReason: `Unrecognized DNB selection: ${selection}`, roi: 0 };
  }

  if (m.includes('btts') || m.includes('both teams')) {
    const yes = home > 0 && away > 0;
    const wantsYes = /\byes\b/i.test(s);
    const wantsNo = /\bno\b/i.test(s);
    if (wantsYes) return yes ? { outcome: 'won', actualOutcome: 'btts_yes', roi: 0 } : { outcome: 'lost', actualOutcome: 'btts_no', roi: -1 };
    if (wantsNo) return !yes ? { outcome: 'won', actualOutcome: 'btts_no', roi: 0 } : { outcome: 'lost', actualOutcome: 'btts_yes', roi: -1 };
    return { outcome: 'manual_review', actualOutcome: 'unknown_btts_selection', voidReason: `Unrecognized BTTS selection: ${selection}`, roi: 0 };
  }

  const under25 = /under\s*2\.5/i.test(`${m} ${s}`);
  const over25 = /over\s*2\.5/i.test(`${m} ${s}`);
  const under35 = /under\s*3\.5/i.test(`${m} ${s}`);
  const over35 = /over\s*3\.5/i.test(`${m} ${s}`);
  if (under25) return totalGoals < 2.5 ? { outcome: 'won', actualOutcome: 'under_2.5', roi: 0 } : { outcome: 'lost', actualOutcome: 'over_2.5', roi: -1 };
  if (over25) return totalGoals > 2.5 ? { outcome: 'won', actualOutcome: 'over_2.5', roi: 0 } : { outcome: 'lost', actualOutcome: 'under_2.5', roi: -1 };
  if (under35) return totalGoals < 3.5 ? { outcome: 'won', actualOutcome: 'under_3.5', roi: 0 } : { outcome: 'lost', actualOutcome: 'over_3.5', roi: -1 };
  if (over35) return totalGoals > 3.5 ? { outcome: 'won', actualOutcome: 'over_3.5', roi: 0 } : { outcome: 'lost', actualOutcome: 'under_3.5', roi: -1 };

  if (m.includes('double chance') || /^(1x|x2|12)$/i.test(s)) {
    if (s === '1x') return homeWin || draw ? { outcome: 'won', actualOutcome: '1x', roi: 0 } : { outcome: 'lost', actualOutcome: 'away_win', roi: -1 };
    if (s === 'x2') return awayWin || draw ? { outcome: 'won', actualOutcome: 'x2', roi: 0 } : { outcome: 'lost', actualOutcome: 'home_win', roi: -1 };
    if (s === '12') return !draw ? { outcome: 'won', actualOutcome: '12', roi: 0 } : { outcome: 'lost', actualOutcome: 'draw', roi: -1 };
    return { outcome: 'manual_review', actualOutcome: 'unknown_double_chance_selection', voidReason: `Unrecognized double-chance selection: ${selection}`, roi: 0 };
  }

  if (m.includes('asian') || m.includes('handicap') || /[+-]\s*\d+(?:\.\d+)?/.test(s)) {
    return settleAsianHandicap(`${market} ${selection}`, home, away);
  }

  return {
    outcome: 'manual_review',
    actualOutcome: 'unsupported_market',
    voidReason: `Automatic settlement not implemented for market/selection: ${market} / ${selection}`,
    roi: 0,
  };
}

function settleAsianHandicap(marketAndSelection: string, home: number, away: number): SettlementResult {
  const text = marketAndSelection.toLowerCase();
  const ahMatch = text.match(/([+-]?\d+(?:\.\d+)?)/);
  if (!ahMatch) return { outcome: 'manual_review', actualOutcome: 'unknown_ah', voidReason: 'Could not parse Asian Handicap line', roi: 0 };

  const line = Number(ahMatch[1]);
  const isAway = /away|+?\d|-?\d/.test(text) && text.includes('away');
  const margin = isAway ? away - home + line : home - away + line;

  if (margin > 0.25) return { outcome: 'won', actualOutcome: `ah_${isAway ? 'away' : 'home'}_${line}`, roi: 0 };
  if (margin < -0.25) return { outcome: 'lost', actualOutcome: `ah_${isAway ? 'away' : 'home'}_${line}`, roi: -1 };
  if (margin === 0) return { outcome: 'push', actualOutcome: `ah_${isAway ? 'away' : 'home'}_${line}`, voidReason: 'Asian Handicap push — stake refunded', roi: 0 };
  if (margin === 0.25) return { outcome: 'half_win', actualOutcome: `ah_${isAway ? 'away' : 'home'}_${line}`, voidReason: 'Asian Handicap half-win', roi: 0.5 };
  if (margin === -0.25) return { outcome: 'half_loss', actualOutcome: `ah_${isAway ? 'away' : 'home'}_${line}`, voidReason: 'Asian Handicap half-loss', roi: -0.5 };

  return { outcome: 'manual_review', actualOutcome: 'unresolved_ah', voidReason: `Unresolved Asian Handicap margin: ${margin}`, roi: 0 };
}

async function applySettlement(pick: PendingPick, settlement: SettlementResult, score: ScoreResult, selection: string | null): Promise<void> {
  const odds = Number(pick.recommended_odds) || 0;
  let roi = settlement.roi;
  if (settlement.outcome === 'won' && odds > 1) roi = odds - 1;
  if (settlement.outcome === 'half_win' && odds > 1) roi = (odds - 1) * 0.5;
  if (settlement.outcome === 'half_loss') roi = -0.5;

  const status = settlement.outcome === 'manual_review' ? 'manual_review' : settlement.outcome;

  await query(
    `UPDATE predictions SET
       status = ?,
       actual_result = ?,
       roi = ?,
       closing_odds = COALESCE(closing_odds, recommended_odds)
     WHERE id = ?`,
    [status, settlement.actualOutcome, roi, pick.id]
  );

  await logResult({
    predictionId: pick.id,
    fixture: pick.fixture,
    market: pick.prediction_market,
    selection: selection || '',
    actualOutcome: settlement.actualOutcome,
    result: settlement.outcome,
    voidReason: settlement.voidReason || '',
    finalScore: `${score.homeScore}-${score.awayScore}`,
    roi,
  }).catch(err => console.error('[Settlement] Airtable log error:', err instanceof Error ? err.message : String(err)));

  console.log(`[Settlement] ${pick.fixture} | ${pick.prediction_market} | ${selection || 'MISSING'} → ${settlement.outcome} | ${score.homeScore}-${score.awayScore} | ROI: ${roi}`);
}

async function flagManualReview(predictionId: string, reason: string): Promise<void> {
  await query('UPDATE predictions SET status = ? WHERE id = ?', ['manual_review', predictionId]);
  await logResult({predictionId,fixture:'',market:'',selection:'',actualOutcome:'no_score',result:'manual_review',voidReason:reason,finalScore:'',roi:0}).catch(() => {});
  console.warn(`[Settlement] ${predictionId} flagged for manual review: ${reason}`);
}
