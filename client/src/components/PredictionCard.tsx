import React, { useState, useEffect } from 'react';
import type { Prediction } from '../types';

interface PredictionCardProps {
  prediction: Prediction;
  onStatusUpdate?: (id: string, status: Prediction['status']) => void;
  compact?: boolean;
}

const STATUS_CONFIG = {
  pending: { label: 'Pending', color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-600/40', dot: 'bg-amber-400' },
  won:     { label: 'Won ✓',  color: 'text-green-400', bg: 'bg-green-500/10',  border: 'border-green-600/40',  dot: 'bg-green-400' },
  lost:    { label: 'Lost ✗', color: 'text-red-400',   bg: 'bg-red-500/10',    border: 'border-red-600/40',    dot: 'bg-red-400' },
  void:    { label: 'Void',   color: 'text-slate-400', bg: 'bg-slate-500/10',  border: 'border-slate-600/40',  dot: 'bg-slate-400' },
};

function ConfidenceBar({ value }: { value?: number | string }) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  const color = pct >= 70 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: color }} />
    </div>
  );
}

function ProbabilityGauge({ value }: { value?: number | string }) {
  const pct = Math.min(100, Math.max(0, Number(value) || 0));
  const color = pct >= 65 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
  return (
    <div className="relative flex items-center justify-center">
      <svg className="w-16 h-16 -rotate-90" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#1e2d45" strokeWidth="3" />
        <circle cx="18" cy="18" r="15.9" fill="none" stroke={color} strokeWidth="3"
          strokeDasharray={`${pct} ${100 - pct}`} strokeDashoffset="25"
          strokeLinecap="round" className="transition-all duration-700" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-sm font-bold" style={{ color }}>{Math.round(pct)}%</span>
      </div>
    </div>
  );
}

interface BookingState {
  status: 'idle' | 'booking' | 'success' | 'error';
  message?: string;
  betId?: string;
  platform?: string;
}

const KNOWN_PLATFORMS = [
  { id: 'sportybet',   name: 'SportyBet' },
  { id: 'football.com', name: 'Football.com' },
  { id: 'bet365',      name: 'Bet365' },
  { id: '1xbet',       name: '1xBet' },
  { id: 'betway',      name: 'Betway' },
  { id: 'betika',      name: 'Betika' },
  { id: 'parimatch',   name: 'Parimatch' },
  { id: 'melbet',      name: 'Melbet' },
  { id: 'betwinner',   name: 'Betwinner' },
  { id: 'custom',      name: 'Other (type below)…' },
];

