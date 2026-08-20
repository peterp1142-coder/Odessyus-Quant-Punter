import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ReActStep, PredictionMetadata } from '../types';
import { useSSE } from './useSSE';

interface LiveBrowserVisual { image:string; url?:string; hint?:string; capturedAt:string; interactive?:boolean; verificationStatus?:'none'|'required'|'resuming'|'completed'|'expired'; verificationType?:string; verificationReason?:string; }
interface VerificationState { status:'required'|'resuming'|'completed'|'expired'|null; challengeType?:string; reason?:string; url?:string; title?:string; }
interface UseChatOptions { conversationId:string; initialMessages?:ChatMessage[]; onMessagesChange?:(messages:ChatMessage[])=>void; }

export function useChat({conversationId,initialMessages=[],onMessagesChange}:UseChatOptions) {
  const [messages,setMessages]=useState<ChatMessage[]>(initialMessages);
  const [isStreaming,setIsStreaming]=useState(false);
  const [activeSteps,setActiveSteps]=useState<ReActStep[]>([]);
  const [liveBrowserVisual,setLiveBrowserVisual]=useState<LiveBrowserVisual|null>(null);
  const [verification,setVerification]=useState<VerificationState>({status:null});
  const {stream,cancel}=useSSE();
  const abortRef=useRef<(()=>void)|null>(null);
  const sessionIdRef=useRef(conversationId);
  const streamingIdRef=useRef<string|null>(null);

  useEffect(()=>{
    sessionIdRef.current=conversationId;
    setMessages(initialMessages);
    setActiveSteps([]);
    setLiveBrowserVisual(null);
    setVerification({status:null});
    const pending=initialMessages.find(m=>m.isStreaming && m.role==='assistant');
    streamingIdRef.current=pending?.id || null;
    setIsStreaming(Boolean(pending));
  },[conversationId]);
  useEffect(()=>{onMessagesChange?.(messages);},[messages,onMessagesChange]);

  useEffect(()=>{
    if(!isStreaming) return;
    let stopped=false;
    const poll=async()=>{
      try{
        const [visualRes, verificationRes]=await Promise.all([
          fetch(`/api/chat/visual/${encodeURIComponent(sessionIdRef.current)}`,{cache:'no-store'}),
          fetch(`/api/chat/verification/${encodeURIComponent(sessionIdRef.current)}`,{cache:'no-store'}),
        ]);
        if(visualRes.ok){const visual=await visualRes.json() as LiveBrowserVisual;if(!stopped&&visual.image)setLiveBrowserVisual(visual);}
        if(verificationRes.status===204){if(!stopped)setVerification(v=>v.status==='required'||v.status==='resuming'?v:{status:null});}
        else if(verificationRes.ok){const v=await verificationRes.json() as VerificationState;if(!stopped)setVerification(v);}
      }catch{/* dashboard polling is best-effort */}
    };
    void poll();
    const timer=window.setInterval(()=>void poll(),900);
    return()=>{stopped=true;window.clearInterval(timer);};
  },[isStreaming]);

  const verificationAction=useCallback(async(action:{type:'click';x:number;y:number}|{type:'scroll';deltaY:number}|{type:'key';key:string}|{type:'text';text:string})=>{
    const res=await fetch(`/api/chat/verification/action/${encodeURIComponent(sessionIdRef.current)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action)});
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'Verification action failed');
  },[]);

  const resumeVerification=useCallback(async()=>{
    const res=await fetch(`/api/chat/verification/resume/${encodeURIComponent(sessionIdRef.current)}`,{method:'POST'});
    if(!res.ok)throw new Error((await res.json().catch(()=>({}))).error||'Could not resume verification');
    setVerification(v=>({...v,status:'resuming'}));
  },[]);

  const attachToJob=useCallback((sessionId:string,assistantMsgId:string)=>{
    sessionIdRef.current=sessionId;
    setIsStreaming(true);
    setActiveSteps([]);
    const cleanup=stream(sessionId,'',{
      onConnected:()=>setMessages(prev=>prev.map(m=>m.id===assistantMsgId && m.content===''?{...m,content:'🔍 Reconnecting to the background agent…'}:m)),
      onStep:(step)=>{
        setActiveSteps(prev=>[...prev,step]);
        setMessages(prev=>prev.map(m=>{
          if(m.id!==assistantMsgId)return m;
          let statusText=m.content;
          if(step.type==='thought')statusText=`💭 ${step.content.substring(0,120)}...`;
          else if(step.type==='action')statusText=`🔧 Running: ${step.toolName||'tool'}...`;
          else if(step.type==='observation')statusText='👁 Analyzing data...';
          else if(step.type==='status')statusText=step.content;
          return {...m,content:statusText,steps:[...(m.steps||[]),step]};
        }));
      },
      onComplete:(data)=>{
        setIsStreaming(false);setActiveSteps([]);streamingIdRef.current=null;setVerification(v=>({...v,status:v.status==='resuming'?'completed':v.status}));
        setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:data.finalAnswer||'Analysis complete.',isStreaming:false,metadata:data.metadata as PredictionMetadata|undefined}:m));
      },
      onSaved:(data)=>setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,predictionId:data.predictionId}:m)),
      onError:(msg)=>{setIsStreaming(false);setActiveSteps([]);setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:`⚠️ ${msg}`,isStreaming:false}:m));},
    });
    abortRef.current=cleanup;
  },[stream]);

  useEffect(()=>{
    const pending=initialMessages.find(m=>m.isStreaming && m.role==='assistant');
    if(pending){attachToJob(conversationId,pending.id);}
    return ()=>{abortRef.current?.();abortRef.current=null;};
  },[conversationId,attachToJob]);

  const run=useCallback(async(text:string,preset?:string)=>{
    if((!text.trim()&&!preset)||isStreaming)return;
    const assistantMsgId=uuidv4();
    streamingIdRef.current=assistantMsgId;
    const assistantMsg:ChatMessage={id:assistantMsgId,role:'assistant',content:'',timestamp:new Date().toISOString(),isStreaming:true,steps:[]};
    const userMsg:ChatMessage|null=preset?null:{id:uuidv4(),role:'user',content:text.trim(),timestamp:new Date().toISOString()};
    setMessages(prev=>[...prev,...(userMsg?[userMsg]:[]),assistantMsg]);setIsStreaming(true);setActiveSteps([]);setLiveBrowserVisual(null);setVerification({status:null});
    try{
      const body:Record<string,string>={sessionId:sessionIdRef.current};
      if(preset)body.preset=preset;else body.message=text.trim();
      const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!res.ok)throw new Error('Failed to queue agent job');
      const data=await res.json() as {sessionId:string;jobId:string};
      attachToJob(data.sessionId,assistantMsgId);
    }catch(err){setIsStreaming(false);streamingIdRef.current=null;setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:`⚠️ ${err instanceof Error?err.message:'Failed to start agent job'}`,isStreaming:false}:m));}
  },[isStreaming,attachToJob]);

  const sendMessage=useCallback((text:string)=>run(text),[run]);
  const runPreset=useCallback((preset:string)=>run('',preset),[run]);
  const cancelRequest=useCallback(()=>{cancel();abortRef.current?.();abortRef.current=null;setIsStreaming(false);setActiveSteps([]);setMessages(prev=>prev.map(m=>m.isStreaming?{...m,content:'⚠️ Stream disconnected. The background job continues running; reopen this chat to reconnect.',isStreaming:false}:m));},[cancel]);
  return {messages,isStreaming,activeSteps,liveBrowserVisual,verification,verificationAction,resumeVerification,sendMessage,runPreset,cancelRequest};
}
