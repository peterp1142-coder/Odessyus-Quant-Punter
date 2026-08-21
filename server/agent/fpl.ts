import fs from 'node:fs';

const FPL_BOOTSTRAP = 'https://fantasy.premierleague.com/api/bootstrap-static/';
const FPL_FIXTURES = 'https://fantasy.premierleague.com/api/fixtures/';
const HTTP_TIMEOUT = 12000;

interface FplPlayer { id:number; first_name:string; second_name:string; web_name:string; team:number; element_type:number; now_cost:number; status:string; chance_of_playing_next_round:number|null; form:string; points_per_game:string; ep_next:string; value_form:string; value_season:string; minutes:number; goals_scored:number; assists:number; clean_sheets:number; bonus:number; bps:number; influence:string; creativity:string; threat:string; ict_index:string; selected_by_percent:string; transfers_in_event:number; transfers_out_event:number; total_points:number; }
interface FplTeam { id:number; name:string; short_name:string; code:number; strength:number; strength_overall_home:number; strength_overall_away:number; }
interface FplFixture { event:number|null; team_h:number; team_a:number; team_h_difficulty:number; team_a_difficulty:number; finished:boolean; kickoff_time:string|null; }
interface FplResponse { elements:FplPlayer[]; teams:FplTeam[]; events:Array<{id:number;name:string;deadline_time:string|null;finished:boolean;is_current:boolean;is_next:boolean}>; }

async function fetchJson<T>(url:string):Promise<T>{
  const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),HTTP_TIMEOUT);
  try { const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Odessyus-FPL/1.0'},signal:controller.signal}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json() as T; }
  finally { clearTimeout(timer); }
}

function envKeys(name:string):string[]{ return (process.env[name]||'').split(',').map(x=>x.trim()).filter(Boolean); }
let searchIndex=0;
async function searchWeb(query:string):Promise<string>{
  const keys=envKeys('SERP_APIs');
  for(let i=0;i<keys.length;i++){
    try{
      const key=keys[searchIndex++%keys.length];
      const r=await fetch(`https://google.serper.dev/search`,{method:'POST',headers:{'X-API-KEY':key,'Content-Type':'application/json'},body:JSON.stringify({q:query,num:6})});
      if(!r.ok) continue;
      const j=await r.json() as any;
      const rows=(j.organic||[]).slice(0,6).map((x:any)=>[x.title,x.snippet,x.link].filter(Boolean).join('\n'));
      if(rows.length) return rows.join('\n---\n');
    }catch{}
  }
  try{
    const r=await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,{headers:{'User-Agent':'Odessyus-FPL/1.0'}});
    const text=await r.text();
    return text.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,6000);
  }catch{return '';}
}

function nextGameweek(data:FplResponse){
  return data.events.find(e=>e.is_next) || data.events.find(e=>!e.finished && e.deadline_time && new Date(e.deadline_time).getTime()>Date.now()) || data.events[data.events.length-1];
}

function availability(p:FplPlayer){
  if(p.status==='u'||p.status==='s') return 0;
  if(typeof p.chance_of_playing_next_round==='number') return Math.max(0,Math.min(1,p.chance_of_playing_next_round/100));
  return p.status==='a'?1:0.65;
}

function numeric(v:string|number|undefined){ const n=Number(v); return Number.isFinite(n)?n:0; }

function candidateScore(p:FplPlayer,fixtureDifficulty:number,fixturesThisGw:number){
  const minutesRate=Math.min(1,Math.max(0,p.minutes/((fixturesThisGw||1)*90)));
  const avail=availability(p);
  const ep=Math.max(0,numeric(p.ep_next));
  const form=Math.max(0,numeric(p.form));
  const value=Math.max(0,numeric(p.value_form));
  const bps=Math.max(0,p.bps/1000);
  const fixtureBoost=1+Math.max(-0.18,Math.min(0.18,(5-fixtureDifficulty)*0.045))+Math.max(0,fixturesThisGw-1)*0.12;
  const momentum=(p.transfers_in_event-p.transfers_out_event)/100000;
  return (ep*0.50 + form*0.16 + value*0.10 + bps*0.08 + minutesRate*0.10 + Math.max(0,Math.min(0.06,momentum)))*fixtureBoost*avail;
}