export const PredictionCard: React.FC<PredictionCardProps> = ({
  prediction,
  onStatusUpdate,
  compact = false,
}) => {
  const [expanded, setExpanded]           = useState(false);
  const [updating, setUpdating]           = useState(false);
  const [showBooking, setShowBooking]     = useState(false);
  const [platform, setPlatform]           = useState('sportybet');
  const [customPlatform, setCustomPlatform] = useState('');
  const [stakeUnits, setStakeUnits]       = useState(1);
  const [accessKey, setAccessKey]         = useState(() => {
    try { return localStorage.getItem('booking_access_key') || ''; } catch { return ''; }
  });
  const [booking, setBooking]             = useState<BookingState>({ status: 'idle' });

  // Persist access key in localStorage
  useEffect(() => {
    try { localStorage.setItem('booking_access_key', accessKey); } catch { /* ignore */ }
  }, [accessKey]);

  const status = STATUS_CONFIG[prediction.status] || STATUS_CONFIG.pending;

  // Parse MySQL DECIMAL fields (returned as strings) into numbers
  const numProbability  = Number(prediction.probability)        || 0;
  const numConfidence   = Number(prediction.confidence_score)   || 0;
  const numOdds         = Number(prediction.recommended_odds)   || 0;
  const numEV           = Number((prediction as Prediction & { expected_value?: unknown }).expected_value) || 0;
  const numStarRating   = Number((prediction as Prediction & { star_rating?: unknown }).star_rating) || 0;

  const effectivePlatform = platform === 'custom' ? customPlatform.trim() : platform;

  const handleStatusUpdate = async (newStatus: Prediction['status']) => {
    if (updating) return;
    setUpdating(true);
    try {
      const res = await fetch(`/api/predictions/${prediction.id}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok) onStatusUpdate?.(prediction.id, newStatus);
    } catch { /* ignore */ }
    setUpdating(false);
  };

  const handleBookBet = async () => {
    if (!effectivePlatform) {
      setBooking({ status: 'error', message: 'Please enter a platform name.' });
      return;
    }
    setBooking({ status: 'booking' });
    try {
      const res = await fetch('/api/booking/place', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-booking-key': accessKey,
        },
        body: JSON.stringify({
          platform: effectivePlatform,
          fixture: prediction.fixture,
          market: prediction.prediction_market,
          selection: prediction.prediction_market,
          minOdds: numOdds || 1.5,
          stakeUnits,
          predictionId: prediction.id,
        }),
      });
      const data = await res.json() as {
        result?: { success: boolean; betId?: string; confirmationText?: string; stakeAmount?: number; error?: string; reason?: string };
        error?: string;
      };
      if (res.status === 401) {
        setBooking({ status: 'error', message: 'Invalid access key. Please check your key and try again.' });
        return;
      }
      const r = data.result;
      if (r?.success) {
        setBooking({ status: 'success', message: r.confirmationText || 'Bet placed!', betId: r.betId, platform: effectivePlatform });
      } else {
        setBooking({ status: 'error', message: r?.reason || r?.error || data.error || 'Booking failed' });
      }
    } catch (err) {
      setBooking({ status: 'error', message: `Network error: ${String(err)}` });
    }
  };

  const formattedDate = prediction.created_at
    ? new Date(prediction.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className={`rounded-xl border bg-slate-900/60 overflow-hidden transition-all duration-200 hover:border-slate-600/70 ${status.border}`}>
      {/* Header */}
      <div className="flex items-start gap-3 p-4">
        <ProbabilityGauge value={numProbability} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-semibold text-slate-100 text-sm truncate leading-tight">{prediction.fixture}</h3>
              {prediction.league && <span className="text-xs text-slate-500 font-mono">{prediction.league}</span>}
            </div>
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full border flex-shrink-0 ${status.bg} ${status.border} ${status.color}`}>
              {status.label}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-mono bg-slate-800 text-blue-300 px-2 py-0.5 rounded-md border border-blue-900/50">
              {prediction.prediction_market}
            </span>
            {numOdds > 0 && (
              <span className="text-xs font-mono bg-green-950/50 text-green-400 px-2 py-0.5 rounded-md border border-green-800/50">
                @ {numOdds.toFixed(2)}
              </span>
            )}
            {numStarRating > 0 && (
              <span className="text-xs font-mono text-amber-400">{'⭐'.repeat(numStarRating)}</span>
            )}
            {numEV > 0 && (
              <span className="text-xs font-mono bg-teal-950/40 text-teal-400 px-2 py-0.5 rounded-md border border-teal-800/50">
                EV +{(numEV * 100).toFixed(1)}%
              </span>
            )}
            <span className="text-xs text-slate-600 ml-auto">{formattedDate}</span>
          </div>
        </div>
      </div>

      {/* Goal statement */}
      {prediction.goal_statement && (
        <div className="px-4 pb-3">
          <p className="text-xs text-slate-400 italic leading-relaxed line-clamp-2">🎯 {prediction.goal_statement}</p>
        </div>
      )}

      {/* Confidence bar */}
      {numConfidence > 0 && (
        <div className="px-4 pb-3">
          <div className="flex justify-between text-xs text-slate-500 mb-1">
            <span>Confidence</span>
            <span className="font-mono">{Math.round(numConfidence)}%</span>
          </div>
          <ConfidenceBar value={numConfidence} />
        </div>
      )}

      {/* Booking result banner */}
      {booking.status === 'success' && (
        <div className="mx-4 mb-3 p-3 rounded-lg bg-green-950/60 border border-green-700/60 text-xs text-green-400 font-mono">
          ✅ Bet placed on {booking.platform}!{booking.betId ? ` Ref: ${booking.betId}` : ''}<br />
          {booking.message}
        </div>
      )}
      {booking.status === 'error' && (
        <div className="mx-4 mb-3 p-3 rounded-lg bg-red-950/60 border border-red-700/60 text-xs text-red-400 font-mono">
          ❌ {booking.message}
        </div>
      )}

      {/* Booking panel */}
      {showBooking && booking.status !== 'success' && (
        <div className="mx-4 mb-3 p-3 rounded-lg bg-slate-800/60 border border-slate-700/50 space-y-3">
          <div className="text-xs font-semibold text-slate-300 font-mono uppercase tracking-wider">🎰 Book This Bet</div>

          {/* Platform selector */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-mono">Platform</label>
            <select
              value={platform}
              onChange={e => { setPlatform(e.target.value); setCustomPlatform(''); }}
              className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-green-600/70"
            >
              {KNOWN_PLATFORMS.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Custom platform input */}
          {platform === 'custom' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500 font-mono">Platform name or URL</label>
              <input
                type="text"
                value={customPlatform}
                onChange={e => setCustomPlatform(e.target.value)}
                placeholder="e.g. betpawa.com, msport, …"
                className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-green-600/70 placeholder-slate-600"
              />
            </div>
          )}

          {/* Stake units */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-mono">Stake units (× BOOKING_STAKE_UNIT)</label>
            <div className="flex items-center gap-2">
              {[0.5, 1, 2, 3].map(u => (
                <button
                  key={u}
                  onClick={() => setStakeUnits(u)}
                  className={`text-xs px-3 py-1 rounded-lg border font-mono transition-colors ${
                    stakeUnits === u
                      ? 'bg-green-600 text-white border-green-500'
                      : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-500'
                  }`}
                >
                  {u}×
                </button>
              ))}
            </div>
          </div>

          {/* Bet summary */}
          <div className="text-xs text-slate-500 font-mono bg-slate-900/60 rounded-lg px-3 py-2 space-y-0.5">
            <div><span className="text-slate-400">Fixture:</span> {prediction.fixture}</div>
            <div><span className="text-slate-400">Market:</span> {prediction.prediction_market}</div>
            {numOdds > 0 && (
              <div><span className="text-slate-400">Min odds:</span> {numOdds.toFixed(2)}</div>
            )}
          </div>

          {/* Access key */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-mono">Access key</label>
            <input
              type="password"
              value={accessKey}
              onChange={e => setAccessKey(e.target.value)}
              placeholder="Enter your booking access key"
              className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-green-600/70 placeholder-slate-600"
            />
          </div>

          <button
            onClick={handleBookBet}
            disabled={booking.status === 'booking' || (platform === 'custom' && !customPlatform.trim())}
            className="w-full text-xs py-2 rounded-lg bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {booking.status === 'booking' ? (
              <>
                <div className="animate-spin h-3 w-3 border border-white border-t-transparent rounded-full" />
                Placing bet via Puppeteer…
              </>
            ) : (
              `🎰 Place Bet on ${effectivePlatform || '…'}`
            )}
          </button>
        </div>
      )}

      {/* Action bar */}
      {!compact && (
        <div className="px-4 py-2.5 border-t border-slate-800/70 flex items-center gap-2 flex-wrap">
          {prediction.status === 'pending' && (
            <>
              <button
                onClick={() => handleStatusUpdate('won')}
                disabled={updating}
                className="text-xs px-3 py-1.5 rounded-lg bg-green-950/60 text-green-400 border border-green-800/60 hover:bg-green-900/60 transition-colors font-semibold"
              >
                Won ✓
              </button>
              <button
                onClick={() => handleStatusUpdate('lost')}
                disabled={updating}
                className="text-xs px-3 py-1.5 rounded-lg bg-red-950/60 text-red-400 border border-red-800/60 hover:bg-red-900/60 transition-colors font-semibold"
              >
                Lost ✗
              </button>
              <button
                onClick={() => handleStatusUpdate('void')}
                disabled={updating}
                className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-slate-400 border border-slate-700 hover:bg-slate-700 transition-colors"
              >
                Void
              </button>
            </>
          )}

          {/* Book Bet button — always visible for pending predictions */}
          {prediction.status === 'pending' && booking.status !== 'success' && (
            <button
              onClick={() => setShowBooking(prev => !prev)}
              className={`text-xs px-3 py-1.5 rounded-lg border font-semibold transition-all ${
                showBooking
                  ? 'bg-amber-600 text-white border-amber-500'
                  : 'bg-amber-950/60 text-amber-400 border-amber-800/60 hover:bg-amber-900/60'
              }`}
            >
              🎰 {showBooking ? 'Cancel' : 'Book Bet'}
            </button>
          )}

          {prediction.raw_analysis && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="ml-auto text-xs text-slate-500 hover:text-slate-300 transition-colors font-mono"
            >
              {expanded ? '▲ Hide' : '▼ Analysis'}
            </button>
          )}
        </div>
      )}

      {/* Expanded analysis */}
      {expanded && prediction.raw_analysis && (
        <div className="px-4 pb-4 border-t border-slate-800/70">
          <div className="mt-3 bg-slate-950/60 rounded-lg p-3 max-h-72 overflow-y-auto scrollable">
            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
              {prediction.raw_analysis}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
