import React, { useState, useCallback, useEffect } from 'react';
import type { AppView } from './types';
import { Sidebar } from './components/Sidebar';
import { ChatInterface } from './components/ChatInterface';
import { PredictionsView } from './components/PredictionsView';
import { StatsPanel } from './components/StatsPanel';
import { AccessGate } from './components/AccessGate';
import { useConversations } from './hooks/useConversations';
import type { ChatMessage } from './types';

function parseFplPayload(content: string): Record<string, any> | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && parsed.mode === 'FPL_DEDICATED_OPTIMIZER' ? parsed : null;
  } catch {
    return null;
  }
}

function fplPlayerRow(value: unknown): string[] {
  if (typeof value === 'string') {
    const match = value.match(/^(.*?)\s+\((.*?),\s*(.*?)\)\s+£([\d.]+)\s+\|\s+GW score\s+([\d.]+)\s+\|\s+6GW\s+([\d.]+)\s+\|\s+FDR\s+([\d.]+)\s+\|\s+fixtures\s+(\d+)(?:\s+\|\s+role\s+([\d.]+)\s+\|\s+mins risk\s+([\d.]+))?/);
    if (match) return [match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8], match[9] || '', match[10] || ''];
    return [value, '', '', '', '', '', '', '', '', ''];
  }
  const p = (value || {}) as Record<string, any>;
  return [
    String(p.player ?? p.name ?? '—'),
    String(p.position ?? p.element_type ?? '—'),
    String(p.club ?? p.team ?? '—'),
    String(p.price ?? p.cost ?? '—'),
    String(p.gw_score ?? p.score ?? '—'),
    String(p.six_gw ?? p.projected6 ?? '—'),
    String(p.fdr ?? p.fixtureAvg ?? '—'),
    String(p.fixtures ?? p.fixtureCount ?? '—'),
    String(p.role_security ?? p.roleSecurity ?? ''),
    String(p.minutes_risk ?? p.minutesRisk ?? ''),
  ];
}

function fplTable(values: unknown[]): string {
  if (!Array.isArray(values) || values.length === 0) return '_None_';
  const rows = values.map(fplPlayerRow).map((r, i) =>
    `| ${i + 1} | ${r[0]} | ${r[1]} | ${r[2]} | £${r[3]} | ${r[4]} | ${r[5]} | ${r[6]} | ${r[7]} | ${r[8] ? `${r[8]} / ${r[9]}` : '—'} |`
  ).join('\n');
  return `| # | Player | Pos | Club | Price | GW | 6GW | FDR | Fixtures | Role / Min-risk |\n|---:|---|:---:|---|---:|---:|---:|---:|---:|---|\n${rows}`;
}

function fplPlayerLabel(value: unknown): string {
  if (typeof value === 'string') return value;
  const p = (value || {}) as Record<string, any>;
  return `${p.player ?? p.name ?? '—'} (${p.position ?? p.element_type ?? '—'}, ${p.club ?? p.team ?? '—'})`;
}

function formatFplPayload(payload: Record<string, any>): string {
  const signals = Array.isArray(payload.top_manager_role_signals) ? payload.top_manager_role_signals : [];
  const signalRows = signals.slice(0, 12).map((s: any) =>
    `| ${s.player ?? '—'} | ${s.club ?? '—'} | ${s.sentiment ?? '—'} | ${Number(s.role_security ?? 0).toFixed(2)} | ${Number(s.minutes_risk ?? 0).toFixed(2)} | ${Number(s.tactical_upside ?? 0).toFixed(2)} | ${s.freshness_days ?? '—'}d |`
  ).join('\n');
  return [
    `## ⚽ FPL Gameweek ${payload.gameweek ?? '—'} Squad`,
    '',
    `**Deadline:** ${payload.deadline ? new Date(payload.deadline).toLocaleString() : '—'}  \n**Formation:** ${payload.formation ?? '—'}  \n**Budget remaining:** ${payload.budget_remaining ?? '—'}  \n**Optimization score:** ${payload.optimization_score ?? '—'}`,
    '',
    '### Starting XI',
    fplTable(payload.starting_xi),
    '',
    `**Captain:** ${fplPlayerLabel(payload.captain)}  \n**Vice-captain:** ${fplPlayerLabel(payload.vice_captain)}`,
    '',
    '### Bench',
    fplTable(payload.bench),
    '',
    '### Full 15-man Squad',
    fplTable(payload.squad),
    '',
    '### Manager / Role Intelligence',
    signalRows
      ? `| Player | Club | Sentiment | Role security | Minutes risk | Tactical upside | Freshness |\n|---|---|---|---:|---:|---:|---:|\n${signalRows}`
      : '_No significant manager signals were flagged._',
    '',
    '### Transfer Guidance',
    String(payload.transfer_guidance ?? '—'),
    '',
    '_Retrieved from the completed FPL analysis stored for this session. No new analysis was run._',
  ].join('\n');
}