function buildFixtureMap(fixtures:FplFixture[],gw:number){
  const map=new Map<number,{difficulty:number;count:number}>();
  for(const f of fixtures.filter(x=>x.event===gw&&!x.finished)){
    map.set(f.team_h,{difficulty:Math.min(map.get(f.team_h)?.difficulty??6,f.team_h_difficulty),count:(map.get(f.team_h)?.count??0)+1});
    map.set(f.team_a,{difficulty:Math.min(map.get(f.team_a)?.difficulty??6,f.team_a_difficulty),count:(map.get(f.team_a)?.count??0)+1});
  }
  return map;
}

function optimizeSquad(players:FplPlayer[],teams:FplTeam[],fixtures:FplFixture[],gw:number){
  const fmap=buildFixtureMap(fixtures,gw); const teamMap=new Map(teams.map(t=>[t.id,t]));
  const enriched=players.filter(p=>p.status!=='u'&&availability(p)>0.55).map(p=>({p,score:candidateScore(p,fmap.get(p.team)?.difficulty??3,fmap.get(p.team)?.count??1),difficulty:fmap.get(p.team)?.difficulty??3,fixtures:fmap.get(p.team)?.count??0}));
  const byPos=(pos:number)=>enriched.filter(x=>x.p.element_type===pos).sort((a,b)=>b.score-a.score);
  const selected:FplPlayer[]=[]; const clubCount=new Map<number,number>(); let budget=1000;
  const add=(x:{p:FplPlayer})=>{if(selected.length>=15)return false;const c=clubCount.get(x.p.team)||0;if(c>=3||x.p.now_cost>budget)return false;selected.push(x.p);clubCount.set(x.p.team,c+1);budget-=x.p.now_cost;return true;};
  for(const pos of [1,2,3,4]){
    const quota=pos===1?2:pos===2?5:pos===3?5:3;
    const pool=byPos(pos);
    for(const x of [...pool].sort((a,b)=>a.p.now_cost-b.p.now_cost).slice(0,quota)) add(x);
    for(const x of pool) if(selected.filter(p=>p.element_type===pos).length<quota) add(x);
  }
  // Budget-aware upgrade passes: swap one selected player for a higher score alternative when constraints permit.
  for(let pass=0;pass<8;pass++){
    let changed=false;
    for(let i=0;i<selected.length;i++){
      const current=selected[i]; const curEn=enriched.find(x=>x.p.id===current.id); if(!curEn)continue;
      const alternatives=enriched.filter(x=>x.p.element_type===current.element_type&&x.p.id!==current.id&&x.score>curEn.score).sort((a,b)=>b.score-a.score).slice(0,30);
      for(const alt of alternatives){
        const projected=budget+current.now_cost-alt.p.now_cost; const oldClub=clubCount.get(current.team)||0; const newClub=clubCount.get(alt.p.team)||0;
        if(projected<0||newClub>=3||(alt.p.team===current.team?false:newClub>=3))continue;
        clubCount.set(current.team,Math.max(0,oldClub-1)); clubCount.set(alt.p.team,newClub+1); selected[i]=alt.p; budget=projected; changed=true; break;
      }
    }
    if(!changed)break;
  }
  const scored=selected.map(p=>{const e=enriched.find(x=>x.p.id===p.id)!;return{player:p,score:e.score,difficulty:e.difficulty,fixtures:e.fixtures,team:teamMap.get(p.team)?.name||'Unknown'};});
  return {selected:scored,budgetRemaining:budget};
}

