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
  while(out.length<MAX_DISCOVERY_FIXTURES && buckets.some(([,items])=>items.length)){
    for(const [,items] of buckets){if(out.length>=MAX_DISCOVERY_FIXTURES)break;const item=items.shift();if(item)out.push(item);}
    cursor++;if(cursor>MAX_DISCOVERY_FIXTURES)break;
  }
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
  return `${source}\n\nexport async function allSportsFinalScores(dateFrom: string, dateTo = dateFrom): Promise<ToolResult> {
  const pool = keyPool('ALL_SPORTS_APIs');
  if (!pool.length) return { success:false, data:'', error:'No ALL_SPORTS_APIs keys configured', source:'allsports_final_scores' };
  for (let i=0;i<pool.length;i++) {
    const key=pool[allSportsIdx++%pool.length];
    try {
      const p=new URLSearchParams({met:'Fixtures',APIkey:key,from:dateFrom,to:dateTo});
      const r=await fetchWithTimeout(`${ALLSPORTS_URL}?${p}`,{headers:{Accept:'application/json'}},SEARCH_TIMEOUT);
      if(!r.ok) continue;
      const j=await r.json() as any;
      if(!j.success || !Array.isArray(j.result)) continue;
      const lines=j.result.map((e:any)=>{
        const hs=e.event_home_final_score ?? e.event_home_team_score ?? e.event_home_team_ft_score;
        const as=e.event_away_final_score ?? e.event_away_team_score ?? e.event_away_team_ft_score;
        return [e.event_date,e.event_time||'',e.event_home_team,e.event_away_team,hs ?? '',as ?? '',e.event_status||'',e.event_league_name||e.league_name||''].join(' | ');
      });
      return {success:true,data:truncate(lines.join('\\n'),12000),source:'allsports_final_scores'};
    } catch {}
  }
  return {success:false,data:'',error:'All AllSports final-score requests failed',source:'allsports_final_scores'};
}
`;
}, 'finished-score AllSports feed');

