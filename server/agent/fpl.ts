import { analyzeFplManagerIntel } from './fpl-manager-intel.js';

const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FPL_FIXTURES = 'https://fantasy.premierleague.com/api/fixtures/';
const HTTP_TIMEOUT = 12000;
const HORIZON = 6;
const BEAM_WIDTH = 3000;

interface FplPlayer {
  id:number; first_name:string; second_name:string; web_name:string; team:number; element_type:number;
  now_cost:number; status:string; chance_of_playing_next_round:number|null; form:string; points_per_game:string;
  ep_next:string; value_form:string; value_season:string; minutes:number; goals_scored:number; assists:number;
  clean_sheets:number; bonus:number; bps:number; influence:string; creativity:string; threat:string; ict_index:string;
  selected_by_percent:string; transfers_in_event:number; transfers_out_event:number; total_points:number;
}
interface FplTeam { id:number; name:string; short_name:string; code:number; strength:number; strength_overall_home:number; strength_overall_away:number; }
interface FplFixture {
  event:number|null; team_h:number; team_a:number; team_h_difficulty:number; team_a_difficulty:number;
  finished:boolean; kickoff_time:string|null;
}
interface FplEvent { id:number; name:string; deadline_time:string|null; finished:boolean; is_current:boolean; is_next:boolean; }
interface FplResponse { elements:FplPlayer[]; teams:FplTeam[]; events:FplEvent[]; }
interface ManagerSignal {
  roleSecurity:number; minutesRisk:number; tacticalUpside:number; confidence:number;
  sentiment:string; freshnessDays:number; quoteSignals:string[]; latestEvidence?:string[];
}
interface EnrichedPlayer {
  p:FplPlayer; team:FplTeam; score:number; projected6:number; minutesRate:number; fixtureAvg:number; fixtureCount:number; managerIntel?:ManagerSignal;
}

async function fetchJson<T>(url:string):Promise<T>{
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),HTTP_TIMEOUT);
  try { const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Odessyus-FPL/2.1'},signal:controller.signal}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json() as T; }
  finally { clearTimeout(timer); }
}

function numeric(v:string|number|undefined){const n=Number(v);return Number.isFinite(n)?n:0;}
function availability(p:FplPlayer){
  if(p.status==='u'||p.status==='s') return 0;
  if(typeof p.chance_of_playing_next_round==='number') return Math.max(0,Math.min(1,p.chance_of_playing_next_round/100));
  return p.status==='a'?1:0.65;
}
function posQuota(pos:number){return pos===1?2:pos===2?5:pos===3?5:3;}
function positionName(pos:number){return pos===1?'GK':pos===2?'DEF':pos===3?'MID':'FWD';}

function nextGameweek(data:FplResponse):FplEvent|null{
  const event=data.events.find(e=>e.is_next)
    || data.events.find(e=>!e.finished && e.deadline_time !== null && new Date(e.deadline_time).getTime()>Date.now())
    || data.events.find(e=>e.is_current)
    || data.events[data.events.length-1];
  return event ?? null;
}

function buildHorizonFixtures(fixtures:FplFixture[],startGw:number){
  return fixtures.filter(f=>f.event!==null && !f.finished && f.event>=startGw && f.event<startGw+HORIZON);
}

function playerFixtureProfile(p:FplPlayer,fixtures:FplFixture[],startGw:number){
  const rows=fixtures.filter(f=>f.event!==null&&!f.finished&&f.event>=startGw&&f.event<startGw+HORIZON&&(f.team_h===p.team||f.team_a===p.team));
  if(!rows.length)return{avg:3.2,count:0,gwCount:0};
  let difficultySum=0;
  for(const f of rows)difficultySum+=f.team_h===p.team?f.team_h_difficulty:f.team_a_difficulty;
  return{avg:difficultySum/rows.length,count:rows.length,gwCount:new Set(rows.map(r=>r.event as number)).size};
}

