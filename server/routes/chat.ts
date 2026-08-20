import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/index.js';
import { createAgentJob, getAgentJob, cancelAgentJob, subscribeAgentJob } from '../agent/jobs.js';
import { getAgentPreset } from '../agent/presets.js';

const router=Router();
router.post('/',async(req:Request,res:Response)=>{
  const {message,sessionId:existing,preset}=req.body as {message?:string;sessionId?:string;preset?:string};
  const internalPreset=preset?getAgentPreset(preset):null;
  if(!message?.trim()&&!internalPreset)return res.status(400).json({error:'Message is required'});
  if(preset&&!internalPreset)return res.status(400).json({error:'Unknown agent preset'});
  const sessionId=existing||uuidv4();
  if(message?.trim()&&!internalPreset){try{await query('INSERT INTO conversations (id,session_id,channel,role,content) VALUES (?,?,?,?,?)',[uuidv4(),sessionId,'web','user',message.trim()]);}catch(err){console.error('[Chat] Save user msg:',err);}}
  try{const job=await createAgentJob({sessionId,message,preset});res.status(202).json({...job,status:'started'});}catch(err){console.error('[Chat] Start job:',err);res.status(500).json({error:'Failed to start agent job'});}
});
router.get('/jobs/:jobId',async(req:Request,res:Response)=>{const job=await getAgentJob(req.params.jobId);if(!job)return res.status(404).json({error:'Job not found'});res.json({jobId:job.id,sessionId:job.sessionId,status:job.status,steps:job.steps,result:job.result,predictionId:job.predictionId,error:job.error});});
router.delete('/jobs/:jobId',async(req:Request,res:Response)=>{const cancelled=await cancelAgentJob(req.params.jobId);if(!cancelled)return res.status(409).json({error:'Job is not cancellable'});res.json({ok:true,status:'cancelled'});});
router.get('/stream/:jobId',async(req:Request,res:Response)=>{
  const job=await getAgentJob(req.params.jobId);if(!job)return res.status(404).json({error:'Job not found'});
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');res.flushHeaders();
  const sse=(event:string,data:unknown)=>{if(!res.writableEnded)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
  const heartbeat=setInterval(()=>{if(!res.writableEnded)res.write(': heartbeat\n\n');},15000);let unsubscribe:(()=>void)|undefined;const cleanup=()=>{clearInterval(heartbeat);unsubscribe?.();if(!res.writableEnded)res.end();};
  req.on('close',cleanup);sse('connected',{jobId:job.id,sessionId:job.sessionId,status:job.status});
  for(const step of job.steps)sse('step',step);
  if(job.result){if(job.predictionId)sse('saved',{predictionId:job.predictionId});sse('complete',job.result);cleanup();return;}
  unsubscribe=subscribeAgentJob(job,{onStep:step=>sse('step',step),onSaved:data=>sse('saved',data),onError:data=>sse('error',data),onComplete:result=>{sse('complete',result);cleanup();}});
});
router.get('/history/:sessionId',async(req:Request,res:Response)=>{try{const rows=await query<{id:string;role:string;content:string;created_at:Date}[]>('SELECT id,role,content,created_at FROM conversations WHERE session_id=? ORDER BY created_at ASC LIMIT 100',[req.params.sessionId]);res.json({messages:rows,sessionId:req.params.sessionId});}catch{res.status(500).json({error:'Failed to load history'});}});
export default router;
