import React, { useRef, useEffect, useState } from 'react';
import { useChat } from '../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import type { ChatMessage } from '../types';

const QUICK_PROMPTS = [
  { icon: '⚽', text: 'Best value bets in Premier League today' },
  { icon: '🏆', text: "Analyze Champions League tonight's fixtures" },
  { icon: '📊', text: 'Top 3 over/under picks this weekend' },
  { icon: '🎯', text: 'Give me BTTS tips for today' },
];

interface ChatInterfaceProps { conversationId: string; initialMessages: ChatMessage[]; onMessagesChange: (messages: ChatMessage[]) => void; onNewChat: () => void; }

export const ChatInterface: React.FC<ChatInterfaceProps> = ({ conversationId, initialMessages, onMessagesChange, onNewChat }) => {
  const { messages, isStreaming, sendMessage, runPreset, cancelRequest } = useChat({ conversationId, initialMessages, onMessagesChange });
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages.length, isStreaming]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(input.trim()); setInput('');
  };
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
  };
  const runAccumulator = () => { if (!isStreaming) runPreset('statistically_plausible_accumulator'); };
  const isEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-full bg-[#0d0d0d]">
      <div className="flex items-center justify-between px-6 py-3 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative"><div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-sm font-bold text-white shadow-lg shadow-emerald-900/30">⚡</div><span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-[#0d0d0d] ${isStreaming ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} /></div>
          <div><div className="text-sm font-semibold text-white">Odessyus Agent</div><div className="text-xs text-neutral-500 font-mono">{isStreaming ? <span className="text-amber-400/80 flex items-center gap-1.5"><span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />Analyzing…</span> : 'Ready · 5-agent orchestrator'}</div></div>
        </div>
        <button onClick={onNewChat} className="flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-200 transition-colors px-3 py-1.5 rounded-lg hover:bg-white/[0.06] border border-transparent hover:border-white/[0.06]">New chat</button>
      </div>

      <div className="flex-1 overflow-y-auto scrollable">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full px-6 py-10 max-w-3xl mx-auto">
            <div className="mb-7 text-center"><div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-3xl mx-auto mb-5 shadow-2xl shadow-emerald-900/40">⚡</div><h1 className="text-2xl font-bold text-white mb-2">How can I help you?</h1><p className="text-neutral-500 text-sm max-w-sm mx-auto">I'm an autonomous sports forecasting engine. Ask me for predictions, value bets, or match analysis.</p></div>

            {/* One-click quantitative portfolio analysis. The full prompt is server-side and is never inserted into the chat composer. */}
            <button
              type="button"
              onClick={runAccumulator}
              disabled={isStreaming}
              className="w-full mb-5 group text-left rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.10] to-teal-500/[0.05] hover:from-emerald-500/[0.16] hover:to-teal-500/[0.09] hover:border-emerald-400/35 disabled:opacity-50 disabled:cursor-not-allowed transition-all p-4 shadow-lg shadow-emerald-950/20"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-400/20 flex items-center justify-center text-xl">📐</div>
                <div className="flex-1 min-w-0"><div className="text-sm font-semibold text-emerald-200 group-hover:text-emerald-100">Statistically Plausible Accumulators for Today</div><div className="text-xs text-neutral-500 mt-1">Scans today's fixtures, validates market edge, and builds Safe, Balanced & Aggressive portfolios.</div></div>
                <div className="text-emerald-400 text-lg group-hover:translate-x-0.5 transition-transform">→</div>
              </div>
            </button>

            <div className="agent-grid">
              {[{ icon: '📊', label: 'OddsScout', desc: 'Market lines & sharp money' }, { icon: '📈', label: 'FormScout', desc: 'H2H records & xG data' }, { icon: '🏥', label: 'InjuryIntel', desc: 'Lineups & GTD players' }, { icon: '📰', label: 'SentimentAgent', desc: 'News & motivation' }, { icon: '⚡', label: 'QuantSynth', desc: 'Monte Carlo & EV' }].map(a => <div key={a.label} className="flex items-start gap-2.5 bg-white/[0.03] border border-white/[0.06] rounded-xl p-3"><span className="text-lg flex-shrink-0 mt-0.5">{a.icon}</span><div><div className="text-xs font-semibold text-neutral-200">{a.label}</div><div className="text-[11px] text-neutral-600 mt-0.5 leading-tight">{a.desc}</div></div></div>)}
            </div>
            <div className="prompt-grid mt-4">{QUICK_PROMPTS.map(p => <button key={p.text} onClick={() => { setInput(p.text); inputRef.current?.focus(); }} className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/[0.06] hover:border-white/[0.12] hover:bg-white/[0.06] text-left transition-all group"><span className="text-base">{p.icon}</span><span className="text-xs text-neutral-400 group-hover:text-neutral-200 transition-colors leading-snug">{p.text}</span></button>)}</div>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-6 px-4 space-y-1">{messages.map((msg, i) => <MessageBubble key={msg.id} message={msg} isActiveStreaming={isStreaming && i === messages.length - 1} />)}{isStreaming && messages[messages.length - 1]?.content === '' && <div className="flex items-start gap-3 px-1 animate-fade-in-up py-4"><div className="w-8 h-8 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5">⚡</div><div className="flex gap-1 items-center mt-2"><span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" /></div></div>}<div ref={messagesEndRef} /></div>
        )}
      </div>

      <div className="flex-shrink-0 px-4 pb-5 pt-3 border-t border-white/[0.06]"><div className="max-w-3xl mx-auto"><form onSubmit={handleSubmit} className="relative"><textarea ref={inputRef} value={input} onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; }} onKeyDown={handleKeyDown} placeholder="Ask for predictions, analysis, value bets…" rows={1} disabled={isStreaming} className="w-full bg-white/[0.05] border border-white/[0.1] focus:border-emerald-500/50 focus:bg-white/[0.07] rounded-2xl px-5 py-3.5 pr-14 text-sm text-neutral-100 placeholder-neutral-600 resize-none outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed leading-relaxed" style={{ minHeight: '52px', maxHeight: '200px' }} /><div className="absolute bottom-2.5 right-2.5">{isStreaming ? <button type="button" onClick={cancelRequest} className="w-9 h-9 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] border border-white/[0.1] text-neutral-300 flex items-center justify-center transition-colors" title="Stop"><svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg></button> : <button type="submit" disabled={!input.trim()} className="w-9 h-9 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-white/[0.06] disabled:cursor-not-allowed text-white disabled:text-neutral-600 flex items-center justify-center transition-colors shadow-lg shadow-emerald-900/30" title="Send"><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5M5 12l7-7 7 7" /></svg></button>}</div></form><p className="text-[11px] text-neutral-700 mt-2 text-center font-mono">5-agent orchestrator · Live data scraping · Enter to send</p></div></div>
    </div>
  );
};
