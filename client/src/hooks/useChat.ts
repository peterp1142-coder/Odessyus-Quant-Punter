import { useState, useCallback, useRef, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage, ReActStep, PredictionMetadata } from '../types';
import { useSSE } from './useSSE';

interface LiveBrowserVisual { image:string; url?:string; hint?:string; capturedAt:string; }
interface UseChatOptions { conversationId:string; initialMessages?:ChatMessage[]; onMessagesChange?:(messages:ChatMessage[])=>void; }

export function useChat({conversationId,initialMessages=[],onMessagesChange}:UseChatOptions) {
  const [messages,setMessages]=useState<ChatMessage[]>(initialMessages);
  const [isStreaming,setIsStreaming]=useState(false);
  const [activeSteps,setActiveSteps]=useState<ReActStep[]>([]);
  const [liveBrowserVisual,setLiveBrowserVisual]=useState<LiveBrowserVisual|null>(null);
  const {stream,cancel}=useSSE();
  const abortRef=useRef<(()=>void)|null>(null);
  const sessionIdRef=useRef(conversationId);
  const streamingIdRef=useRef<string|null>(null);

  useEffect(()=>{
    sessionIdRef.current=conversationId;
    setMessages(initialMessages);
    setActiveSteps([]);
    setLiveBrowserVisual(null);
    const pending=initialMessages.find(m=>m.isStreaming && m.role==='assistant');
    streamingIdRef.current=pending?.id || null;
    setIsStreaming(Boolean(pending));
  },[conversationId]);
  useEffect(()=>{onMessagesChange?.(messages);},[messages,onMessagesChange]);

  // Live screenshots are intentionally ephemeral UI state, not chat history.
  // Polling lets the dashboard show the latest local-Chromium frame even after
  // an SSE reconnect or page refresh while the durable background job continues.
  useEffect(()=>{
    if(!isStreaming) return;
    let stopped=false;
    const poll=async()=>{
      try{
        const res=await fetch(`/api/chat/visual/${encodeURIComponent(sessionIdRef.current)}`,{cache:'no-store'});
        if(res.status===204)return;
        if(!res.ok)return;
        const visual=await res.json() as LiveBrowserVisual;
        if(!stopped && visual.image)setLiveBrowserVisual(visual);
      }catch{/* dashboard visual polling is best-effort */}
    };
    void poll();
    const timer=window.setInterval(()=>void poll(),900);
    return()=>{stopped=true;window.clearInterval(timer);};
  },[isStreaming]);

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
        setIsStreaming(false);setActiveSteps([]);streamingIdRef.current=null;
        setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:data.finalAnswer||'Analysis complete.',isStreaming:false,metadata:data.metadata as PredictionMetadata|undefined}:m));
      },
      onSaved:(data)=>setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,predictionId:data.predictionId}:m)),
      onError:(msg)=>{
        setIsStreaming(false);setActiveSteps([]);
        setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:`⚠️ ${msg}`,isStreaming:false}:m));
      },
    });
    abortRef.current=cleanup;
  },[stream]);

  // A page refresh remounts the hook. If the local conversation contains a streaming
  // assistant message, reattach to its durable server-side job instead of starting over.
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
    setMessages(prev=>[...prev,...(userMsg?[userMsg]:[]),assistantMsg]);setIsStreaming(true);setActiveSteps([]);setLiveBrowserVisual(null);

    try{
      const body:Record<string,string>={sessionId:sessionIdRef.current};
      if(preset)body.preset=preset;else body.message=text.trim();
      const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      if(!res.ok)throw new Error('Failed to queue agent job');
      const data=await res.json() as {sessionId:string;jobId:string};
      attachToJob(data.sessionId,assistantMsgId);
    }catch(err){
      setIsStreaming(false);streamingIdRef.current=null;
      setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:`⚠️ ${err instanceof Error?err.message:'Failed to start agent job'}`,isStreaming:false}:m));
    }
  },[isStreaming,attachToJob]);

  const sendMessage=useCallback((text:string)=>run(text),[run]);
  const runPreset=useCallback((preset:string)=>run('',preset),[run]);
  const cancelRequest=useCallback(()=>{
    cancel();abortRef.current?.();abortRef.current=null;setIsStreaming(false);setActiveSteps([]);
    setMessages(prev=>prev.map(m=>m.isStreaming?{...m,content:'⚠️ Stream disconnected. The background job continues running; reopen this chat to reconnect.',isStreaming:false}:m));
  },[cancel]);
  return {messages,isStreaming,activeSteps,liveBrowserVisual,sendMessage,runPreset,cancelRequest};
}
