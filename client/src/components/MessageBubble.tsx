import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage, PredictionMetadata } from '../types';
import { ReActTrace } from './ReActTrace';

interface MessageBubbleProps {
  message: ChatMessage;
  isActiveStreaming?: boolean;
}

const KNOWN_PLATFORMS = [
  { id: 'sportybet', name: 'SportyBet' },
  { id: 'football.com', name: 'Football.com' },
  { id: 'bet365', name: 'Bet365' },
  { id: '1xbet', name: '1xBet' },
  { id: 'betway', name: 'Betway' },
  { id: 'betika', name: 'Betika' },
  { id: 'parimatch', name: 'Parimatch' },
  { id: 'melbet', name: 'Melbet' },
  { id: 'betwinner', name: 'Betwinner' },
  { id: 'custom', name: 'Other…' },
];

interface BookState { status: 'idle' | 'booking' | 'success' | 'error'; message?: string; betId?: string; }

function BookBetPanel({ predictionId, metadata }: { predictionId: string; metadata: PredictionMetadata }) {
  const [show, setShow] = useState(false);
  const [platform, setPlatform] = useState('sportybet');
  const [customPlatform, setCustomPlatform] = useState('');
  const [accessKey, setAccessKey] = useState(() => {
    try { return localStorage.getItem('booking_access_key') || ''; } catch { return ''; }
  });
  const [book, setBook] = useState<BookState>({ status: 'idle' });

  useEffect(() => {
    try { localStorage.setItem('booking_access_key', accessKey); } catch { /* ignore */ }
  }, [accessKey]);

  const effectivePlatform = platform === 'custom' ? customPlatform.trim() : platform;

  const handlePlace = async () => {
    if (!effectivePlatform) return setBook({ status: 'error', message: 'Please enter a platform name.' });
    setBook({ status: 'booking' });
    try {
      const res = await fetch('/api/booking/place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-booking-key': accessKey },
        body: JSON.stringify({ platform: effectivePlatform, fixture: metadata.fixture, market: metadata.market, selection: metadata.market, minOdds: Number(metadata.recommendedOdds) || 1.5, stakeUnits: 1, predictionId }),
      });
      if (res.status === 401) return setBook({ status: 'error', message: 'Invalid access key.' });
      const data = await res.json() as { result?: { success: boolean; betId?: string; confirmationText?: string; error?: string; reason?: string }; error?: string };
      const r = data.result;
      if (r?.success) setBook({ status: 'success', message: r.confirmationText || 'Bet placed!', betId: r.betId });
      else setBook({ status: 'error', message: r?.reason || r?.error || data.error || 'Booking failed' });
    } catch (err) {
      setBook({ status: 'error', message: `Network error: ${String(err)}` });
    }
  };

  if (book.status === 'success') {
    return <div className="mt-3 p-3 rounded-xl bg-green-950/50 border border-green-700/40 text-xs text-green-400">✅ Bet placed on {effectivePlatform}! {book.betId ? `Ref: ${book.betId}` : ''}<br />{book.message}</div>;
  }

  return (
    <div className="mt-3">
      {!show ? (
        <button onClick={() => setShow(true)} className="text-xs px-3 py-1.5 rounded-xl bg-amber-950/50 border border-amber-700/40 text-amber-400 hover:bg-amber-900/50 font-semibold">🎰 Book Bet</button>
      ) : (
        <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-700/50 space-y-2.5">
          <div className="flex items-center justify-between"><span className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Book Bet</span><button onClick={() => setShow(false)} className="text-slate-500 hover:text-slate-300">✕</button></div>
          <div className="text-xs bg-slate-900/60 rounded-lg px-3 py-2 space-y-1 text-slate-400">
            <div><b>Fixture:</b> {metadata.fixture}</div>
            <div><b>Market:</b> {metadata.market}</div>
            {metadata.recommendedOdds > 0 && <div><b>Min odds:</b> <span className="text-green-400">{Number(metadata.recommendedOdds).toFixed(2)}</span></div>}
          </div>
          <select value={platform} onChange={e => { setPlatform(e.target.value); setCustomPlatform(''); }} className="w-full text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5">
            {KNOWN_PLATFORMS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {platform === 'custom' && <input type="text" value={customPlatform} onChange={e => setCustomPlatform(e.target.value)} placeholder="Platform name" className="w-full text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5" />}
          <input type="password" value={accessKey} onChange={e => setAccessKey(e.target.value)} placeholder="Booking access key" className="w-full text-xs bg-slate-900 border border-slate-700 text-slate-200 rounded-lg px-2 py-1.5" />
          {book.status === 'error' && <div className="text-xs text-red-400 bg-red-950/40 border border-red-800/40 rounded-lg px-3 py-2">❌ {book.message}</div>}
          <button onClick={handlePlace} disabled={book.status === 'booking' || (platform === 'custom' && !customPlatform.trim())} className="w-full text-xs py-2 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-semibold">
            {book.status === 'booking' ? 'Placing…' : `🎰 Place on ${effectivePlatform || '…'}`}
          </button>
        </div>
      )}
    </div>
  );
}

