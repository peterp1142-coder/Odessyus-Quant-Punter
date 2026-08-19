import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ReActStep, PredictionMetadata } from '../types';
import { useSSE } from './useSSE';

interface UseChatOptions { conversationId: string; initialMessages?: ChatMessage[]; onMessagesChange?: (messages: ChatMessage[]) => void; }

export function useChat({ conversationId, initialMessages = [], onMessagesChange }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeSteps, setActiveSteps] = useState<ReActStep[]>([]);
  const { stream, cancel } = useSSE();
  const abortRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string>(conversationId);

  useEffect(() => {
    sessionIdRef.current = conversationId;
    setMessages(initialMessages);
    setIsStreaming(false);
    setActiveSteps([]);
  }, [conversationId]);

  useEffect(() => { onMessagesChange?.(messages); }, [messages, onMessagesChange]);

  const run = useCallback(async (text: string, preset?: string) => {
    if ((!text.trim() && !preset) || isStreaming) return;

    // Normal chat displays the user's message. Hidden presets deliberately do not:
    // the server owns the prompt and only returns the resulting analysis.
    const assistantMsgId = uuidv4();
    const assistantMsg: ChatMessage = {
      id: assistantMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString(), isStreaming: true, steps: [],
    };
    const userMsg: ChatMessage | null = preset ? null : {
      id: uuidv4(), role: 'user', content: text.trim(), timestamp: new Date().toISOString(),
    };
    setMessages(prev => [...prev, ...(userMsg ? [userMsg] : []), assistantMsg]);
    setIsStreaming(true);
    setActiveSteps([]);

    let activeSessionId = sessionIdRef.current;
    try {
      const body: Record<string, string> = { sessionId: sessionIdRef.current };
      if (preset) body.preset = preset; else body.message = text.trim();
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { sessionId: string };
        activeSessionId = data.sessionId;
        sessionIdRef.current = data.sessionId;
      }
    } catch { /* stream can still attempt the existing session */ }

    const cleanup = stream(activeSessionId, text.trim(), {
      onConnected: () => setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: preset ? '📊 Building statistically plausible accumulators from today’s fixtures…' : '🔍 Connecting to data sources...' } : m)),
      onStep: (step) => {
        setActiveSteps(prev => [...prev, step]);
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantMsgId) return m;
          let statusText = m.content;
          if (step.type === 'thought') statusText = `💭 ${step.content.substring(0, 120)}...`;
          else if (step.type === 'action') statusText = `🔧 Running: ${step.toolName || 'tool'}...`;
          else if (step.type === 'observation') statusText = '👁 Analyzing data...';
          else if (step.type === 'status') statusText = step.content;
          return { ...m, content: statusText, steps: [...(m.steps || []), step] };
        }));
      },
      onComplete: (data) => {
        setIsStreaming(false);
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: data.finalAnswer || 'Analysis complete.', isStreaming: false, metadata: data.metadata as PredictionMetadata | undefined } : m));
        setActiveSteps([]);
      },
      onSaved: (data) => setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, predictionId: data.predictionId } : m)),
      onError: (msg) => {
        setIsStreaming(false); setActiveSteps([]);
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: `⚠️ ${msg}`, isStreaming: false } : m));
      },
    }, preset);
    abortRef.current = cleanup;
  }, [isStreaming, stream]);

  const sendMessage = useCallback((text: string) => run(text), [run]);
  const runPreset = useCallback((preset: string) => run('', preset), [run]);

  const cancelRequest = useCallback(() => {
    cancel(); abortRef.current?.(); setIsStreaming(false); setActiveSteps([]);
    setMessages(prev => prev.map(m => m.isStreaming ? { ...m, content: '⚠️ Request cancelled.', isStreaming: false } : m));
  }, [cancel]);

  return { messages, isStreaming, activeSteps, sendMessage, runPreset, cancelRequest };
}