function managerAdjustment(intel?:ManagerSignal){
  if(!intel)return 0;
  const freshness=intel.freshnessDays<=2?1:intel.freshnessDays<=4?0.8:intel.freshnessDays<=7?0.55:intel.freshnessDays<=14?0.25:0.1;
  const role=(intel.roleSecurity-0.5)*1.2;
  const mins=-intel.minutesRisk*1.5;
  const tactical=intel.tacticalUpside*0.8;
  const sentiment=intel.sentiment==='positive'?0.18:intel.sentiment==='negative'?-0.18:0;
  return (role+mins+tactical+sentiment)*Math.max(0.35,intel.confidence)*freshness;
}

function scorePlayer(p:FplPlayer,fixtures:FplFixture[],startGw:number,intel?:ManagerSignal):EnrichedPlayer{
  const team: FplTeam = (globalThis as any).__fplTeamMap.get(p.team);
  if(!team) throw new Error(`FPL team ${p.team} not found for ${p.web_name}`);
  const prof=playerFixtureProfile(p,fixtures,startGw);
  const minsRate=Math.min(1,Math.max(0,p.minutes/(HORIZON*90)));
  const avail=availability(p);
  const epNext=Math.max(0,numeric(p.ep_next));
  const ppg=Math.max(0,numeric(p.points_per_game));
  const form=Math.max(0,numeric(p.form));
  const value=Math.max(0,numeric(p.value_form));
  const valueSeason=Math.max(0,numeric(p.value_season));
  const bonusRate=Math.max(0,p.bonus/Math.max(1,p.minutes/90));
  const bpsRate=Math.max(0,p.bps/Math.max(1,p.minutes));
  const threat=Math.max(0,numeric(p.threat));
  const creativity=Math.max(0,numeric(p.creativity));
  const influence=Math.max(0,numeric(p.influence));
  const ict=Math.max(0,numeric(p.ict_index));
  const fixtureQuality=Math.max(0,Math.min(1,(5.4-prof.avg)/4.4));
  const teamStrength=(team.strength||3)/5;
  const roleAdj=managerAdjustment(intel);
  const baseGameweek=epNext*0.35+form*0.12+ppg*0.10+value*0.08+valueSeason*0.04+fixtureQuality*1.10+teamStrength*0.50+Math.min(1,minsRate)*0.95+Math.min(1,threat/120)*0.18+Math.min(1,creativity/120)*0.12+Math.min(1,influence/120)*0.08+Math.min(1,ict/40)*0.10+Math.min(1,bpsRate*25)*0.08+Math.min(1,bonusRate/2)*0.08;
  const projected6=Math.max(0,(epNext*HORIZON*0.72)+(ppg*HORIZON*0.22)+(fixtureQuality*HORIZON*0.70)+(teamStrength*HORIZON*0.35)+(form*HORIZON*0.08)+roleAdj);
  const valueRoom=Math.min(1,Math.max(0,1-(numeric(p.now_cost)-40)/100));
  const score=(projected6*0.62+baseGameweek*0.28+valueRoom*0.10)*avail*Math.max(0.35,minsRate);
  return {p,team,score,projected6,minutesRate:minsRate,fixtureAvg:prof.avg,fixtureCount:prof.count,managerIntel:intel};
}

type BeamState={selected:EnrichedPlayer[];budget:number;club:Map<number,number>;score:number};

