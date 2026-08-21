import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve('dist-server/agent/tools.js');
if (!fs.existsSync(target)) {
  throw new Error(`Compiled tools file not found: ${target}`);
}

let source = fs.readFileSync(target, 'utf8');
const searchOnly = "process.env.SEARCH_ONLY_MODE === 'true'";

function requireOnce(label, pattern, replacement) {
  if (!pattern.test(source)) throw new Error(`SEARCH_ONLY patch target not found: ${label}`);
  source = source.replace(pattern, replacement);
}

requireOnce('getBrowser guard', /async function getBrowser\(\)\{/, `async function getBrowser(){if(${searchOnly})throw new Error('Browser disabled by SEARCH_ONLY_MODE');`);
requireOnce('fetchUrl guard', /export async function fetchUrl\(url,useMobile=false\)\{/, `export async function fetchUrl(url,useMobile=false){if(${searchOnly})return{success:false,data:'',error:'fetch_url disabled by SEARCH_ONLY_MODE',blocked:true,source:'fetch_url'};`);
requireOnce('scrape guard', /export async function scrape\(url,selector,waitTime=7000\)\{/, `export async function scrape(url,selector,waitTime=7000){if(${searchOnly})return{success:false,data:'',error:'scrape disabled by SEARCH_ONLY_MODE',blocked:true,source:'scrape:search-only'};`);

const blockedTools = ['fetch_url','scrape','book_slip','fetch_matches_today','scrape_flashscore','multi_source_odds','fetch_fbref_stats','fetch_understat_xg','fetch_lineups'];
const names = blockedTools.map(name => `'${name}'`).join(',');
requireOnce('dispatch guard', /export async function dispatchTool\(toolName,input\)\{/, `export async function dispatchTool(toolName,input){if(${searchOnly}&&[${names}].includes(toolName))return{success:false,data:'',error:\`Tool disabled in SEARCH_ONLY_MODE: \${toolName}\`,blocked:true,source:'search-only'};`);

fs.writeFileSync(target, source, 'utf8');
console.log(`[SEARCH_ONLY] Runtime guard applied to ${target}`);
console.log(`[SEARCH_ONLY] Disabled tools: ${blockedTools.join(', ')}`);
