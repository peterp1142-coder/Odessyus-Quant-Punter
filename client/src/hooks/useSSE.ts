import { useCallback, useRef } from 'react';
import type { ReActStep } from '../types';

export interface SSECallbacks {
  onStep?: (step: ReActStep) => void;
  onComplete?: (data: { success:boolean; finalAnswer:string; stepCount:number; error?:string; metadata?:Record<string,unknown> }) => void;
  onSaved?: (data:{predictionId:string}) => void;
  onError?: (message:string) => void;
  onConnected?: () => void;
}

export function useSSE() {
  const esRef = useRef<EventSource|null>(null);
  const stream = useCallback((sessionId:string,message:string,callbacks:SSECallbacks,preset?:string) => {
    if (esRef.current) { esRef.current.close(); esRef.current=null; }

    const params = new URLSearchParams();
    if (preset) params.set('preset',preset);
    else if (message.trim()) params.set('message',message.trim());
    const query = params.toString();
    const url = `/api/chat/stream/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;

    let stopped=false;
    let completed=false;
    let retryTimer:number|undefined;
    let current:EventSource|null=null;

    const scheduleReconnect=()=>{
      if (stopped || completed || retryTimer!==undefined) return;
      retryTimer=window.setTimeout(()=>{
        retryTimer=undefined;
        connect();
      },1500);
    };

    const connect=()=>{
      if (stopped || completed) return;
      current?.close();
      const es=new EventSource(url);
      current=es;
      esRef.current=es;

      es.addEventListener('connected',()=>callbacks.onConnected?.());
      es.addEventListener('step',(e:MessageEvent)=>{
        try { callbacks.onStep?.(JSON.parse(e.data) as ReActStep); } catch {}
      });
      es.addEventListener('complete',(e:MessageEvent)=>{
        completed=true;
        try { callbacks.onComplete?.(JSON.parse(e.data)); } catch {}
        es.close();
        if (esRef.current===es) esRef.current=null;
      });
      es.addEventListener('saved',(e:MessageEvent)=>{
        try { callbacks.onSaved?.(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener('error',(e:MessageEvent)=>{
        if (stopped || completed) return;
        try {
          const d=JSON.parse(e.data||'{}');
          // Server-side stream errors are treated as transient while the job remains queued/running.
          if (d?.message && d.message !== 'Agent job disappeared') console.debug('[SSE] transient stream error:',d.message);
        } catch {}
        es.close();
        if (esRef.current===es) esRef.current=null;
        scheduleReconnect();
      });
      es.onerror=()=>{
        if (stopped || completed) return;
        es.close();
        if (esRef.current===es) esRef.current=null;
        scheduleReconnect();
      };
    };

    connect();

    return ()=>{
      stopped=true;
      completed=true;
      if (retryTimer!==undefined) window.clearTimeout(retryTimer);
      retryTimer=undefined;
      current?.close();
      current=null;
      if (esRef.current) { esRef.current.close(); esRef.current=null; }
    };
  },[]);

  const cancel=useCallback(()=>{
    if(esRef.current){esRef.current.close();esRef.current=null;}
  },[]);

  return {stream,cancel};
}