function optimizeSquad(enriched:EnrichedPlayer[]):{selected:EnrichedPlayer[];budgetRemaining:number;score:number}{
  const grouped=new Map<number,EnrichedPlayer[]>();
  for(const x of enriched){const arr=grouped.get(x.p.element_type)||[];arr.push(x);grouped.set(x.p.element_type,arr);}
  for(const [pos,arr] of grouped) grouped.set(pos,arr.sort((a,b)=>b.score-a.score).slice(0,pos===1?18:pos===2?45:pos===3?55:35));
  let states:BeamState[]=[{selected:[],budget:1000,club:new Map(),score:0}];
  const slots:number[]=[];
  for(const pos of [1,2,3,4])for(let i=0;i<posQuota(pos);i++)slots.push(pos);
  for(const pos of slots){
    const pool=grouped.get(pos)||[]; const next:BeamState[]=[]; const seen=new Set<string>();
    for(const state of states){
      for(const x of pool){
        if(state.selected.some(s=>s.p.id===x.p.id))continue;
        if((state.club.get(x.p.team)||0)>=3)continue;
        const nb=state.budget-x.p.now_cost; if(nb<0)continue;
        const selected=[...state.selected,x];
        const club=new Map(state.club); club.set(x.p.team,(club.get(x.p.team)||0)+1);
        const key=`${selected.map(s=>s.p.id).sort((a,b)=>a-b).join(',')}|${nb}`;
        if(seen.has(key))continue; seen.add(key);
        next.push({selected,budget:nb,club,score:state.score+x.score});
      }
    }
    next.sort((a,b)=>b.score-a.score);
    states=next.slice(0,BEAM_WIDTH);
    if(!states.length)throw new Error(`Unable to satisfy FPL ${positionName(pos)} quota under £100m/club constraints`);
  }
  const best=states[0];
  return {selected:best.selected,budgetRemaining:best.budget,score:best.score};
}

function chooseXI(squad:EnrichedPlayer[]){
  const gk=[...squad].filter(x=>x.p.element_type===1).sort((a,b)=>b.score-a.score);
  const def=[...squad].filter(x=>x.p.element_type===2).sort((a,b)=>b.score-a.score);
  const mid=[...squad].filter(x=>x.p.element_type===3).sort((a,b)=>b.score-a.score);
  const fwd=[...squad].filter(x=>x.p.element_type===4).sort((a,b)=>b.score-a.score);
  const candidates:{xi:EnrichedPlayer[];score:number;shape:string}[]=[];
  for(const d of [3,4,5])for(const m of [5,4,3]){
    const f=11-1-d-m;
    if(f<1||f>3||def.length<d||mid.length<m||fwd.length<f||gk.length<1)continue;
    const xi=[gk[0],...def.slice(0,d),...mid.slice(0,m),...fwd.slice(0,f)];
    candidates.push({xi,score:xi.reduce((s,x)=>s+x.score,0),shape:`${d}-${m}-${f}`});
  }
  const best=candidates.sort((a,b)=>b.score-a.score)[0];
  if(!best)throw new Error('Unable to construct a legal starting XI from the optimized squad');
  const xi=best.xi; const bench=squad.filter(x=>!xi.some(y=>y.p.id===x.p.id)).sort((a,b)=>b.score-a.score);
  const captain=[...xi].sort((a,b)=>b.score-a.score)[0]; const vice=[...xi].filter(x=>x.p.id!==captain.p.id).sort((a,b)=>b.score-a.score)[0];
  if(!captain||!vice)throw new Error('Unable to assign captain and vice-captain');
  return {xi,bench,captain,vice,formation:best.shape};
}

