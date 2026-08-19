import { useCallback, useRef } from 'react';
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

  const stream = useCallback((sessionId: string, message: string, callbacks: SSECallbacks) => {
    // Close any existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    const encoded = encodeURIComponent(message);
    const url = `/api/chat/stream/${sessionId}?message=${encoded}`;

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener('connected', () => {
      callbacks.onConnected?.();
    });

    es.addEventListener('step', (e: MessageEvent) => {
      try {
        const step = JSON.parse(e.data) as ReActStep;
        callbacks.onStep?.(step);
      } catch { /* ignore */ }
    });

    es.addEventListener('complete', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        callbacks.onComplete?.(data);
      } catch { /* ignore */ }
      es.close();
      esRef.current = null;
    });

    es.addEventListener('saved', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data);
        callbacks.onSaved?.(data);
      } catch { /* ignore */ }
    });

    es.addEventListener('error', (e: MessageEvent) => {
      try {
        const data = JSON.parse((e as MessageEvent).data || '{}');
        callbacks.onError?.(data.message || 'Stream error');
      } catch {
        callbacks.onError?.('Connection error');
      }
      es.close();
      esRef.current = null;
    });

    // onerror fires on proxy drop / network blip — close immediately so
    // EventSource doesn't auto-reconnect and launch a duplicate agent run.
    es.onerror = () => {
      es.close();
      esRef.current = null;
      callbacks.onError?.('Connection lost. Please try again.');
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  return { stream, cancel };
}
