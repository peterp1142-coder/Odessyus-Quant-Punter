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
        callbacks.onError?.(data.message || 'Stream error');
      } catch { /* ignore browser reconnect noise */ }
      es.close(); esRef.current = null;
    });
    es.onerror = () => {
      es.close(); esRef.current = null;
      // The background job is still alive. This is an observer/network failure,
      // so the caller should not mark the analysis itself as cancelled.
      callbacks.onError?.('Connection lost. The analysis is still running in the background.');
    };
    return () => { es.close(); esRef.current = null; };
  }, []);

  const cancel = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  useEffect(() => () => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  return { stream, cancel };
}
