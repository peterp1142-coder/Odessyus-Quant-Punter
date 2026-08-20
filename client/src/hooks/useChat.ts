import { useState,useCallback,useRef,useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import type { ChatMessage,ReActStep,PredictionMetadata } from '../types';
import { useSSE } from './useSSE';
interface UseChatOptions { conversationId:string; initialMessages?:ChatMessage[]; onMessagesChange?:(messages:ChatMessage[])=>void; }

export function useChat({conversationId,initialMessages=[],onMessagesChange}:UseChatOptions){
  const [messages,setMessages]=useState<ChatMessage[]>(initialMessages);const [isStreaming,setIsStreaming]=useState(false);const [activeSteps,setActiveSteps]=useState<ReActStep[]>([]);
  const {stream,cancel}=useSSE();const sessionIdRef=useRef(conversationId);const mountedRef=useRef(true);const jobRef=useRef<string|null>(null);const cleanupRef=useRef<(()=>void)|null>(null);
  useEffect(()=>{mountedRef.current=true;sessionIdRef.current=conversationId;setMessages(initialMessages);const active=[...initialMessages].reverse().find(m=>m.role==='assistant'&&m.isStreaming&&m.jobId);if(active?.jobId){jobRef.current=active.jobId;setIsStreaming(true);setActiveSteps(active.steps||[]);cleanupRef.current=streamJob(active.jobId,active.id);}return()=>{mountedRef.current=false;cleanupRef.current?.();cleanupRef.current=null;};},[conversationId]);
  useEffect(()=>{onMessagesChange?.(messages);},[messages,onMessagesChange]);

  const applyStep=useCallback((assistantId:string,step:ReActStep)=>{setActiveSteps(prev=>[...prev,step]);setMessages(prev=>prev.map(m=>m.id===assistantId?{...m,steps:[...(m.steps||[]),step],content:step.type==='thought'?`💭 ${step.content.substring(0,120)}...`:step.type==='action'?`🔧 Running: ${step.toolName||'tool'}...`:step.type==='observation'?'👁 Analyzing data...':step.type==='status'?step.content:m.content}:m));},[]);
  const streamJob=useCallback((jobId:string,assistantId:string)=>{
    jobRef.current=jobId;
    return stream(jobId,{onConnected:()=>{if(!mountedRef.current)return;setIsStreaming(true);setMessages(prev=>prev.map(m=>m.id===assistantId?{...m,isStreaming:true,content:m.content||'🔍 Reconnecting to background agent...'}:m));},onStep:(step)=>{if(mountedRef.current)applyStep(assistantId,step);},onSaved:data=>{setMessages(prev=>prev.map(m=>m.id===assistantId?{...m,predictionId:data.predictionId}:m));},onComplete:data=>{jobRef.current=null;if(!mountedRef.current)return;setIsStreaming(false);setActiveSteps([]);setMessages(prev=>prev.map(m=>m.id===assistantId?{...m,content:data.finalAnswer||'Analysis complete.',isStreaming:false,metadata:data.metadata as PredictionMetadata|undefined}:m));},onError:msg=>{if(!mountedRef.current)return;setIsStreaming(false);setActiveSteps([]);setMessages(prev=>prev.map(m=>m.id===assistantId?{...m,content:`⚠️ ${msg}`,isStreaming:false}:m));}});
  },[applyStep,stream]);

  const run=useCallback(async(text:string,preset?:string)=>{
    if((!text.trim()&&!preset)||isStreaming)return;const assistantMsgId=uuidv4();const assistantMsg:ChatMessage={id:assistantMsgId,role:'assistant',content:'',timestamp:new Date().toISOString(),isStreaming:true,steps:[]};const userMsg:ChatMessage|null=preset?null:{id:uuidv4(),role:'user',content:text.trim(),timestamp:new Date().toISOString()};setMessages(prev=>[...prev,...(userMsg?[userMsg]:[]),assistantMsg]);setIsStreaming(true);setActiveSteps([]);
    const body:Record<string,string>={sessionId:sessionIdRef.current};if(preset)body.preset=preset;else body.message=text.trim();
    let jobId:string|null=null;try{const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!res.ok)throw new Error('Failed to start agent job');const data=await res.json() as {sessionId:string;jobId:string};jobId=data.jobId;sessionIdRef.current=data.sessionId;jobRef.current=jobId;setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,jobId}:m));}catch(err){setIsStreaming(false);setMessages(prev=>prev.map(m=>m.id===assistantMsgId?{...m,content:`⚠️ ${err instanceof Error?err.message:'Failed to start request'}`,isStreaming:false}:m));return;}
    if(jobId)cleanupRef.current=streamJob(jobId,assistantMsgId);
  },[isStreaming,streamJob]);
  const sendMessage=useCallback((text:string)=>run(text),[run]);const runPreset=useCallback((preset:string)=>run('',preset),[run]);
  const cancelRequest=useCallback(()=>{const jobId=jobRef.current;jobRef.current=null;void cancel(jobId||undefined);setIsStreaming(false);setActiveSteps([]);setMessages(prev=>prev.map(m=>m.isStreaming?{...m,content:'⚠️ Request cancelled.',isStreaming:false}:m));},[cancel]);
  return {messages,isStreaming,activeSteps,sendMessage,runPreset,cancelRequest};
}
