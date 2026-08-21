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
    const es = new EventSource(url); esRef.current=es;
    let opened=false;
    let completed=false;
    let reconnectTimer:number|undefined;
    const reconnect=()=>{
      if (completed) return;
      if (reconnectTimer!==undefined) return;
      reconnectTimer=window.setTimeout(()=>{
        reconnectTimer=undefined;
        stream(sessionId,'',callbacks,preset);
      },1500);
    };
    es.addEventListener('connected',()=>{opened=true;callbacks.onConnected?.();});
    es.addEventListener('step',(e:MessageEvent)=>{try{callbacks.onStep?.(JSON.parse(e.data) as ReActStep);}catch{}});
    es.addEventListener('complete',(e:MessageEvent)=>{completed=true;try{callbacks.onComplete?.(JSON.parse(e.data));}catch{} es.close();esRef.current=null;});
    es.addEventListener('saved',(e:MessageEvent)=>{try{callbacks.onSaved?.(JSON.parse(e.data));}catch{}});
    es.addEventListener('error',(e:MessageEvent)=>{
      try{
        const d=JSON.parse(e.data||'{}');
        if (d?.message && !completed) callbacks.onError?.(d.message);
      }catch{}
      if (!completed) reconnect();
    });
    es.onerror=()=>{
      if (!completed) reconnect();
    };
    return ()=>{completed=true;if(reconnectTimer!==undefined)window.clearTimeout(reconnectTimer);es.close();if(esRef.current===es)esRef.current=null;};
  },[]);
  const cancel=useCallback(()=>{if(esRef.current){esRef.current.close();esRef.current=null;}},[]);
  return {stream,cancel};
}
