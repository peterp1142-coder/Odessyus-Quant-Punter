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

// Hard-stop Chromium creation even if an internal caller reaches getBrowser().
requireOnce(
  'getBrowser guard',
  /async function getBrowser\(\)\{/,
  `async function getBrowser(){if(${searchOnly})throw new Error('Browser disabled by SEARCH_ONLY_MODE');`
);

// Hard-stop direct URL fetching when Render is configured for search-only operation.
requireOnce(
  'fetchUrl guard',
  /export async function fetchUrl\(url,useMobile=false\)\{/
,
  `export async function fetchUrl(url,useMobile=false){if(${searchOnly})return{success:false,data:'',error:'fetch_url disabled by SEARCH_ONLY_MODE',blocked:true,source:'fetch_url'};`
);

// Hard-stop the browser-backed scraper itself.
requireOnce(
  'scrape guard',
  /export async function scrape\(url,selector,waitTime=7000\)\{/,
  `export async function scrape(url,selector,waitTime=7000){if(${searchOnly})return{success:false,data:'',error:'scrape disabled by SEARCH_ONLY_MODE',blocked:true,source:'scrape:search-only'};`
);

// Prevent the ReAct model from even entering disabled tool implementations.
const blockedTools = [
  'fetch_url',
  'scrape',
  'book_slip',
  'fetch_matches_today',
  'scrape_flashscore',
  'multi_source_odds',
  'fetch_fbref_stats',
  'fetch_understat_xg',
  'fetch_lineups',
];
const names = blockedTools.map(name => `'${name}'`).join(',');
requireOnce(
  'dispatch guard',
  /export async function dispatchTool\(toolName,input\)\{\n\s*console\.log\(`/,
  `export async function dispatchTool(toolName,input){if(${searchOnly}&&[${names}].includes(toolName))return{success:false,data:'',error:\`Tool disabled in SEARCH_ONLY_MODE: \${toolName}\`,blocked:true,source:'search-only'};\nconsole.log(`
);

fs.writeFileSync(target, source, 'utf8');
console.log(`[SEARCH_ONLY] Runtime guard applied to ${target}`);
console.log(`[SEARCH_ONLY] Disabled tools: ${blockedTools.join(', ')}`);
