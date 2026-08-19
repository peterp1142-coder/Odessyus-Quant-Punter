import React, { useState, useCallback, useEffect } from 'react';
import type { AppView } from './types';
import { Sidebar } from './components/Sidebar';
import { ChatInterface } from './components/ChatInterface';
import { PredictionsView } from './components/PredictionsView';
import { StatsPanel } from './components/StatsPanel';
import { AccessGate } from './components/AccessGate';
import { useConversations } from './hooks/useConversations';
import type { ChatMessage } from './types';

function App() {
  const [view, setView] = useState<AppView>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // null = checking, true = authenticated, false = needs key
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

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

  // Bootstrap: create the first conversation if none exist
  useEffect(() => {
    if (conversations.length === 0) {
      newConversation();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Auth loading spinner
  if (authenticated === null) {
    return (
      <div className="fixed inset-0 bg-[#0d0d0d] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Lock screen
  if (!authenticated) {
    return <AccessGate onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <div className="flex h-screen bg-[#0d0d0d] overflow-hidden">
      {/* Sidebar — desktop */}
      <div className="app-sidebar-desktop">
        <Sidebar
          conversations={conversations}
          activeId={activeId}
          activeView={view}
          onNewChat={handleNewChat}
          onSelectConversation={handleSelectConversation}
          onDeleteConversation={deleteConversation}
          onViewChange={setView}
        />
      </div>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setSidebarOpen(false)}
          />
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

      {/* Main content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Mobile top bar */}
        <div className="app-topbar-mobile items-center gap-3 px-4 py-3 border-b border-white/[0.06] bg-[#0d0d0d] flex-shrink-0" style={{borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-neutral-400 hover:text-neutral-200 p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-white">Odessyus</span>
          <div className="ml-auto flex gap-1">
            {(['chat', 'predictions', 'stats'] as AppView[]).map(v => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`text-xs px-2.5 py-1.5 rounded-lg transition-all capitalize ${
                  view === v ? 'bg-white/10 text-white' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {v === 'chat' ? '💬' : v === 'predictions' ? '📊' : '📈'}
              </button>
            ))}
          </div>
        </div>

        {/* View content */}
        <div className="flex-1 overflow-hidden">
          {view === 'chat' && activeId ? (
            <ChatInterface
              key={activeId}
              conversationId={activeId}
              initialMessages={activeConversation?.messages ?? []}
              onMessagesChange={handleMessagesChange}
              onNewChat={handleNewChat}
            />
          ) : view === 'chat' ? (
            /* Loading state while first conversation is created */
            <div className="flex items-center justify-center h-full">
              <div className="w-6 h-6 border border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : null}
          {view === 'predictions' && <PredictionsView />}
          {view === 'stats' && <StatsPanel />}
        </div>
      </main>
    </div>
  );
}

export default App;
