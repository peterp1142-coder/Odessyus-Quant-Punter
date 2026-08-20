import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ReActStep, PredictionMetadata } from '../types';
import { useSSE } from './useSSE';

interface UseChatOptions { conversationId: string; initialMessages?: ChatMessage[]; onMessagesChange?: (messages: ChatMessage[]) => void; }

const ACTIVE_TASK_KEY = 'odessyus_active_task';
type ActiveTask = { jobId: string; sessionId: string; conversationId: string; message: string; preset?: string; assistantMsgId: string };

function readActiveTask(): ActiveTask | null {
  try {
    const raw = localStorage.getItem(ACTIVE_TASK_KEY);
    return raw ? JSON.parse(raw) as ActiveTask : null;
  } catch { return null; }
}

function writeActiveTask(task: ActiveTask) {
  try { localStorage.setItem(ACTIVE_TASK_KEY, JSON.stringify(task)); } catch { /* ignore quota */ }
}

function clearActiveTask(jobId?: string) {
  try {
    const current = readActiveTask();
    if (!jobId || !current || current.jobId === jobId) localStorage.removeItem(ACTIVE_TASK_KEY);
  } catch { /* ignore */ }
}

export function useChat({ conversationId, initialMessages = [], onMessagesChange }: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeSteps, setActiveSteps] = useState<ReActStep[]>([]);
  const { stream, cancel } = useSSE();
  const abortRef = useRef<(() => void) | null>(null);
  const sessionIdRef = useRef<string>(conversationId);
  const reconnectAttemptedRef = useRef(false);

  useEffect(() => {
    sessionIdRef.current = conversationId;
    setMessages(initialMessages);
    setIsStreaming(false);
    setActiveSteps([]);
    reconnectAttemptedRef.current = false;
  // initialMessages intentionally excluded: parent updates it as messages change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => { onMessagesChange?.(messages); }, [messages, onMessagesChange]);

  const attachStream = useCallback((jobId: string, assistantMsgId: string, message: string, preset?: string, sessionId?: string) => {
    const cleanup = stream(jobId, message, {
      onConnected: () => setIsStreaming(true),
      onStep: (step) => {
        setActiveSteps(prev => [...prev, step]);
        setMessages(prev => prev.map(m => {
          if (m.id !== assistantMsgId) return m;
          let statusText = m.content;
          if (step.type === 'thought') statusText = `💭 ${step.content.substring(0, 120)}...`;
          else if (step.type === 'action') statusText = `🔧 Running: ${step.toolName || 'tool'}...`;
          else if (step.type === 'observation') statusText = '👁 Analyzing data...';
          else if (step.type === 'status') statusText = step.content;
          return { ...m, content: statusText, isStreaming: true, steps: [...(m.steps || []), step] };
        }));
      },
      onComplete: (data) => {
        setIsStreaming(false);
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? {
          ...m, content: data.finalAnswer || 'Analysis complete.', isStreaming: false,
          metadata: data.metadata as PredictionMetadata | undefined,
        } : m));
        setActiveSteps([]);
        clearActiveTask(jobId);
      },
      onSaved: (data) => setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, predictionId: data.predictionId } : m)),
      onError: (msg) => {
        setIsStreaming(false); setActiveSteps([]);
        setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: `⚠️ ${msg}`, isStreaming: false } : m));
        clearActiveTask(jobId);
      },
    }, preset, sessionId);
    abortRef.current = cleanup;
    return cleanup;
  }, [stream]);

  useEffect(() => {
    if (reconnectAttemptedRef.current) return;
    const task = readActiveTask();
    if (!task || task.conversationId !== conversationId) return;
    reconnectAttemptedRef.current = true;
    sessionIdRef.current = task.sessionId;
    const assistantExists = initialMessages.some(m => m.id === task.assistantMsgId);
    if (!assistantExists) return;
    setIsStreaming(true);
    attachStream(task.jobId, task.assistantMsgId, '', task.preset, task.sessionId);
    return () => { abortRef.current?.(); };
  // initialMessages is only needed for the first mount; it must not be a trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, attachStream]);

  const run = useCallback(async (text: string, preset?: string) => {
    if ((!text.trim() && !preset) || isStreaming) return;

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

    try {
      const body: Record<string, string> = { sessionId: sessionIdRef.current };
      if (preset) body.preset = preset; else body.message = text.trim();
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Unable to start task (${res.status})`);
      const data = await res.json() as { sessionId: string; jobId: string };
      sessionIdRef.current = data.sessionId;
      writeActiveTask({
        jobId: data.jobId,
        sessionId: data.sessionId,
        conversationId,
        message: text.trim(),
        preset,
        assistantMsgId,
      });
      attachStream(data.jobId, assistantMsgId, text.trim(), preset, data.sessionId);
    } catch (err) {
      setIsStreaming(false);
      setMessages(prev => prev.map(m => m.id === assistantMsgId ? { ...m, content: `⚠️ ${err instanceof Error ? err.message : 'Unable to start task'}`, isStreaming: false } : m));
    }
  }, [conversationId, isStreaming, attachStream]);

  const sendMessage = useCallback((text: string) => run(text), [run]);
  const runPreset = useCallback((preset: string) => run('', preset), [run]);

  const cancelRequest = useCallback(() => {
    // Disconnect the browser observer only. Page refresh/navigation must never
    // cancel the server-side task.
    cancel();
    abortRef.current = null;
    setIsStreaming(false);
    setActiveSteps([]);
  }, [cancel]);

  return { messages, isStreaming, activeSteps, sendMessage, runPreset, cancelRequest };
}
