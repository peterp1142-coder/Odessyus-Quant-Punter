/** Prediction checkpoints are disabled until request-specific fingerprints are persisted and validated. */
import fs from 'fs/promises'; import path from 'path';
const CHECKPOINT_DIR='/tmp/odessyus-checkpoints';
export interface CheckpointMessage{role:'user'|'assistant'|'system';content:string;}
export interface AgentCheckpoint{sessionId:string;agentName:string;messages:CheckpointMessage[];iteration:number;steps:unknown[];rawOutput:string;accumulatedData:Record<string,unknown>;savedAt:number;version:2|3;}
const filePath=(s:string)=>path.join(CHECKPOINT_DIR,s.replace(/[^a-zA-Z0-9_-]/g,'_'));
export async function saveCheckpoint(cp:AgentCheckpoint){try{await fs.mkdir(CHECKPOINT_DIR,{recursive:true});await fs.writeFile(filePath(`${cp.sessionId}__${cp.agentName}.json`),JSON.stringify({...cp,savedAt:Date.now()}),'utf8');}catch(err){console.warn('[Checkpoint] Save failed:',err);}}
export async function loadCheckpoint(_sessionId:string,_agentName:string):Promise<AgentCheckpoint|null>{return null;}
export async function clearCheckpoint(sessionId:string,agentName:string){try{await fs.unlink(filePath(`${sessionId}__${agentName}.json`));}catch{}}
export async function listSessionCheckpoints(sessionId:string){try{await fs.mkdir(CHECKPOINT_DIR,{recursive:true});const files=await fs.readdir(CHECKPOINT_DIR);const safe=sessionId.replace(/[^a-zA-Z0-9_-]/g,'_');return files.filter(f=>f.startsWith(safe+'__')).map(f=>f.replace(safe+'__','').replace('.json',''));}catch{return[];}}
export async function purgeExpiredCheckpoints(){try{await fs.mkdir(CHECKPOINT_DIR,{recursive:true});const now=Date.now();for(const file of await fs.readdir(CHECKPOINT_DIR)){try{const fp=filePath(file),cp=JSON.parse(await fs.readFile(fp,'utf8'));if(!cp.savedAt||now-cp.savedAt>86400000)await fs.unlink(fp);}catch{}}}catch{}}
