import { useCallback, useEffect, useRef } from 'react';
import type { ReActStep } from '../types';

export interface SSECallbacks {
  onStep?: (step: ReActStep) => void;
  onComplete?: (data: { success: boolean; finalAnswer: string; stepCount: number; error?: string; metadata?: Record<string, unknown> }) => void;
  onSaved?: (data: { predictionId: string }) => void;
  onError?: (message: string) => void;
  onConnected?: () => void;
}

export function useSSE() {
  const esRef = useRef<EventSource | null>(null);

  const stream = useCallback((sessionId: string, message: string, callbacks: SSECallbacks, preset?: string) => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const query = preset
      ? `preset=${encodeURIComponent(preset)}`
      : message
        ? `message=${encodeURIComponent(message)}`
        : '';
    const url = `/api/chat/stream/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', () => callbacks.onConnected?.());
    es.addEventListener('step', (e: MessageEvent) => {
      try { callbacks.onStep?.(JSON.parse(e.data) as ReActStep); } catch { /* ignore malformed replay */ }
    });
    es.addEventListener('complete', (e: MessageEvent) => {
      try { callbacks.onComplete?.(JSON.parse(e.data)); } catch { /* ignore */ }
      es.close(); esRef.current = null;
    });
    es.addEventListener('saved', (e: MessageEvent) => {
      try { callbacks.onSaved?.(JSON.parse(e.data)); } catch { /* ignore */ }
    });
    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data = JSON.parse((e as MessageEvent).data || '{}');
        if (data.message) callbacks.onError?.(data.message);
      } catch { /* ignore browser/network errors */ }
      es.close(); esRef.current = null;
    });
    es.onerror = () => {
      // Network loss, navigation and refresh only close this observer. The server
      // continues the background job and a later mount can reconnect to it.
      es.close();
      esRef.current = null;
    };
    return () => { es.close(); esRef.current = null; };
  }, []);

  const cancel = useCallback(() => {
    // This only disconnects the observer. There is deliberately no server-side
    // cancellation endpoint for an in-flight background task.
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  useEffect(() => () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  return { stream, cancel };
}
