const fs = require('node:fs');
const path = require('node:path');

const file = path.resolve('server/agent/orchestrator.ts');
let source = fs.readFileSync(file, 'utf8');

source = source
  .replace(
    /const MAX_DISCOVERY_FIXTURES=Math\.max\(1,Number\(process\.env\.MAX_DISCOVERY_FIXTURES\|\|20\)\);/,
    "const MAX_DISCOVERY_FIXTURES=Math.max(1,Number(process.env.MAX_DISCOVERY_FIXTURES||60));"
  )
  .replace(
    /const MAX_FIXTURE_PIPELINES=Math\.max\(1,Number\(process\.env\.MAX_FIXTURE_PIPELINES\|\|3\)\);/,
    "const MAX_FIXTURE_PIPELINES=Math.max(1,Number(process.env.MAX_FIXTURE_PIPELINES||24));"
  );

const oldFn = /function dedupeFixtures\(values:DiscoveredFixture\[\],requestedDate:string\)\{.*?\}\n\nasync function discoverFixtures/s;
const newFn = `function dedupeFixtures(values:DiscoveredFixture[],requestedDate:string){
  const seen=new Set<string>(), candidates:DiscoveredFixture[]=[];
  for(const v of values){
    if(!v.fixture||!looksLikeRealFixture(v.fixture)||isCompletedStatus(v.status))continue;
    if(v.kickoff){
      const d=new Date(v.kickoff);
      if(Number.isNaN(d.getTime()))continue;
      if(d.getTime()<Date.now()-120000)continue;
      if(fixtureMatchDate(v.kickoff,requestedDate)!==requestedDate)continue;
    }
    const key=normalizeFixtureName(v.fixture);
    if(seen.has(key))continue;
    seen.add(key);
    candidates.push(v);
  }
  const byCompetition=new Map<string,DiscoveredFixture[]>();
  for(const fixture of candidates){
    const key=normalizeLeague(fixture.competition)||'UNVERIFIED LEAGUE';
    const bucket=byCompetition.get(key)??[];
    bucket.push(fixture);
    byCompetition.set(key,bucket);
  }
  const groups=[...byCompetition.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const out:DiscoveredFixture[]=[];
  let cursor=0;
  const maxPerLeague=Math.max(2,Math.floor(MAX_FIXTURE_PIPELINES/Math.max(1,groups.length)));
  while(out.length<MAX_DISCOVERY_FIXTURES && groups.some(([,items])=>items.length)){
    let added=false;
    for(const [,items] of groups){
      if(!items.length)continue;
      if(items.length>maxPerLeague && out.filter(x=>(normalizeLeague(x.competition)||'UNVERIFIED LEAGUE')===normalizeLeague(items[0].competition)).length>=maxPerLeague){continue;}
      out.push(items.shift());
      added=true;
      if(out.length>=MAX_DISCOVERY_FIXTURES)break;
    }
    if(!added){
      const fallback=groups[cursor%Math.max(1,groups.length)]?.[1].shift();
      if(fallback)out.push(fallback);else break;
    }
    cursor++;
  }
  return out.slice(0,MAX_DISCOVERY_FIXTURES);
}

async function discoverFixtures`;

if (!oldFn.test(source)) {
  throw new Error('[global-slate] could not locate dedupeFixtures function');
}
source = source.replace(oldFn, newFn);
fs.writeFileSync(file, source, 'utf8');
console.log('[global-slate] enabled multi-league fixture discovery: 60 discovered / 24 analyzed by default');
