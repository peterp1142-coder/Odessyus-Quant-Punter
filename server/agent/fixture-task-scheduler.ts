import type { SubAgentResult } from './subagents/base.js';

export interface FixtureTask { agentName:string; fixture:string; tier:number; run:()=>Promise<SubAgentResult>; }
interface QueueItem extends FixtureTask { resolve:(value:SubAgentResult)=>void; reject:(reason:unknown)=>void; queuedAt:number; }

const MAX_QUEUE_WAIT_MS = Math.max(15_000, Number(process.env.AGENT_MAX_QUEUE_WAIT_MS || 120_000));
const MAX_QUEUE_DEPTH = Math.max(100, Number(process.env.AGENT_MAX_QUEUE_DEPTH || 150));

const NON_FIXTURE_SIDE_PATTERNS = [
  /^home$/i, /^away$/i, /^team\s*[ab]$/i, /^score$/i, /^odds$/i, /^fixtures?$/i,
  /^matches?$/i, /^kickoff$/i, /^today$/i, /^schedule$/i, /^preview$/i,
];

const COMPETITION_SIDE_PATTERNS = [
  /^(?:premier league|english premier league)$/i,
  /^(?:championship|english championship)$/i,
  /^(?:league one|league two|national league)$/i,
  /^(?:scottish premiership|scottish championship|scottish league one|scottish league two)$/i,
  /^(?:la liga|segunda (?:division|división))$/i,
  /^(?:serie a|serie b)$/i,
  /^(?:bundesliga|2\. bundesliga)$/i,
  /^(?:ligue 1|ligue 2)$/i,
  /^(?:eredivisie|primeira liga)$/i,
  /^(?:belgian pro league|turkish super lig|greek super league)$/i,
  /^(?:austrian bundesliga|swiss super league|danish superliga|allsvenskan|eliteserien|veikkausliiga)$/i,
  /^(?:mls|liga mx)$/i,
  /^(?:j1 league|j2 league|k league 1)$/i,
  /^(?:saudi pro league|qatar stars league|uae pro league)$/i,
  /^(?:south african premiership)$/i,
  /^(?:uefa champions league|uefa europa league|uefa conference league)$/i,
  /^(?:caf champions league|caf confederation cup)$/i,
];

function cleanFixtureLabel(value:string):string {
  const raw=value.replace(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g,'$1').replace(/\s+/g,' ').trim();
  const pieces=raw.split(/\s*(?:\n|\|)\s*/).map(x=>x.trim()).filter(Boolean);
  const candidate=pieces.find(x=>/\b(?:vs\.?|v\.?)\b/i.test(x))||raw;
  const withoutTail=candidate.replace(/\s+(?:league|competition|kickoff|start|friday|saturday|sunday|monday|tuesday|wednesday|thursday)\b.*$/i,'').trim();
  const matches=withoutTail.match(/^(.{2,80}?)\s+(?:vs\.?|v\.?)\s+(.{2,80}?)(?=\s+(?:\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|league|competition)\b|$)/i);
  return matches ? `${matches[1].trim()} vs ${matches[2].trim()}` : withoutTail.slice(0,180);
}

function fixtureIdentityError(value:string): string | null {
  const raw=value.replace(/\s+/g,' ').trim();
  const match=raw.match(/^(.{2,90}?)\s+(?:vs\.?|v\.?)\s+(.{2,90}?)$/i);
  if(!match) return 'Fixture must contain exactly two named sides joined by vs.';
  const home=match[1].trim();
  const away=match[2].trim();
  if(home.length<2 || away.length<2) return 'Fixture side is too short.';
  if(NON_FIXTURE_SIDE_PATTERNS.some(r=>r.test(home)) || NON_FIXTURE_SIDE_PATTERNS.some(r=>r.test(away))) return 'Generic schedule labels cannot be treated as teams.';
  if(COMPETITION_SIDE_PATTERNS.some(r=>r.test(home)) || COMPETITION_SIDE_PATTERNS.some(r=>r.test(away))) return 'League/competition names cannot be treated as fixture sides.';
  if(/(?:today's matches|matches taking place|fixtures?|schedule|kick.?off|match preview|odds by|live score|source:|flashscore|sofascore|espn)/i.test(home) || /(?:today's matches|matches taking place|fixtures?|schedule|kick.?off|match preview|odds by|live score|source:|flashscore|sofascore|espn)/i.test(away)) return 'Source/article text cannot be treated as a team name.';
  if(home.toLowerCase()===away.toLowerCase()) return 'Home and away sides must differ.';
  return null;
}

function makeRejectedResult(agentName:string,fixture:string,error:string):SubAgentResult {
  return { agentName, success:false, partial:true, data:{fixtureRejected:true}, steps:[], rawOutput:'', error:`Fixture identity gate rejected "${fixture}": ${error}` };
}

export class FixtureTaskScheduler {
  private readonly queues=new Map<string,QueueItem[]>();
  private readonly active=new Map<string,number>();
  private readonly concurrency=new Map<string,number>();
  constructor(private readonly defaultConcurrency=1){}
  setConcurrency(agentName:string,limit:number){this.concurrency.set(agentName,Math.max(1,Math.floor(limit)));this.pump(agentName);}
  enqueue(task:FixtureTask,onQueued?:(position:number)=>void):Promise<SubAgentResult>{
    const fixture=cleanFixtureLabel(task.fixture);
    const identityError=fixtureIdentityError(fixture);
    if(identityError){
      console.warn(`[Scheduler] Fixture identity gate rejected ${fixture}: ${identityError}`);
      return Promise.resolve(makeRejectedResult(task.agentName,fixture,identityError));
    }
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
