import fs from 'node:fs';
import path from 'node:path';

const toolsTarget = path.resolve('dist-server/agent/tools.js');
const orchestratorTarget = path.resolve('dist-server/agent/orchestrator.js');
for (const target of [toolsTarget, orchestratorTarget]) {
  if (!fs.existsSync(target)) throw new Error(`Compiled target not found: ${target}`);
}

function replaceOnce(source, label, pattern, replacement) {
  if (!pattern.test(source)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(pattern, replacement);
}

const searchOnly = "process.env.SEARCH_ONLY_MODE === 'true'";

let tools = fs.readFileSync(toolsTarget, 'utf8');
tools = replaceOnce(
  tools,
  'getBrowser guard',
  /async function getBrowser\(\)\{/,
  `async function getBrowser(){if(${searchOnly})throw new Error('Browser disabled by SEARCH_ONLY_MODE');`
);
tools = replaceOnce(
  tools,
  'scrape guard',
  /export async function scrape\(url,selector,waitTime=7000\)\{/,
  `export async function scrape(url,selector,waitTime=7000){if(${searchOnly})return{success:false,data:'',error:'scrape disabled by SEARCH_ONLY_MODE',blocked:true,source:'scrape:search-only'};`
);

// fetch_matches_today is intentionally native-fetch based in SEARCH_ONLY_MODE:
// search APIs discover candidate source URLs, then Node fetchUrl retrieves page text.
tools = replaceOnce(
  tools,
  'fetchMatchesToday implementation',
  /export async function fetchMatchesToday\(sport='football',dateStr\?\)\{[\s\S]*?\nexport async function multiSourceOdds/,
  `export async function fetchMatchesToday(sport='football',dateStr?:string){
  const today=dateStr||new Date().toISOString().slice(0,10);
  const queries=[\`\${sport} fixtures \${today} schedule results\`,\`\${sport} matches today \${today} kickoff fixtures\`];
  const searchResults=await Promise.allSettled(queries.map(q=>serpSearch(q)));
  const sources:string[]=[];
  for(const r of searchResults){if(r.status==='fulfilled'&&r.value.success&&r.value.data)sources.push(r.value.data);}
  if(!sources.length)return{success:false,data:'',error:'Search APIs returned no fixture sources',source:'fetch_matches_today:search'};
  const urlPattern=/https?:\\/\\/[^\\s<>\"'\\)\\]]+/g;
  const urls:string[]=[];
  for(const source of sources){for(const rawUrl of source.match(urlPattern)||[]){const url=rawUrl.replace(/[.,;]+$/,'');if(!urls.includes(url))urls.push(url);if(urls.length>=12)break;}if(urls.length>=12)break;}
  const pageResults=await Promise.allSettled(urls.map(url=>fetchUrl(url)));
  const pages:string[]=[];
  for(let i=0;i<pageResults.length;i++){const r=pageResults[i];if(r.status==='fulfilled'&&r.value.success&&!r.value.blocked)pages.push(\`=== SOURCE \${urls[i]} ===\\n\${r.value.data.slice(0,5000)}\`);}
  const combined=[...sources.map((s,i)=>\`=== SEARCH \${i+1} ===\\n\${s.slice(0,5000)}\`),...pages].join('\\n\\n').slice(0,24000);
  return combined?{success:true,data:\`[Date: \${today}] [Sport: \${sport}]\\n\${combined}\`,source:'fetch_matches_today:search+fetch_url'}:{success:false,data:'',error:'Discovered fixture URLs could not be fetched',source:'fetch_matches_today:search+fetch_url'};
}

export async function multiSourceOdds`
);

const blockedTools = ['scrape','book_slip','scrape_flashscore','multi_source_odds','fetch_fbref_stats','fetch_understat_xg','fetch_lineups'];
const names = blockedTools.map(name => `'${name}'`).join(',');
tools = replaceOnce(
  tools,
  'dispatch guard',
  /export async function dispatchTool\(toolName,input\)\{\n\s*console\.log\(/,
  `export async function dispatchTool(toolName,input){if(${searchOnly}&&[${names}].includes(toolName))return{success:false,data:'',error:\`Tool disabled in SEARCH_ONLY_MODE: \${toolName}\`,blocked:true,source:'search-only'};\nconsole.log(`
);

tools = replaceOnce(
  tools,
  'FPL dispatch case',
  /case 'calculate_kelly':return calculateKelly\(Number\(input\.true_probability\|\|input\.prob\|\|0\),Number\(input\.decimal_odds\|\|input\.odds\|\|0\),Number\(input\.bankroll\|\|1000\)\);/,
  `case 'calculate_kelly':return calculateKelly(Number(input.true_probability||input.prob||0),Number(input.decimal_odds||input.odds||0),Number(input.bankroll||1000));
    case 'fpl_weekly_team':{const {buildFplWeeklyTeam}=await import('./fpl.js');return buildFplWeeklyTeam(input);}`
);
fs.writeFileSync(toolsTarget, tools, 'utf8');

let orchestrator = fs.readFileSync(orchestratorTarget, 'utf8');
const fplRoute = `
  const fplRequest = /\\b(?:fpl|fantasy premier league|fpl team|fpl squad|gameweek team|fantasy team|fpl transfers?|wildcard|free hit|bench boost|triple captain)\\b/i;
  if (fplRequest.test(userQuery)) {
    emit({ type: 'status', content: '⚽ FPL mode: running dedicated player-level squad optimizer before any fixture analysis.' });
    try {
      const { buildFplWeeklyTeam } = await import('./fpl.js');
      const fplResult = await buildFplWeeklyTeam({});
      if (!fplResult.success) {
        return { finalAnswer: \`FPL optimizer failed: \${fplResult.error || 'unknown error'}\`, steps, success: false, error: fplResult.error, metadata: { mode: 'FPL_DEDICATED_OPTIMIZER' } };
      }
      let payload = {};
      try { payload = JSON.parse(fplResult.data); } catch {}
      emit({ type: 'synthesis', content: '✅ FPL player optimization complete.' });
      return { finalAnswer: fplResult.data, steps, success: true, metadata: { mode: 'FPL_DEDICATED_OPTIMIZER', gameweek: payload.gameweek, deadline: payload.deadline, agentsRun: ['FPLWeeklyPlayerOptimizer'] } };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { finalAnswer: \`FPL optimizer failed: \${msg}\`, steps, success: false, error: msg, metadata: { mode: 'FPL_DEDICATED_OPTIMIZER' } };
    }
  }
`;
orchestrator = replaceOnce(
  orchestrator,
  'FPL orchestrator gate',
  /  const parsed = await parseQuery\(userQuery\);/,
  `${fplRoute}\n  const parsed = await parseQuery(userQuery);`
);
fs.writeFileSync(orchestratorTarget, orchestrator, 'utf8');

console.log(`[SEARCH_ONLY] Browser-backed tools disabled: ${blockedTools.join(', ')}`);
console.log('[SEARCH_ONLY] fetch_url remains ENABLED as native HTTP/static fetch.');
console.log('[SEARCH_ONLY] fetch_matches_today uses search APIs for URLs, then fetch_url for pages.');
console.log('[FPL] Production orchestrator routes FPL requests directly to the dedicated player optimizer.');