interface SelectedPick {
  status?: string;
  market: string;
  selection: string;
  probability_pct?: number | null;
  odds?: number | null;
  ev_pct?: number | null;
  confidence_pct?: number | null;
  reason?: string;
  validation?: string;
}

function parseDecisionBlocks(content: string): { cleaned: string; primary: SelectedPick | null; alternatives: SelectedPick[] } {
  let cleaned = content;
  let primary: SelectedPick | null = null;
  let alternatives: SelectedPick[] = [];

  const primaryMatch = content.match(/PRIMARY_BET\s*:\s*(?:```json\s*)?(\{[\s\S]*?\})(?:\s*```)?/i);
  if (primaryMatch) {
    try {
      const parsed = JSON.parse(primaryMatch[1]);
      if (parsed && typeof parsed.market === 'string' && typeof parsed.selection === 'string') primary = parsed as SelectedPick;
      cleaned = cleaned.replace(primaryMatch[0], '');
    } catch { /* leave malformed content visible rather than crash */ }
  }

  const alternativesMatch = cleaned.match(/ALTERNATIVE_PICKS\s*:\s*(?:```json\s*)?(\[[\s\S]*?\])(?:\s*```)?/i);
  if (alternativesMatch) {
    try {
      const parsed = JSON.parse(alternativesMatch[1]);
      if (Array.isArray(parsed)) alternatives = parsed.filter((p: any) => p && typeof p.market === 'string' && typeof p.selection === 'string') as SelectedPick[];
      cleaned = cleaned.replace(alternativesMatch[0], '');
    } catch { /* leave malformed content visible rather than crash */ }
  }

  cleaned = cleaned
    .replace(/^\s*FINAL_ANSWER\s*$/gim, '')
    .replace(/^\s*PRIMARY_BET\s*$/gim, '')
    .replace(/^\s*ALTERNATIVE_PICKS\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleaned, primary, alternatives };
}

function statusClass(status?: string) {
  const s = String(status || '').toUpperCase();
  if (s === 'BET' || s === 'VALIDATED') return 'bg-emerald-500/10 text-emerald-300 border-emerald-500/20';
  if (s === 'NO_BET' || s === 'SKIP') return 'bg-neutral-500/10 text-neutral-400 border-white/[0.08]';
  return 'bg-amber-500/10 text-amber-300 border-amber-500/20';
}

