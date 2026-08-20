import { useCallback, useRef } from 'react';
import type { ReActStep } from '../types';
export interface SSECallbacks { onStep?: (step:ReActStep)=>void; onComplete?: (data:{success:boolean;finalAnswer:string;stepCount:number;error?:string;metadata?:Record<string,unknown>})=>void; onSaved?: (data:{predictionId:string})=>void; onError?: (message:string)=>void; onConnected?: (data:{jobId:string;status:string})=>void; }
export function useSSE(){
  const esRef=useRef<EventSource|null>(null);
  const stream=useCallback((jobId:string,callbacks:SSECallbacks)=>{
    if(esRef.current){esRef.current.close();esRef.current=null;}
    const es=new EventSource(`/api/chat/stream/${encodeURIComponent(jobId)}`);esRef.current=es;
    es.addEventListener('connected',(e:MessageEvent)=>{try{callbacks.onConnected?.(JSON.parse(e.data));}catch{callbacks.onConnected?.({jobId,status:'running'});}});
    es.addEventListener('step',(e:MessageEvent)=>{try{callbacks.onStep?.(JSON.parse(e.data) as ReActStep);}catch{}});
    es.addEventListener('complete',(e:MessageEvent)=>{try{callbacks.onComplete?.(JSON.parse(e.data));}catch{}es.close();esRef.current=null;});
    es.addEventListener('saved',(e:MessageEvent)=>{try{callbacks.onSaved?.(JSON.parse(e.data));}catch{}});
    es.addEventListener('error',(e:MessageEvent)=>{try{const d=JSON.parse(e.data||'{}');callbacks.onError?.(d.message||'Stream error');}catch{}});
    es.onerror=()=>{es.close();esRef.current=null;};
    return ()=>{es.close();esRef.current=null;};
  },[]);
  const cancel=useCallback(async(jobId?:string)=>{if(esRef.current){esRef.current.close();esRef.current=null;}if(jobId){try{await fetch(`/api/chat/jobs/${encodeURIComponent(jobId)}`,{method:'DELETE'});}catch{}}},[]);
  return {stream,cancel};
}