export async function buildFplWeeklyTeam(input:Record<string,unknown>={}):Promise<{success:boolean;data:string;error?:string;source?:string}> {
  try{
    const [data,fixtures]=await Promise.all([fetchJson<FplResponse>(FPL_BOOTSTRAP),fetchJson<FplFixture[]>(FPL_FIXTURES)]);
    const gw=nextGameweek(data); if(!gw)throw new Error('No upcoming FPL Gameweek found');
    const teamMap=new Map(data.teams.map(t=>[t.id,t])); (globalThis as any).__fplTeamMap=teamMap;
    const horizon=buildHorizonFixtures(fixtures,gw.id);
    const viable=data.elements.filter(p=>availability(p)>0.45&&p.now_cost>0);
    const preliminary=viable.map(p=>({p,prof:playerFixtureProfile(p,horizon,gw.id)})).sort((a,b)=>numeric(b.p.ep_next)-numeric(a.p.ep_next)||numeric(b.p.points_per_game)-numeric(a.p.points_per_game));
    const intelCandidates=preliminary.slice(0,120).map(x=>({player:x.p.web_name,club:teamMap.get(x.p.team)?.name||'Unknown'}));
    const managerIntelResult=await analyzeFplManagerIntel(intelCandidates);
    const intelMap=new Map<string,ManagerSignal>();
    for(const i of managerIntelResult.data){const clubId=data.teams.find(t=>t.name===i.club)?.id; if(clubId!==undefined)intelMap.set(`${clubId}:${i.player}`,{roleSecurity:i.roleSecurity,minutesRisk:i.minutesRisk,tacticalUpside:i.tacticalUpside,confidence:i.confidence,sentiment:i.sentiment,freshnessDays:i.freshnessDays,quoteSignals:i.quoteSignals||[],latestEvidence:i.latestEvidence||[]});}
    const enriched=viable.map(p=>scorePlayer(p,horizon,gw.id,intelMap.get(`${p.team}:${p.web_name}`))).filter(x=>x.minutesRate>0.05).sort((a,b)=>b.score-a.score);
    const opt=optimizeSquad(enriched); const plan=chooseXI(opt.selected);
    const currentSquad=typeof input.current_squad==='string'?String(input.current_squad).slice(0,2000):'';
    const fmt=(x:EnrichedPlayer)=>`${x.p.web_name} (${positionName(x.p.element_type)}, ${x.team.short_name||x.team.name}) £${(x.p.now_cost/10).toFixed(1)} | GW score ${x.score.toFixed(2)} | 6GW ${x.projected6.toFixed(2)} | FDR ${x.fixtureAvg.toFixed(2)} | fixtures ${x.fixtureCount}${x.managerIntel?` | role ${x.managerIntel.roleSecurity.toFixed(2)} | mins risk ${x.managerIntel.minutesRisk.toFixed(2)}`:''}`;
    const managerSignals=managerIntelResult.data.filter(i=>i.sentiment!=='neutral'||i.roleSecurity<0.65||i.minutesRisk>0.25||i.tacticalUpside>0.35).sort((a,b)=>b.confidence-a.confidence).slice(0,20);
    const transferGuidance=currentSquad?`Current squad supplied for transfer planning: ${currentSquad}. Compare this squad against the optimized six-Gameweek pool and prioritize high-impact upgrades; do not rebuild blindly if the current squad already satisfies the budget/club/position constraints.`:'No current squad supplied: this is a fresh-squad optimization.';
    const output={
      mode:'FPL_DEDICATED_OPTIMIZER',gameweek:gw.id,deadline:gw.deadline_time ?? 'unknown',budget_remaining:`£${(opt.budgetRemaining/10).toFixed(1)}m`,optimization_score:Number(opt.score.toFixed(3)),horizon_gameweeks:HORIZON,
      squad:opt.selected.map(fmt),starting_xi:plan.xi.map(fmt),formation:plan.formation,bench:plan.bench.map(fmt),captain:fmt(plan.captain),vice_captain:fmt(plan.vice),
      transfer_guidance:transferGuidance,
      top_manager_role_signals:managerSignals.map(i=>({player:i.player,club:i.club,sentiment:i.sentiment,role_security:i.roleSecurity,minutes_risk:i.minutesRisk,tactical_upside:i.tacticalUpside,freshness_days:i.freshnessDays,quote_signals:i.quoteSignals,confidence:i.confidence,evidence:i.latestEvidence||[]})),
      search_strategy:'FPL selection uses official FPL structured data first. Search is reserved for manager/player role, tactical, fitness and breaking-news context. Match referee research is supporting evidence only and never a primary squad-selection driver.',
      rules:{squad_size:15,positions:{GK:2,DEF:5,MID:5,FWD:3},budget:'£100m',club_limit:3,free_transfers:'1 per Gameweek, bankable up to 5',chips:'Wildcard, Free Hit, Bench Boost and Triple Captain twice per season, once in each half'},
      methodology:'Whole-player-pool six-Gameweek optimization using official FPL price/form/availability/fixture data, minutes reliability, underlying performance proxies, value, BPS/bonus signals and freshness-weighted manager role intelligence.'
    };
    return {success:true,data:JSON.stringify(output),source:'fpl_weekly_team'};
  }catch(e){return{success:false,data:'',error:e instanceof Error?e.message:String(e),source:'fpl_weekly_team'};}
}
