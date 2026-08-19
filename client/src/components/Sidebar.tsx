import React, { useState } from 'react';
import type { Conversation, AppView } from '../types';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  activeView: AppView;
  onNewChat: () => void;
  onSelectConversation: (id: string) => void;
  onDeleteConversation: (id: string) => void;
  onViewChange: (view: AppView) => void;
  isMobile?: boolean;
  onClose?: () => void;
}

function groupByDate(convs: Conversation[]): { label: string; items: Conversation[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86400000;
  const week = today - 7 * 86400000;

  const groups: Record<string, Conversation[]> = {
    Today: [],
    Yesterday: [],
    'Previous 7 days': [],
    Older: [],
  };

  for (const c of convs) {
    const t = new Date(c.updatedAt).getTime();
    if (t >= today) groups['Today'].push(c);
    else if (t >= yesterday) groups['Yesterday'].push(c);
    else if (t >= week) groups['Previous 7 days'].push(c);
    else groups['Older'].push(c);
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

export const Sidebar: React.FC<SidebarProps> = ({
  conversations,
  activeId,
  activeView,
  onNewChat,
  onSelectConversation,
  onDeleteConversation,
  onViewChange,
  isMobile,
  onClose,
}) => {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const groups = groupByDate(conversations);

  return (
    <aside className={`flex flex-col h-full bg-[#171717] border-r border-white/[0.06] ${isMobile ? 'w-full' : 'w-64'}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-4 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2.5 px-1">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-xs font-bold shadow-lg">
            ⚡
          </div>
          <span className="text-sm font-semibold text-white tracking-wide">Odessyus</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onNewChat}
            title="New chat"
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
          {isMobile && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* New chat button */}
      <div className="px-3 pb-2 flex-shrink-0">
        <button
          onClick={onNewChat}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-neutral-400 hover:text-white hover:bg-white/[0.06] border border-white/[0.06] hover:border-white/[0.1] transition-all"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 5v14M5 12h14" />
          </svg>
          <span>New chat</span>
        </button>
      </div>

      {/* Conversation history */}
      <div className="flex-1 overflow-y-auto px-2 py-1 space-y-4 scrollable">
        {conversations.length === 0 ? (
          <p className="text-xs text-neutral-600 text-center px-4 py-6">
            No conversations yet. Start chatting!
          </p>
        ) : (
          groups.map(({ label, items }) => (
            <div key={label}>
              <p className="text-[11px] font-medium text-neutral-600 uppercase tracking-wider px-2 py-1">
                {label}
              </p>
              <div className="space-y-0.5">
                {items.map(conv => (
                  <div
                    key={conv.id}
                    className={`group relative flex items-center rounded-lg px-2 py-2 cursor-pointer transition-colors ${
                      activeId === conv.id && activeView === 'chat'
                        ? 'bg-white/[0.1] text-white'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.05]'
                    }`}
                    onClick={() => onSelectConversation(conv.id)}
                    onMouseEnter={() => setHoveredId(conv.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    <svg className="w-3.5 h-3.5 flex-shrink-0 mr-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                        d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                    </svg>
                    <span className="text-[13px] truncate flex-1 min-w-0">{conv.title}</span>
                    {(hoveredId === conv.id || activeId === conv.id) && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                        className="ml-1 flex-shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-red-400 transition-all"
                        title="Delete"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Bottom nav */}
      <div className="flex-shrink-0 border-t border-white/[0.06] px-2 py-3 space-y-0.5">
        <button
          onClick={() => onViewChange('predictions')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
            activeView === 'predictions'
              ? 'bg-white/[0.1] text-white'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.06]'
          }`}
        >
          <span className="text-base">📊</span>
          <span>Predictions</span>
        </button>
        <button
          onClick={() => onViewChange('stats')}
          className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
            activeView === 'stats'
              ? 'bg-white/[0.1] text-white'
              : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.06]'
          }`}
        >
          <span className="text-base">📈</span>
          <span>Stats</span>
        </button>

        <div className="px-3 pt-2">
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-[11px] text-neutral-600 font-mono">Mistral Large · 5 agents</span>
          </div>
        </div>
      </div>
    </aside>
  );
};
