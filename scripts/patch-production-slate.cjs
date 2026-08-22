const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.cwd());
const orchestrator = path.join(root, 'server/agent/orchestrator.ts');
const scheduler = path.join(root, 'server/agent/fixture-task-scheduler.ts');
const tools = path.join(root, 'server/agent/tools.ts');
const settlement = path.join(root, 'server/agent/settlement.ts');

function patch(file, transform, label) {
  const source = fs.readFileSync(file, 'utf8');
  const next = transform(source);
  if (next === source) {
    console.log(`[production-patch] ${label}: already applied`);
    return;
  }
  fs.writeFileSync(file, next, 'utf8');
  console.log(`[production-patch] ${label}: applied`);
}

patch(orchestrator, source => {
  let next = source;
  next = next.replace(
    /const MAX_DISCOVERY_FIXTURES=Math\.max\(1,Number\(process\.env\.MAX_DISCOVERY_FIXTURES\|\|\d+\)\);/,
    "const MAX_DISCOVERY_FIXTURES=Math.max(1,Number(process.env.MAX_DISCOVERY_FIXTURES||200));"
  );
  next = next.replace(
    /const MAX_FIXTURE_PIPELINES=Math\.max\(1,Number\(process\.env\.MAX_FIXTURE_PIPELINES\|\|\d+\)\);/,
    "const MAX_FIXTURE_PIPELINES=Math.max(1,Math.min(100,Number(process.env.MAX_FIXTURE_PIPELINES||100)));"
  );
  const old = /function dedupeFixtures\(values:DiscoveredFixture\[\],requestedDate:string\)\{[^}]*?return out;\}/;
  if (old.test(next)) {
    next = next.replace(old, `function dedupeFixtures(values:DiscoveredFixture[],requestedDate:string){
  const seen=new Set<string>();
  const grouped=new Map<string,DiscoveredFixture[]>();
  for(const v of values){
    if(!v.fixture||!looksLikeRealFixture(v.fixture)||isCompletedStatus(v.status))continue;
    if(v.kickoff){const d=new Date(v.kickoff);if(Number.isNaN(d.getTime()))continue;if(d.getTime()<Date.now()-120000)continue;if(fixtureMatchDate(v.kickoff,requestedDate)!==requestedDate)continue;}
    const key=normalizeFixtureName(v.fixture); if(seen.has(key))continue;
    const league=normalizeLeague(v.competition); const bucket=grouped.get(league)||[]; bucket.push(v); grouped.set(league,bucket); seen.add(key);
  }
  const out:DiscoveredFixture[]=[];
  const buckets=[...grouped.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  let cursor=0;
  while(out.length<MAX_DISCOVERY_FIXTURES && buckets.some(([,items])=>items.length)){for(const [,items] of buckets){if(out.length>=MAX_DISCOVERY_FIXTURES)break;const item=items.shift();if(item)out.push(item);}cursor++;if(cursor>MAX_DISCOVERY_FIXTURES)break;}
  return out;
}`);
  }
  return next;
}, 'global fixture discovery / 100-pipeline cap / league balancing');

patch(scheduler, source => source.replace(
  /const MAX_QUEUE_DEPTH = Math\.max\(2, Number\(process\.env\.AGENT_MAX_QUEUE_DEPTH \|\| \d+\)\);/,
  "const MAX_QUEUE_DEPTH = Math.max(100, Number(process.env.AGENT_MAX_QUEUE_DEPTH || 150));"
), 'scheduler queue depth for 100-fixture slate');

patch(tools, source => {
  if (source.includes('export async function allSportsFinalScores')) return source;
  return `${source}\n\nexport async function allSportsFinalScores(dateFrom: string, dateTo = dateFrom): Promise<ToolResult> {\n  const pool = keyPool('ALL_SPORTS_APIs');\n  if (!pool.length) return { success:false, data:'', error:'No ALL_SPORTS_APIs keys configured', source:'allsports_final_scores' };\n  for (let i=0;i<pool.length;i++) {\n    const key=pool[allSportsIdx++%pool.length];\n    try {\n      const p=new URLSearchParams({met:'Fixtures',APIkey:key,from:dateFrom,to:dateTo});\n      const r=await fetchWithTimeout(\`${ALLSPORTS_URL}?\${p}\`,{headers:{Accept:'application/json'}},SEARCH_TIMEOUT);\n      if(!r.ok) continue;\n      const j=await r.json() as any;\n      if(!j.success || !Array.isArray(j.result)) continue;\n      const lines=j.result.map((e:any)=>{\n        const hs=e.event_home_team_score ?? e.event_home_final_score ?? e.event_home_team_ft_score;\n        const as=e.event_away_team_score ?? e.event_away_final_score ?? e.event_away_team_ft_score;\n        return [e.event_date,e.event_time||'',e.event_home_team,e.event_away_team,hs ?? '',as ?? '',e.event_status||'',e.event_league_name||e.league_name||''].join(' | ');\n      });\n      return {success:true,data:truncate(lines.join('\\n'),12000),source:'allsports_final_scores'};\n    } catch {}\n  }\n  return {success:false,data:'',error:'All AllSports final-score requests failed',source:'allsports_final_scores'};\n}\n`;
}, 'finished-score AllSports feed');