patch(settlement, source => {
  let next = source;
  next = next.replace("import { allSportsLivescore } from './tools.js';", "import { allSportsLivescore, allSportsFinalScores, serpSearch } from './tools.js';");
  next = next.replace(
    /interface PendingPick \{[\s\S]*?created_at: Date;\n\}/,
    `interface PendingPick {
  id: string;
  fixture: string;
  prediction_market: string;
  prediction_selection: string | null;
  event_date: Date | null;
  recommended_odds: number | null;
  created_at: Date;
}`
  );
  next = next.replace(
    /SELECT id, fixture, prediction_market, event_date, recommended_odds, created_at/,
    'SELECT id, fixture, prediction_market, prediction_selection, event_date, recommended_odds, created_at'
  );
  next = next.replace("const score = await fetchScore(pick.fixture);", "const score = await fetchScore(pick.fixture, pick.event_date);");
  next = next.replace(
    /const settlement = settleMarket\(pick\.prediction_market, score\.homeScore, score\.awayScore\);/,
    "const settlement = settleMarket(pick.prediction_market, pick.prediction_selection, score.homeScore, score.awayScore);"
  );
  next = next.replace(
    /async function fetchScore\(fixture: string\): Promise<ScoreResult> \{[\s\S]*?\n\}\n\ninterface SettlementResult/,
    `async function fetchScore(fixture: string, eventDate: Date | null): Promise<ScoreResult> {
  const [home, away] = fixture.split(/\\s+(?:vs\\.?|v\\.?)\\s+/i).map(s => s?.trim() || '');
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

  for (const q of [
    `"${home}" "${away}" ${targetDate} final score`,
    `${home} vs ${away} ${targetDate} result`,
  ]) {
    const result = await serpSearch(q);
    if (!result.success || !result.data) continue;
    const match = result.data.match(/(?:^|\\b)(\\d+)\\s*[-:]\\s*(\\d+)(?:\\b|$)/);
    if (match) return {homeScore:Number(match[1]),awayScore:Number(match[2]),status:'FT',found:true};
  }

  const live = await allSportsLivescore();
  if (live.success && live.data) {
    for (const line of live.data.split('\\n')) {
      const lower=norm(line);
      if ((lower.includes(homeNorm) || lower.includes(norm(home))) && (lower.includes(awayNorm) || lower.includes(norm(away)))) {
        const m=line.match(/(\\d+)\\s*[-:]\\s*(\\d+)/);
        if(m)return {homeScore:Number(m[1]),awayScore:Number(m[2]),status:'FT',found:true};
      }
    }
  }
  return {homeScore:-1,awayScore:-1,status:'',found:false};
}

interface SettlementResult`
  );
  next = next.replace("function settleMarket(market: string, home: number, away: number): SettlementResult {", "function settleMarket(market: string, selection: string | null, home: number, away: number): SettlementResult {");
  next = next.replace("  const m = market.toLowerCase();", "  const m = market.toLowerCase();\n  const s = String(selection || '').toLowerCase().trim();\n  if (!s) return { outcome: 'manual_review', actualOutcome: 'missing_selection', voidReason: `Missing selection for market: ${market}`, roi: 0 };");
  next = next.replace(
    "  if (m.includes('home win') || (m.includes('match result') && m.includes('home')) || m === '1x2') {",
    "  if (m.includes('home win') || (m.includes('match result') && s.includes('home'))) {"
  );
  next = next.replace(
    "  if (m.includes('away win') || (m.includes('match result') && m.includes('away'))) {",
    "  if (m.includes('away win') || (m.includes('match result') && s.includes('away'))) {"
  );
  next = next.replace("  if (m.includes('draw')) {", "  if (m.includes('draw') && (s === 'draw' || s.includes('draw'))) {");
  next = next.replace("  if (m.includes('dnb') && m.includes('home')) {", "  if (m.includes('dnb') && (m.includes('home') || s.includes('home'))) {");
  next = next.replace("  if (m.includes('dnb') && m.includes('away')) {", "  if (m.includes('dnb') && (m.includes('away') || s.includes('away'))) {");
  next = next.replace("  if (m.includes('btts') || m.includes('both teams')) {", "  if (m.includes('btts') || m.includes('both teams')) {");
  next = next.replace("    if (m.includes('yes') && bttsYes)", "    if ((s.includes('yes') || m.includes('yes')) && bttsYes)");
  next = next.replace("    if (m.includes('no') && bttsNo)", "    if ((s.includes('no') || m.includes('no')) && bttsNo)");
  next = next.replace("  if (m.includes('over 2.5') || m.includes('over2.5') || (m.includes('over') && m.includes('2.5'))) {", "  if (m.includes('over 2.5') || m.includes('over2.5') || (m.includes('over') && m.includes('2.5')) || s.includes('over 2.5')) {");
  next = next.replace("  if (m.includes('under 2.5') || m.includes('under2.5') || (m.includes('under') && m.includes('2.5'))) {", "  if (m.includes('under 2.5') || m.includes('under2.5') || (m.includes('under') && m.includes('2.5')) || s.includes('under 2.5')) {");
  next = next.replace("  if (m.includes('over 3.5') || m.includes('over3.5')) {", "  if (m.includes('over 3.5') || m.includes('over3.5') || s.includes('over 3.5')) {");
  next = next.replace("  if (m.includes('under 3.5') || m.includes('under3.5')) {", "  if (m.includes('under 3.5') || m.includes('under3.5') || s.includes('under 3.5')) {");
  next = next.replace("  if (m.includes('asian') || m.includes(' ah ') || m.includes('ah ')) {\n    return settleAsianHandicap(market, home, away);\n  }", "  if (m.includes('asian') || m.includes(' ah ') || m.includes('ah ') || s.includes(' +') || s.includes(' -')) {\n    return settleAsianHandicap(`${market} ${selection || ''}`, home, away);\n  }");
  next = next.replace("  if (m.includes('double chance') || m.includes('1x') || m.includes('x2') || m.includes('12')) {", "  if (m.includes('double chance') || m.includes('1x') || m.includes('x2') || m.includes('12') || s === '1x' || s === 'x2' || s === '12') {");
  next = next.replace("if (m.includes('1x') || (m.includes('home') && m.includes('draw'))) {", "if (m.includes('1x') || s === '1x' || (m.includes('home') && m.includes('draw'))) {");
  next = next.replace("if (m.includes('x2') || (m.includes('away') && m.includes('draw'))) {", "if (m.includes('x2') || s === 'x2' || (m.includes('away') && m.includes('draw'))) {");
  next = next.replace("if (m.includes('12') || m.includes('home or away')) {", "if (m.includes('12') || s === '12' || m.includes('home or away')) {");
  return next;
}, 'exact market + selection settlement, no implicit 1X2 fallback');
