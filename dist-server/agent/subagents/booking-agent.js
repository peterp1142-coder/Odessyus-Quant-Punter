/**
 * BookingAgent — called after a prediction is confirmed ⭐3+ and user requests booking.
 * Extracts the exact bet details from the prediction, validates the platform is configured,
 * then calls placeBet() to execute via Puppeteer.
 */
import { placeBet } from '../../booking/engine.js';
function parseBookingRequest(finalAnswer, override) {
    const fixture = override?.fixture
        || finalAnswer.match(/\*\*Fixture:\*\*\s*([^\n]+)/i)?.[1]?.trim()
        || finalAnswer.match(/([A-Z][a-zA-Z\s]+ vs\.? [A-Z][a-zA-Z\s]+)/)?.[1]?.trim()
        || '';
    const market = override?.market
        || finalAnswer.match(/\*\*(?:MARKET|Target Market):\*\*\s*([^\n]+)/i)?.[1]?.replace(/\*\*/g, '').trim()
        || finalAnswer.match(/MARKET:\s*([^\n]+)/i)?.[1]?.trim()
        || 'Match Result';
    const selection = override?.selection
        || finalAnswer.match(/\*\*SELECTION:\*\*\s*([^\n]+)/i)?.[1]?.replace(/\*\*/g, '').trim()
        || market;
    const minOddsM = finalAnswer.match(/\*\*MINIMUM ODDS:\*\*\s*(\d+\.\d+)/i)
        || finalAnswer.match(/minimum\s+odds[:\s]+(\d+\.\d+)/i);
    const minOdds = override?.minOdds || (minOddsM ? parseFloat(minOddsM[1]) : 1.5);
    const starM = finalAnswer.match(/⭐+.*?(\d)\s*\/\s*5/i);
    const stars = starM ? parseInt(starM[1]) : 0;
    return { fixture, market, selection, minOdds, stakeUnits: stars >= 4 ? 2 : 1 };
}
export async function runBookingAgent(opts) {
    const { finalAnswer, predictionId, overrides, onStep } = opts;
    const steps = [];
    const now = () => new Date().toISOString();
    const tag = '[🎰 BOOKING]';
    const emit = (step) => {
        const s = { ...step, content: `${tag} ${step.content}`, timestamp: now() };
        steps.push(s);
        onStep(s);
    };
    const platform = (overrides?.platform || process.env.BOOKING_PLATFORM || 'sportybet');
    // Validate credentials before starting
    if (!process.env.BOOKING_USERNAME || !process.env.BOOKING_PASSWORD) {
        emit({ type: 'error', content: 'Cannot book: BOOKING_USERNAME and BOOKING_PASSWORD secrets are not set. Add them in Replit Secrets.' });
        return {
            success: false,
            error: 'Credentials not configured',
            steps,
        };
    }
    const parsed = parseBookingRequest(finalAnswer, overrides);
    if (!parsed.fixture || !parsed.selection) {
        emit({ type: 'error', content: 'Could not extract bet details from prediction. Please provide fixture and selection manually.' });
        return { success: false, error: 'Could not parse bet details', steps };
    }
    const bookingReq = {
        platform,
        fixture: parsed.fixture,
        market: parsed.market || 'Match Result',
        selection: parsed.selection,
        minOdds: parsed.minOdds || 1.5,
        stakeUnits: overrides?.stakeUnits || parsed.stakeUnits || 1,
        stakeOverride: overrides?.stakeOverride,
        predictionId,
    };
    const stakeUnit = parseFloat(process.env.BOOKING_STAKE_UNIT || '10');
    const totalStake = bookingReq.stakeOverride ?? (bookingReq.stakeUnits * stakeUnit);
    emit({
        type: 'thought',
        content: `Preparing to book on ${platform.toUpperCase()}: ${bookingReq.fixture} | ${bookingReq.selection} | Min odds: ${bookingReq.minOdds} | Stake: ${totalStake}`,
    });
    emit({ type: 'action', content: `Launching browser → logging in to ${platform}...`, toolName: 'place_bet', toolInput: { platform, fixture: bookingReq.fixture } });
    try {
        const result = await placeBet(bookingReq);
        if (result.success) {
            emit({
                type: 'synthesis',
                content: `✅ Bet placed! ${result.fixture} | ${result.selection} @ ${result.oddsObtained} | Stake: ${result.stakeAmount} | Potential return: ${result.potentialReturn} | Ref: ${result.betId || 'N/A'}`,
            });
        }
        else {
            emit({
                type: 'error',
                content: `❌ Booking failed: ${result.reason || result.error}`,
            });
        }
        return { success: result.success, result, steps };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', content: `Booking engine error: ${msg}` });
        return { success: false, error: msg, steps };
    }
}
//# sourceMappingURL=booking-agent.js.map