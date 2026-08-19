import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { placeBet, listPlatforms } from '../booking/index.js';
import type { BookingRequest } from '../booking/types.js';
import { query } from '../db/index.js';

const router = Router();
// Auth is handled globally by requireAuth middleware in server/index.ts

// GET /api/booking/platforms — list supported platforms
router.get('/platforms', (_req: Request, res: Response) => {
  res.json({ platforms: listPlatforms() });
});

// GET /api/booking/config — current booking config (no secrets)
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    platform: process.env.BOOKING_PLATFORM || 'sportybet',
    stakeUnit: process.env.BOOKING_STAKE_UNIT || '10',
    hasCredentials: !!(process.env.BOOKING_USERNAME && process.env.BOOKING_PASSWORD),
  });
});

// POST /api/booking/place — place a bet
router.post('/place', async (req: Request, res: Response) => {
  const body = req.body as Partial<BookingRequest & { predictionId?: string }>;

  const platform = (body.platform || process.env.BOOKING_PLATFORM || 'sportybet') as string;
  const fixture = body.fixture?.trim();
  const market = body.market?.trim();
  const selection = body.selection?.trim();
  const minOdds = Number(body.minOdds) || 1.5;
  const stakeUnits = Number(body.stakeUnits) || 1;

  if (!fixture || !market || !selection) {
    return res.status(400).json({
      error: 'fixture, market, and selection are required',
    });
  }

  const bookingReq: BookingRequest = {
    platform,
    fixture,
    market,
    selection,
    minOdds,
    stakeUnits,
    stakeOverride: body.stakeOverride,
    predictionId: body.predictionId,
  };

  try {
    console.log(`[BookingRoute] Placing: ${fixture} | ${selection} @ min ${minOdds}`);
    const result = await placeBet(bookingReq);

    // Save to DB
    try {
      await query(
        `INSERT INTO booking_log
          (id, prediction_id, platform, fixture, market, selection,
           odds_obtained, stake_amount, potential_return, bet_id,
           betslip_ref, confirmation_text, success, error_msg, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          uuidv4(),
          body.predictionId || null,
          result.platform,
          result.fixture,
          result.market,
          result.selection,
          result.oddsObtained || null,
          result.stakeAmount || null,
          result.potentialReturn || null,
          result.betId || null,
          result.betslipRef || null,
          result.confirmationText || null,
          result.success ? 1 : 0,
          result.error || null,
        ]
      );
    } catch (dbErr) {
      console.error('[BookingRoute] DB save error:', dbErr);
      // Don't fail the response over a DB error
    }

    res.json({ result });
  } catch (err) {
    console.error('[BookingRoute] Error:', err);
    res.status(500).json({ error: 'Booking failed', detail: String(err) });
  }
});

// GET /api/booking/history — recent booking attempts
router.get('/history', async (_req: Request, res: Response) => {
  try {
    const rows = await query<Record<string, unknown>[]>(
      `SELECT id, prediction_id, platform, fixture, market, selection,
              odds_obtained, stake_amount, potential_return, bet_id,
              success, error_msg, created_at
       FROM booking_log ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ bookings: rows });
  } catch {
    // Table may not exist yet on first run
    res.json({ bookings: [] });
  }
});

export default router;
