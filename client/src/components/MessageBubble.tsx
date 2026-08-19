import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ChatMessage, PredictionMetadata } from '../types';
import { ReActTrace } from './ReActTrace';

interface MessageBubbleProps {
  message: ChatMessage;
  isActiveStreaming?: boolean;
}

const KNOWN_PLATFORMS = [
  { id: 'sportybet',    name: 'SportyBet' },
  { id: 'football.com', name: 'Football.com' },
  { id: 'bet365',       name: 'Bet365' },
  { id: '1xbet',        name: '1xBet' },
  { id: 'betway',       name: 'Betway' },
  { id: 'betika',       name: 'Betika' },
  { id: 'parimatch',    name: 'Parimatch' },
  { id: 'melbet',       name: 'Melbet' },
  { id: 'betwinner',    name: 'Betwinner' },
  { id: 'custom',       name: 'Other (type below)…' },
];

interface BookState {
  status: 'idle' | 'booking' | 'success' | 'error';
  message?: string;
  betId?: string;
}

function BookBetPanel({ predictionId, metadata }: { predictionId: string; metadata: PredictionMetadata }) {
  const [show, setShow]                     = useState(false);
  const [platform, setPlatform]             = useState('sportybet');
  const [customPlatform, setCustomPlatform] = useState('');
  const [accessKey, setAccessKey]           = useState(() => {
    try { return localStorage.getItem('booking_access_key') || ''; } catch { return ''; }
  });
  const [book, setBook] = useState<BookState>({ status: 'idle' });

  useEffect(() => {
    try { localStorage.setItem('booking_access_key', accessKey); } catch { /* ignore */ }
  }, [accessKey]);

  const effectivePlatform = platform === 'custom' ? customPlatform.trim() : platform;

  const handlePlace = async () => {
    if (!effectivePlatform) {
      setBook({ status: 'error', message: 'Please enter a platform name.' });
      return;
    }
    setBook({ status: 'booking' });
    try {
      const res = await fetch('/api/booking/place', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-booking-key': accessKey,
        },
        body: JSON.stringify({
          platform: effectivePlatform,
          fixture: metadata.fixture,
          market: metadata.market,
          selection: metadata.market,
          minOdds: Number(metadata.recommendedOdds) || 1.5,
          stakeUnits: 1,
          predictionId,
        }),
      });
      if (res.status === 401) {
        setBook({ status: 'error', message: 'Invalid access key.' });
        return;
      }
      const data = await res.json() as {
        result?: { success: boolean; betId?: string; confirmationText?: string; error?: string; reason?: string };
        error?: string;
      };
      const r = data.result;
      if (r?.success) {
        setBook({ status: 'success', message: r.confirmationText || 'Bet placed!', betId: r.betId });
      } else {
        setBook({ status: 'error', message: r?.reason || r?.error || data.error || 'Booking failed' });
      }
    } catch (err) {
      setBook({ status: 'error', message: `Network error: ${String(err)}` });
    }
  };

  if (book.status === 'success') {
    return (
      <div className="mt-3 p-3 rounded-xl bg-green-950/50 border border-green-700/40 text-xs text-green-400 font-mono">
        ✅ Bet placed on {effectivePlatform}!{book.betId ? ` Ref: ${book.betId}` : ''}<br />
        {book.message}
      </div>
    );
  }

  return (
    <div className="mt-3">
      {!show ? (
        <button
          onClick={() => setShow(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl bg-amber-950/50 border border-amber-700/40 text-amber-400 hover:bg-amber-900/50 transition-colors font-semibold"
        >
          🎰 Book Bet
        </button>
      ) : (
        <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/50 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-300 font-mono uppercase tracking-wider">🎰 Book Bet</span>
            <button onClick={() => setShow(false)} className="text-slate-500 hover:text-slate-300 text-xs transition-colors">✕</button>
          </div>

          {/* Summary */}
          <div className="text-xs font-mono bg-slate-900/60 rounded-lg px-3 py-2 space-y-0.5 text-slate-500">
            <div><span className="text-slate-400">Fixture:</span> <span className="text-slate-300">{metadata.fixture}</span></div>
            <div><span className="text-slate-400">Market:</span> <span className="text-slate-300">{metadata.market}</span></div>
            {metadata.recommendedOdds > 0 && (
              <div><span className="text-slate-400">Min odds:</span> <span className="text-green-400">{Number(metadata.recommendedOdds).toFixed(2)}</span></div>
            )}
          </div>

          {/* Platform */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-mono">Platform</label>
            <select
              value={platform}
              onChange={e => { setPlatform(e.target.value); setCustomPlatform(''); }}
              className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-amber-600/70"
            >
              {KNOWN_PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>

          {platform === 'custom' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500 font-mono">Platform name</label>
              <input
                type="text"
                value={customPlatform}
                onChange={e => setCustomPlatform(e.target.value)}
                placeholder="e.g. betpawa.com, msport…"
                className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-amber-600/70 placeholder-slate-600"
              />
            </div>
          )}

          {/* Access key */}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500 font-mono">Access key</label>
            <input
              type="password"
              value={accessKey}
              onChange={e => setAccessKey(e.target.value)}
              placeholder="Enter your booking access key"
              className="text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5 outline-none focus:border-amber-600/70 placeholder-slate-600"
            />
          </div>

          {book.status === 'error' && (
            <div className="text-xs text-red-400 font-mono bg-red-950/40 border border-red-800/40 rounded-lg px-3 py-2">
              ❌ {book.message}
            </div>
          )}

          <button
            onClick={handlePlace}
            disabled={book.status === 'booking' || (platform === 'custom' && !customPlatform.trim())}
            className="w-full text-xs py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold transition-colors flex items-center justify-center gap-2"
          >
            {book.status === 'booking' ? (
              <>
                <div className="animate-spin h-3 w-3 border border-white border-t-transparent rounded-full" />
                Placing on {effectivePlatform}…
              </>
            ) : (
              `🎰 Place on ${effectivePlatform || '…'}`
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function MetadataBadges({ message }: { message: ChatMessage }) {
  const meta = message.metadata as Record<string, unknown> | undefined;
  if (!meta) return null;

  const stars = Number(meta.starRating) || 0;
  const ev = Number(meta.expectedValue) || 0;
  const prob = Number(meta.probability) || 0;
  const subagents = meta.subagentResults as Record<string, boolean> | undefined;
  const agentCount = subagents ? Object.values(subagents).filter(Boolean).length : 0;

  if (!stars && !ev && !prob) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-3 pt-3 border-t border-white/[0.06]">
      {stars > 0 && (
        <span className="flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">
          {'⭐'.repeat(stars)} {stars}/5
        </span>
      )}
      {ev > 0 && (
        <span className="flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
          EV +{(ev * 100).toFixed(2)}%
        </span>
      )}
      {prob > 0 && (
        <span className="flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400">
          P {prob.toFixed(1)}%
        </span>
      )}
      {agentCount > 0 && (
        <span className="flex items-center gap-1 text-xs font-mono px-2.5 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-neutral-500">
          {agentCount} agents
        </span>
      )}
    </div>
  );
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isActiveStreaming }) => {
  const [showTrace, setShowTrace] = useState(false);

  const isUser   = message.role === 'user';
  const hasSteps = message.steps && message.steps.filter(s => s.type !== 'status').length > 0;
  const traceSteps = message.steps?.filter(s => s.type !== 'status' && s.type !== 'synthesis').length || 0;

  // Show Book Bet button when the message contains a saved prediction with metadata
  const hasPrediction = !isUser && !message.isStreaming && !!message.predictionId && !!message.metadata;
  const meta = message.metadata as PredictionMetadata | undefined;

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-in-up py-2 px-1">
        <div className="max-w-[80%] bg-[#2f2f2f] rounded-3xl rounded-tr-md px-5 py-3">
          <p className="text-sm text-neutral-100 leading-relaxed whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message
  return (
    <div className="animate-fade-in-up py-3 px-1">
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xs font-bold text-white mt-0.5 shadow-lg shadow-emerald-900/20">
          ⚡
        </div>

        <div className="flex-1 min-w-0">
          {/* Streaming state */}
          {message.isStreaming && (
            <div className="flex items-center gap-2 text-xs text-neutral-500 mb-3 mt-1.5">
              <div className="animate-spin h-3 w-3 border border-emerald-500 border-t-transparent rounded-full" />
              <span className="font-mono truncate">{message.content || 'Orchestrating agents…'}</span>
            </div>
          )}

          {/* Final content */}
          {!message.isStreaming && message.content && (
            <div className="text-sm text-neutral-200 leading-relaxed prose-custom mt-0.5">
              <ReactMarkdown
                components={{
                  h1: ({ children }) => <h1 className="text-base font-bold text-white mt-4 mb-2 first:mt-0">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold text-emerald-400 mt-4 mb-1.5 first:mt-0 uppercase tracking-wide">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-blue-300 mt-3 mb-1">{children}</h3>,
                  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                  em: ({ children }) => <em className="text-neutral-400">{children}</em>,
                  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="my-2 space-y-1">{children}</ul>,
                  ol: ({ children }) => <ol className="my-2 space-y-1 list-decimal list-inside">{children}</ol>,
                  li: ({ children }) => (
                    <li className="flex items-start gap-2 text-sm">
                      <span className="text-emerald-500 mt-1 flex-shrink-0 text-xs">▸</span>
                      <span className="text-neutral-300">{children}</span>
                    </li>
                  ),
                  hr: () => <hr className="border-white/[0.08] my-4" />,
                  blockquote: ({ children }) => (
                    <blockquote className="border-l-2 border-emerald-500/40 pl-3 my-2 text-neutral-400 italic">{children}</blockquote>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-3 rounded-xl border border-white/[0.08]">
                      <table className="w-full text-xs border-collapse">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th className="border-b border-white/[0.08] px-3 py-2 bg-white/[0.03] text-left text-neutral-300 font-semibold">{children}</th>,
                  td: ({ children }) => <td className="border-b border-white/[0.04] px-3 py-2 text-neutral-400 last:border-b-0">{children}</td>,
                  code: ({ children, className }) => {
                    const isBlock = className?.includes('language-');
                    return isBlock ? (
                      <code className="block bg-black/40 text-emerald-400 px-4 py-3 rounded-xl text-xs font-mono border border-white/[0.06] overflow-x-auto my-2">{children}</code>
                    ) : (
                      <code className="bg-white/[0.06] text-emerald-400 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
              <MetadataBadges message={message} />
              {/* Book Bet panel — shown when this message saved a prediction */}
              {hasPrediction && meta && (
                <BookBetPanel predictionId={message.predictionId!} metadata={meta} />
              )}
            </div>
          )}

          {/* Agent trace toggle */}
          {hasSteps && !message.isStreaming && (
            <button
              onClick={() => setShowTrace(!showTrace)}
              className="mt-3 flex items-center gap-1.5 text-xs text-neutral-600 hover:text-neutral-400 transition-colors font-mono"
            >
              <svg
                className={`w-3 h-3 transition-transform ${showTrace ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              {showTrace ? 'Hide' : 'Show'} agent trace
              <span className="text-neutral-700">({traceSteps} steps)</span>
            </button>
          )}

          {/* Active streaming trace */}
          {message.isStreaming && message.steps && message.steps.length > 0 && (
            <div className="mt-2">
              <ReActTrace steps={message.steps} isActive={isActiveStreaming} />
            </div>
          )}

          {/* Expanded trace */}
          {showTrace && message.steps && (
            <div className="mt-2">
              <ReActTrace steps={message.steps} isActive={false} />
            </div>
          )}

          {/* Timestamp */}
          {!message.isStreaming && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-700 font-mono">
              <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {message.predictionId && (
                <span className="flex items-center gap-1 text-emerald-800">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-700" />
                  saved
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