function PickDecisionPanel({ primary, alternatives }: { primary: SelectedPick | null; alternatives: SelectedPick[] }) {
  if (!primary && alternatives.length === 0) return null;
  return (
    <div className="prediction-decision-panel my-4 space-y-3">
      {primary && (
        <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.10] to-transparent p-4 shadow-lg shadow-emerald-950/20">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-400">Primary Pick</div>
            <span className={`text-[11px] font-semibold px-2 py-1 rounded-full border ${statusClass(primary.status)}`}>{primary.status || 'NO_BET'}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto] gap-4 items-start">
            <div>
              <div className="text-xs text-neutral-500 uppercase tracking-wider">{primary.market}</div>
              <div className="text-xl md:text-2xl font-bold text-white mt-1 break-words">{primary.selection}</div>
              {primary.reason && <div className="text-xs text-neutral-400 mt-2 leading-relaxed">{primary.reason}</div>}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="min-w-[78px] rounded-xl bg-black/20 border border-white/[0.06] px-3 py-2"><div className="text-[10px] uppercase text-neutral-500">Model</div><div className="text-sm font-bold text-white">{primary.probability_pct != null ? `${Number(primary.probability_pct).toFixed(1)}%` : '—'}</div></div>
              <div className="min-w-[78px] rounded-xl bg-black/20 border border-white/[0.06] px-3 py-2"><div className="text-[10px] uppercase text-neutral-500">Odds</div><div className="text-sm font-bold text-emerald-300">{primary.odds != null ? Number(primary.odds).toFixed(2) : '—'}</div></div>
              <div className="min-w-[78px] rounded-xl bg-black/20 border border-white/[0.06] px-3 py-2"><div className="text-[10px] uppercase text-neutral-500">EV</div><div className="text-sm font-bold text-emerald-300">{primary.ev_pct != null ? `${Number(primary.ev_pct) >= 0 ? '+' : ''}${Number(primary.ev_pct).toFixed(2)}%` : '—'}</div></div>
            </div>
          </div>
          {primary.validation && <div className="mt-3 text-[11px] text-neutral-500">Validation: <span className="text-neutral-300">{primary.validation}</span>{primary.confidence_pct != null ? ` · Confidence ${Number(primary.confidence_pct).toFixed(0)}%` : ''}</div>}
        </div>
      )}

      {alternatives.length > 0 && (
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.07] flex items-center justify-between">
            <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-neutral-400">Other Market Opportunities</div>
            <div className="text-[10px] text-neutral-600">Secondary</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs decision-table">
              <thead><tr><th>Market</th><th>Selection</th><th>Model</th><th>Odds</th><th>EV</th><th>Status</th></tr></thead>
              <tbody>{alternatives.map((p, i) => <tr key={`${p.market}-${p.selection}-${i}`}><td>{p.market}</td><td className="font-semibold text-white">{p.selection}</td><td>{p.probability_pct != null ? `${Number(p.probability_pct).toFixed(1)}%` : '—'}</td><td>{p.odds != null ? Number(p.odds).toFixed(2) : '—'}</td><td className={Number(p.ev_pct) >= 0 ? 'text-emerald-300' : 'text-red-300'}>{p.ev_pct != null ? `${Number(p.ev_pct) >= 0 ? '+' : ''}${Number(p.ev_pct).toFixed(2)}%` : '—'}</td><td><span className={`inline-flex px-2 py-0.5 rounded-full border ${statusClass(p.status)}`}>{p.status || 'UNVALIDATED'}</span></td></tr>)}</tbody>
            </table>
          </div>
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
      {stars > 0 && <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400">{'⭐'.repeat(stars)} {stars}/5</span>}
      {ev > 0 && <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">EV +{(ev * 100).toFixed(2)}%</span>}
      {prob > 0 && <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400">P {prob.toFixed(1)}%</span>}
      {agentCount > 0 && <span className="text-xs font-mono px-2.5 py-1 rounded-full bg-white/[0.05] border border-white/[0.08] text-neutral-500">{agentCount} agents</span>}
    </div>
  );
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message, isActiveStreaming }) => {
  const [showTrace, setShowTrace] = useState(false);
  const isUser = message.role === 'user';
  const hasSteps = !!message.steps?.some(s => s.type !== 'status');
  const traceSteps = message.steps?.filter(s => s.type !== 'status' && s.type !== 'synthesis').length || 0;
  const hasPrediction = !isUser && !message.isStreaming && !!message.predictionId && !!message.metadata;
  const meta = message.metadata as PredictionMetadata | undefined;
  const decision = useMemo(() => !isUser && !message.isStreaming ? parseDecisionBlocks(message.content) : { cleaned: message.content, primary: null, alternatives: [] }, [isUser, message.isStreaming, message.content]);

  if (isUser) {
    return <div className="flex justify-end animate-fade-in-up py-2 px-1"><div className="max-w-[80%] bg-[#2f2f2f] rounded-3xl rounded-tr-md px-5 py-3"><p className="text-sm text-neutral-100 leading-relaxed whitespace-pre-wrap">{message.content}</p></div></div>;
  }

  return (
    <div className="animate-fade-in-up py-3 px-1">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xs font-bold text-white mt-0.5 shadow-lg shadow-emerald-900/20">⚡</div>
        <div className="flex-1 min-w-0">
          {message.isStreaming && <div className="flex items-center gap-2 text-xs text-neutral-500 mb-3 mt-1.5"><div className="animate-spin h-3 w-3 border border-emerald-500 border-t-transparent rounded-full" /><span className="font-mono truncate">{message.content || 'Orchestrating agents…'}</span></div>}

          {!message.isStreaming && message.content && (
            <div className="text-sm text-neutral-200 leading-relaxed prose-custom mt-0.5">
              <PickDecisionPanel primary={decision.primary} alternatives={decision.alternatives} />
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-5 mb-2 first:mt-0">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-bold text-emerald-400 mt-5 mb-2 uppercase tracking-wide">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-sm font-semibold text-blue-300 mt-4 mb-1.5">{children}</h3>,
                  strong: ({ children }) => <strong className="text-white font-semibold">{children}</strong>,
                  em: ({ children }) => <em className="text-neutral-400">{children}</em>,
                  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="my-2 space-y-1">{children}</ul>,
                  ol: ({ children }) => <ol className="my-2 space-y-1 list-decimal list-inside">{children}</ol>,
                  li: ({ children }) => <li className="flex items-start gap-2 text-sm"><span className="text-emerald-500 mt-1 flex-shrink-0 text-xs">▸</span><span className="text-neutral-300">{children}</span></li>,
                  hr: () => <hr className="border-white/[0.08] my-5" />,
                  blockquote: ({ children }) => <blockquote className="border-l-2 border-emerald-500/40 pl-3 my-3 text-neutral-400 italic">{children}</blockquote>,
                  table: ({ children }) => <div className="overflow-x-auto my-4 rounded-2xl border border-white/[0.08] bg-white/[0.015]"><table className="w-full min-w-[760px] text-xs border-collapse">{children}</table></div>,
                  thead: ({ children }) => <thead className="bg-white/[0.04]">{children}</thead>,
                  tbody: ({ children }) => <tbody>{children}</tbody>,
                  tr: ({ children }) => <tr className="border-b border-white/[0.05] last:border-0">{children}</tr>,
                  th: ({ children }) => <th className="px-3 py-3 text-left text-neutral-300 font-semibold uppercase tracking-wide text-[10px] whitespace-nowrap">{children}</th>,
                  td: ({ children }) => <td className="px-3 py-3 text-neutral-400 align-top">{children}</td>,
                  code: ({ children, className }) => <code className={className?.includes('language-') ? 'block bg-black/40 text-emerald-300 px-4 py-3 rounded-xl text-xs font-mono border border-white/[0.06] overflow-x-auto my-2' : 'bg-white/[0.06] text-emerald-300 px-1.5 py-0.5 rounded text-xs font-mono'}>{children}</code>,
                }}
              >
                {decision.cleaned}
              </ReactMarkdown>
              <MetadataBadges message={message} />
              {hasPrediction && meta && <BookBetPanel predictionId={message.predictionId!} metadata={meta} />}
            </div>
          )}

          {hasSteps && !message.isStreaming && <button onClick={() => setShowTrace(v => !v)} className="mt-3 flex items-center gap-1.5 text-xs text-neutral-600 hover:text-neutral-400 transition-colors font-mono"><svg className={`w-3 h-3 transition-transform ${showTrace ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>{showTrace ? 'Hide' : 'Show'} agent trace <span className="text-neutral-700">({traceSteps} steps)</span></button>}
          {message.isStreaming && message.steps && message.steps.length > 0 && <div className="mt-2"><ReActTrace steps={message.steps} isActive={isActiveStreaming} /></div>}
          {showTrace && message.steps && <div className="mt-2"><ReActTrace steps={message.steps} isActive={false} /></div>}
          {!message.isStreaming && <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-700 font-mono"><span>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{message.predictionId && <span className="flex items-center gap-1 text-emerald-800"><span className="w-1.5 h-1.5 rounded-full bg-emerald-700" />saved</span>}</div>}
        </div>
      </div>
    </div>
  );
};