function App() {
  const [view, setView] = useState<AppView>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('odessyus_sidebar_collapsed') === '1'; } catch { return false; }
  });
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [fplRetrievable, setFplRetrievable] = useState(false);
  const [retrievingFpl, setRetrievingFpl] = useState(false);

  useEffect(() => {
    try { localStorage.setItem('odessyus_sidebar_collapsed', sidebarCollapsed ? '1' : '0'); } catch { /* ignore */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'include' })
      .then(r => r.json())
      .then((d: { authenticated: boolean; gateEnabled: boolean }) => {
        setAuthenticated(!d.gateEnabled || d.authenticated);
      })
      .catch(() => setAuthenticated(false));
  }, []);

  const {
    conversations,
    activeConversation,
    activeId,
    newConversation,
    updateMessages,
    deleteConversation,
    selectConversation,
  } = useConversations();

  useEffect(() => {
    if (conversations.length === 0) newConversation();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setFplRetrievable(false);
    if (!activeId || view !== 'chat') return;
    fetch(`/api/chat/history/${encodeURIComponent(activeId)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('history request failed')))
      .then((d: { messages?: Array<{role:string;content:string}> }) => {
        if (cancelled) return;
        setFplRetrievable((d.messages || []).some(m => m.role === 'assistant' && !!parseFplPayload(m.content)) ||
          (d.messages || []).some(m => m.role === 'assistant' && m.content.includes('FPL Gameweek')));
      })
      .catch(() => { if (!cancelled) setFplRetrievable(false); });
    return () => { cancelled = true; };
  }, [activeId, view]);

  const handleRetrieveFpl = useCallback(async () => {
    if (!activeId || retrievingFpl) return;
    setRetrievingFpl(true);
    try {
      const res = await fetch(`/api/chat/history/${encodeURIComponent(activeId)}`);
      if (!res.ok) throw new Error('Could not retrieve this session');
      const data = await res.json() as { messages?: Array<{id?:string;role:string;content:string;created_at?:string}> };
      const messages = data.messages || [];
      const fplMessage = [...messages].reverse().find(m => m.role === 'assistant' && parseFplPayload(m.content));
      if (!fplMessage) throw new Error('No saved structured FPL result was found for this session.');
      const payload = parseFplPayload(fplMessage.content);
      if (!payload) throw new Error('Saved FPL result could not be parsed.');

      const current = activeConversation?.messages || [];
      const matchingId = fplMessage.id;
      const existingIndex = current.findIndex((m: any) => matchingId && m.id === matchingId);
      const retrievedMessage = {
        id: matchingId || `fpl-retrieved-${Date.now()}`,
        role: 'assistant' as const,
        content: formatFplPayload(payload),
        timestamp: fplMessage.created_at || new Date().toISOString(),
        isStreaming: false,
        steps: [],
        metadata: { mode: 'FPL_DEDICATED_OPTIMIZER', gameweek: payload.gameweek, deadline: payload.deadline, retrieved: true, fpl: payload },
      } as ChatMessage;

      const next = [...current];
      if (existingIndex >= 0) next[existingIndex] = retrievedMessage;
      else next.push(retrievedMessage);
      updateMessages(activeId, next);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Could not retrieve FPL result');
    } finally {
      setRetrievingFpl(false);
    }
  }, [activeId, activeConversation?.messages, retrievingFpl, updateMessages]);

  const handleNewChat = useCallback(() => {
    newConversation();
    setView('chat');
    setSidebarOpen(false);
  }, [newConversation]);

  const handleSelectConversation = useCallback((id: string) => {
    selectConversation(id);
    setView('chat');
    setSidebarOpen(false);
  }, [selectConversation]);

  const handleMessagesChange = useCallback((messages: ChatMessage[]) => {
    if (activeId) updateMessages(activeId, messages);
  }, [activeId, updateMessages]);

  if (authenticated === null) {
    return <div className="fixed inset-0 bg-[#0d0d0d] flex items-center justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>;
  }
  if (!authenticated) return <AccessGate onAuthenticated={() => setAuthenticated(true)} />;

  return (
    <div className="flex h-screen bg-[#0d0d0d] overflow-hidden">
      <div className={`app-sidebar-desktop ${sidebarCollapsed ? 'collapsed' : ''}`}>
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          activeView={view}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={deleteConversation}
          onViewChange={setView}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={() => setSidebarOpen(false)} />
          <div className="relative z-10 w-72">
            <Sidebar
              conversations={conversations}
              activeId={activeId}
              activeView={view}
              onNewChat={handleNewChat}
              onSelectConversation={handleSelectConversation}
              onDeleteConversation={deleteConversation}
              onViewChange={(v) => { setView(v); setSidebarOpen(false); }}
              isMobile
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <div className="app-topbar-mobile items-center gap-3 px-4 py-3 border-b border-white/[0.06] bg-[#0d0d0d] flex-shrink-0">
          <button onClick={() => setSidebarOpen(true)} className="text-neutral-400 hover:text-neutral-200 p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>
          <span className="text-sm font-semibold text-white">Odessyus</span>
          <div className="ml-auto flex gap-1">
            {(['chat', 'predictions', 'stats'] as AppView[]).map(v => (
              <button key={v} onClick={() => setView(v)} className={`text-xs px-2.5 py-1.5 rounded-lg transition-all capitalize ${view === v ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-neutral-300'}`}>
                {v === 'chat' ? '💬' : v === 'predictions' ? '📊' : '📈'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-hidden">
          {view === 'chat' && activeId ? (
            <div className="relative h-full">
              {fplRetrievable && (
                <div className="absolute top-3 right-4 z-20">
                  <button type="button" onClick={() => void handleRetrieveFpl()} disabled={retrievingFpl} className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 disabled:opacity-60 text-emerald-300 text-xs font-semibold px-3 py-2 shadow-lg backdrop-blur" title="Retrieve the completed FPL analysis saved for this session without rerunning it">
                    {retrievingFpl ? 'Retrieving FPL…' : '↻ Retrieve FPL Result'}
                  </button>
                </div>
              )}
              <ChatInterface key={activeId} conversationId={activeId} initialMessages={activeConversation?.messages ?? []} onMessagesChange={handleMessagesChange} onNewChat={handleNewChat} />
            </div>
          ) : view === 'chat' ? (
            <div className="flex items-center justify-center h-full"><div className="w-6 h-6 border border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
          ) : null}
          {view === 'predictions' && <PredictionsView />}
          {view === 'stats' && <StatsPanel />}
        </div>
      </main>
    </div>
  );
}

export default App;