patch(settlement, source => {
  let next = source;
  next = next.replace("import { allSportsLivescore } from './tools.js';", "import { allSportsLivescore, allSportsFinalScores, serpSearch } from './tools.js';");
  next = next.replace("const score = await fetchScore(pick.fixture);", "const score = await fetchScore(pick.fixture, pick.event_date);");
  next = next.replace(/async function fetchScore\(fixture: string\): Promise<ScoreResult> \{[\s\S]*?\n\}\n\ninterface SettlementResult/, `async function fetchScore(fixture: string, eventDate: Date | null): Promise<ScoreResult> {
  const home = fixture.split(/\\s+(?:vs\\.?|v\\.?)\\s+/i)[0]?.trim() || '';
  const away = fixture.split(/\\s+(?:vs\\.?|v\\.?)\\s+/i)[1]?.trim() || '';
  const targetDate = eventDate ? new Date(eventDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
  const norm = (s:string) => s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const homeNorm = norm(home), awayNorm = norm(away);

  const structured = await allSportsFinalScores(targetDate, targetDate);
  if (structured.success && structured.data) {
    for (const line of structured.data.split('\\n')) {
      const parts=line.split(' | ').map(x=>x.trim());
      const lh=norm(parts[2]||''), la=norm(parts[3]||'');
      const hs=Number(parts[4]), as=Number(parts[5]);
      if (!Number.isNaN(hs) && !Number.isNaN(as) && ((lh===homeNorm && la===awayNorm) || (lh.includes(homeNorm) && la.includes(awayNorm)))) {
        return {homeScore:hs,awayScore:as,status:parts[6]||'FT',found:true};
      }
    }
  }

  const searchQueries = [
    `"${home}" "${away}" ${targetDate} final score`,
    `${home} vs ${away} ${targetDate} result`,
  ];
  for (const q of searchQueries) {
    const result = await serpSearch(q);
    if (!result.success || !result.data) continue;
    const text = result.data;
    const scorePatterns = [
      new RegExp(`${home.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}\\s+(\\d+)\\s*[-:]\\s*(\\d+)\\s+${away.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&')}`, 'i'),
      /(\\d+)\\s*[-:]\\s*(\\d+)/,
    ];
    for (const pattern of scorePatterns) {
      const match=text.match(pattern); if(match){return {homeScore:Number(match[1]),awayScore:Number(match[2]),status:'FT',found:true};}
    }
  }

  const live = await allSportsLivescore();
  if (live.success && live.data) {
    for (const line of live.data.split('\\n')) {
      const lower=line.toLowerCase();
      if ((lower.includes(homeNorm) || lower.includes(home.toLowerCase())) && (lower.includes(awayNorm) || lower.includes(away.toLowerCase()))) {
        const m=line.match(/(\\d+)\\s*[-:]\\s*(\\d+)/); if(m)return {homeScore:Number(m[1]),awayScore:Number(m[2]),status:'FT',found:true};
      }
    }
  }
  return {homeScore:-1,awayScore:-1,status:'',found:false};
}

interface SettlementResult`);
  next = next.replace("cron.schedule('*/30 * * * *', async () => {", "setTimeout(() => { void runSettlementPass().catch(err => console.error('[Settlement] Startup pass error:', err instanceof Error ? err.message : String(err))); }, 60_000);\n\n  cron.schedule('*/30 * * * *', async () => {");
  next = next.replace("LIMIT 50", "LIMIT 500");
  next = next.replace("console.log('[Settlement] Cron job scheduled (every 30 min)');", "console.log('[Settlement] Cron job scheduled (every 30 min) | startup pass in 60s');");
  return next;
}, 'final-score settlement with startup pass and larger batch');