function chooseXI(squad:Array<ReturnType<typeof optimizeSquad>['selected'][number]>){
  const ranked=[...squad].sort((a,b)=>b.score-a.score); const gks=ranked.filter(x=>x.player.element_type===1); const defs=ranked.filter(x=>x.player.element_type===2); const mids=ranked.filter(x=>x.player.element_type===3); const fwds=ranked.filter(x=>x.player.element_type===4);
  const xi=[gks[0],fwds[0]]; const remaining=[...defs,...mids].sort((a,b)=>b.score-a.score);
  xi.push(...remaining.slice(0,9));
  // Ensure at least three defenders; replace weakest mid if necessary.
  const defCount=xi.filter(x=>x.player.element_type===2).length;
  if(defCount<3){const needed=3-defCount;const extras=defs.slice(defCount,defCount+needed);for(const ex of extras){const replace=xi.filter(x=>x.player.element_type===3).sort((a,b)=>a.score-b.score)[0];if(replace){const idx=xi.indexOf(replace);xi[idx]=ex;}}}
  const captain=[...xi].sort((a,b)=>b.score-a.score)[0]; const vice=[...xi].filter(x=>x.player.id!==captain.player.id).sort((a,b)=>b.score-a.score)[0];
  return {xi,bench:ranked.filter(x=>!xi.some(y=>y.player.id===x.player.id)).sort((a,b)=>b.score-a.score).slice(0,4),captain,vice};
}

export async function buildFplWeeklyTeam(input:Record<string,unknown>={}):Promise<{success:boolean;data:string;error?:string;source?:string}> {
  try{
    const [data,fixtures]=await Promise.all([fetchJson<FplResponse>(FPL_BOOTSTRAP),fetchJson<FplFixture[]>(FPL_FIXTURES)]);
    const gw=nextGameweek(data); if(!gw) throw new Error('No upcoming FPL Gameweek found');
    const opt=optimizeSquad(data.elements,data.teams,fixtures,gw.id); const plan=chooseXI(opt.selected);
    const names=(ids:number[])=>ids.map(id=>data.elements.find(p=>p.id===id)?.web_name||String(id));
    const topCandidates=opt.selected.sort((a,b)=>b.score-a.score).slice(0,8).map(x=>x.player.web_name);
    const news=topCandidates.length?await searchWeb(`FPL Gameweek ${gw.id} ${topCandidates.join(' ')} injury lineup team news 2026/27`):'';
    const transferNote=typeof input.current_squad==='string'?`Current squad supplied: ${String(input.current_squad).slice(0,1500)}`:'No current squad supplied; returning a recommended squad rather than forced transfers.';
    const fmt=(x:any)=>`${x.player.web_name} (${x.team}) £${(x.player.now_cost/10).toFixed(1)} | model ${x.score.toFixed(2)} | FDR ${x.difficulty} | ${x.fixtures} fixture${x.fixtures===1?'':'s'}`;
    const out={
      gameweek:gw.id,deadline:gw.deadline_time,budget:`£${(opt.budgetRemaining/10).toFixed(1)}m remaining`,
      squad:opt.selected.map(fmt),starting_xi:plan.xi.map(fmt),bench:plan.bench.map(fmt),captain:fmt(plan.captain),vice_captain:fmt(plan.vice),
      transfer_guidance:transferNote,
      chip_guidance:'Default to saving chips in ordinary single-fixture Gameweeks; assess Wildcard/Free Hit/Bench Boost/Triple Captain around genuine Blank or Double Gameweeks. Only one chip can be used per Gameweek.',
      methodology:'Official FPL prices/projected points/form/availability + fixture difficulty + minutes reliability + value/BPS signals, with search-based team-news sanity checking. No player is treated as confirmed starting unless official/current evidence supports it.',
      fpl_rules_2026_27:{squad:'15 players: 2 GK, 5 DEF, 5 MID, 3 FWD',budget:'£100m',club_limit:3,free_transfers:'1 per Gameweek, bankable up to 5',chips:'Wildcard, Free Hit, Bench Boost and Triple Captain twice per season, once in each half',captain:'doubles score',defensive_contributions:'2 points at 10 CBIT for defenders; 12 defensive contributions for midfielders/forwards'},
      search_news_context:news.slice(0,7000)
    };
    return {success:true,data:JSON.stringify(out),source:'fpl_weekly_team'};
  }catch(e){return{success:false,data:'',error:e instanceof Error?e.message:String(e),source:'fpl_weekly_team'};}
}
