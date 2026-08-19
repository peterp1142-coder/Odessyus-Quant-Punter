import { useState, useCallback, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { Conversation, ChatMessage } from '../types';

const STORAGE_KEY = 'odessyus_conversations';
const MAX_STORED = 50;

function load(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as Conversation[];
  } catch {
    return [];
  }
}

function save(convs: Conversation[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(convs.slice(0, MAX_STORED)));
  } catch { /* quota */ }
}

function titleFromMessages(messages: ChatMessage[]): string {
  const first = messages.find(m => m.role === 'user');
  if (!first) return 'New conversation';
  return first.content.length > 45
    ? first.content.substring(0, 45).trimEnd() + '…'
    : first.content;
}

export function useConversations() {
  const [conversations, setConversations] = useState<Conversation[]>(() => load());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const stored = load();
    return stored.length > 0 ? stored[0].id : null;
  });

  // Persist whenever conversations change
  useEffect(() => {
    save(conversations);
  }, [conversations]);

  const activeConversation = conversations.find(c => c.id === activeId) ?? null;

  const newConversation = useCallback((): string => {
    const id = uuidv4();
    const conv: Conversation = {
      id,
      title: 'New conversation',
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setConversations(prev => [conv, ...prev]);
    setActiveId(id);
    return id;
  }, []);

  const updateMessages = useCallback((id: string, messages: ChatMessage[]) => {
    setConversations(prev =>
      prev.map(c =>
        c.id === id
          ? {
              ...c,
              messages,
              title: titleFromMessages(messages),
              updatedAt: new Date().toISOString(),
            }
          : c
      )
    );
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id);
      return next;
    });
    setActiveId(prev => {
      if (prev !== id) return prev;
      const remaining = conversations.filter(c => c.id !== id);
      return remaining.length > 0 ? remaining[0].id : null;
    });
  }, [conversations]);

  const selectConversation = useCallback((id: string) => {
    setActiveId(id);
  }, []);

  // Ensure there's always at least one conversation
  const ensureActive = useCallback((): string => {
    if (activeId && conversations.find(c => c.id === activeId)) return activeId;
    if (conversations.length > 0) {
      setActiveId(conversations[0].id);
      return conversations[0].id;
    }
    return newConversation();
  }, [activeId, conversations, newConversation]);

  return {
    conversations,
    activeConversation,
    activeId,
    newConversation,
    updateMessages,
    deleteConversation,
    selectConversation,
    ensureActive,
  };
}
