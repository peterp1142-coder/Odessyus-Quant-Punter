import type { SubAgentResult } from './subagents/base.js';

export interface FixtureTask { agentName:string; fixture:string; tier:number; run:()=>Promise<SubAgentResult>; }
interface QueueItem extends FixtureTask { resolve:(value:SubAgentResult)=>void; reject:(reason:unknown)=>void; queuedAt:number; }

const MAX_QUEUE_WAIT_MS = Math.max(15_000, Number(process.env.AGENT_MAX_QUEUE_WAIT_MS || 120_000));
const MAX_QUEUE_DEPTH = Math.max(100, Number(process.env.AGENT_MAX_QUEUE_DEPTH || 150));

function cleanFixtureLabel(value:string):string {
  const raw=value.replace(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g,'$1').replace(/\s+/g,' ').trim();
  const pieces=raw.split(/\s*(?:\n|\|)\s*/).map(x=>x.trim()).filter(Boolean);
  const candidate=pieces.find(x=>/\b(?:vs\.?|v\.?)\b/i.test(x))||raw;
  const withoutTail=candidate.replace(/\s+(?:league|competition|kickoff|start|friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b.*$/i,'').trim();
  const matches=withoutTail.match(/^(.{2,80}?)\s+(?:vs\.?|v\.?)\s+(.{2,80}?)(?=\s+(?:\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|league|competition)\b|$)/i);
  return matches ? `${matches[1].trim()} vs ${matches[2].trim()}` : withoutTail.slice(0,180);
}

export class FixtureTaskScheduler {
  private readonly queues=new Map<string,QueueItem[]>();
  private readonly active=new Map<string,number>();
  private readonly concurrency=new Map<string,number>();
  constructor(private readonly defaultConcurrency=1){}
  setConcurrency(agentName:string,limit:number){this.concurrency.set(agentName,Math.max(1,Math.floor(limit)));this.pump(agentName);}
  enqueue(task:FixtureTask,onQueued?:(position:number)=>void):Promise<SubAgentResult>{
    const fixture=cleanFixtureLabel(task.fixture);
    let queue=this.queues.get(task.agentName)??[];
    queue=queue.filter(item=>Date.now()-item.queuedAt<MAX_QUEUE_WAIT_MS);
    if(queue.length>=MAX_QUEUE_DEPTH){
      return Promise.resolve({agentName:task.agentName,success:false,partial:true,data:{},steps:[],rawOutput:'',error:`Queue saturated for ${task.agentName}; fixture deferred instead of amplifying backlog.`});
    }
    const normalizedTask={...task,fixture};
    const promise=new Promise<SubAgentResult>((resolve,reject)=>queue.push({...normalizedTask,resolve,reject,queuedAt:Date.now()}));
    this.queues.set(task.agentName,queue);
    const position=queue.length;
    if(position>1)onQueued?.(position-1);
    this.pump(task.agentName); return promise;
  }
  queueDepth(agentName:string){return(this.queues.get(agentName)??[]).length;}
  activeCount(agentName:string){return this.active.get(agentName)??0;}
  snapshot(){const names=new Set([...this.queues.keys(),...this.concurrency.keys(),...this.active.keys()]);return Object.fromEntries([...names].map(name=>[name,{queued:this.queueDepth(name),active:this.activeCount(name),concurrency:this.concurrency.get(name)??this.defaultConcurrency}]));}
  totalQueued(){let n=0;for(const q of this.queues.values())n+=q.length;return n;}
  private pump(agentName:string){const queue=this.queues.get(agentName);if(!queue)return;const limit=this.concurrency.get(agentName)??this.defaultConcurrency;let active=this.active.get(agentName)??0;while(active<limit&&queue.length){const item=queue.shift()!;active++;this.active.set(agentName,active);const waitMs=Date.now()-item.queuedAt;if(waitMs>MAX_QUEUE_WAIT_MS){item.resolve({agentName,success:false,partial:true,data:{},steps:[],rawOutput:'',error:`Queue wait exceeded ${Math.round(MAX_QUEUE_WAIT_MS/1000)}s; stale task discarded.`});active--;this.active.set(agentName,active);continue;}void item.run().then(result=>{if(waitMs>250)console.log(`[Scheduler] ${agentName} waited ${waitMs}ms before ${item.fixture}`);item.resolve(result);}).catch(item.reject).finally(()=>{active=Math.max(0,(this.active.get(agentName)??1)-1);this.active.set(agentName,active);this.pump(agentName);});}}
}

export const fixtureScheduler=new FixtureTaskScheduler(1);
fixtureScheduler.setConcurrency('OddsScout',Number(process.env.AGENT_ODDS_CONCURRENCY||4));
fixtureScheduler.setConcurrency('FormScout',Number(process.env.AGENT_FORM_CONCURRENCY||4));
fixtureScheduler.setConcurrency('InjuryIntel',Number(process.env.AGENT_INJURY_CONCURRENCY||4));
fixtureScheduler.setConcurrency('SentimentAgent',Number(process.env.AGENT_SENTIMENT_CONCURRENCY||4));
fixtureScheduler.setConcurrency('LineupScout',Number(process.env.AGENT_LINEUP_CONCURRENCY||2));
fixtureScheduler.setConcurrency('RefereeScout',Number(process.env.AGENT_REFEREE_CONCURRENCY||4));
fixtureScheduler.setConcurrency('TacticalScout',Number(process.env.AGENT_TACTICAL_CONCURRENCY||2));
fixtureScheduler.setConcurrency('DataQualityScout',Number(process.env.AGENT_DATAQUALITY_CONCURRENCY||2));
fixtureScheduler.setConcurrency('MarketMicrostructureScout',Number(process.env.AGENT_MICROSTRUCTURE_CONCURRENCY||4));
fixtureScheduler.setConcurrency('ModelRiskScout',Number(process.env.AGENT_MODELRISK_CONCURRENCY||2));
fixtureScheduler.setConcurrency('PortfolioRiskScout',Number(process.env.AGENT_PORTFOLIO_CONCURRENCY||2));
