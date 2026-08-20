import * as cheerio from 'cheerio';
import puppeteer, { type Browser, type BrowserContext, type Page } from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const DUCKDUCKGO_URL = 'https://html.duckduckgo.com/html/';
const TALORDATA_SERP = 'https://serpapi.talordata.net/serp/v1/request';
const SERPER_URL = 'https://google.serper.dev/search';
const ALLSPORTS_URL = 'https://apiv2.allsportsapi.com/football/';
const FETCH_TIMEOUT = 14_000;
const SCRAPE_TIMEOUT = 45_000;
const SEARCH_TIMEOUT = 12_000;
const MAX_CONTENT = 12_000;
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BROWSER_HEADERS = { 'User-Agent': DESKTOP_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

export interface ToolResult { success: boolean; data: string; error?: string; blocked?: boolean; source?: string; }

export const LIVE_MATCH_SOURCES: readonly string[] = [
  'https://www.flashscore.mobi/', 'https://m.flashscore.com/', 'https://m.sofascore.com/football',
  'https://www.livescore.com/en/', 'https://www.bbc.com/sport/football/scores-fixtures', 'https://www.skysports.com/football/scores',
  'https://footystats.org/today/', 'https://www.soccerway.com/', 'https://www.365scores.com/', 'https://www.scoreboard.com/en/',
  'https://www.espn.com/soccer/schedule/', 'https://www.goal.com/en/fixtures', 'https://www.oddsportal.com/matches/football/',
  'https://www.betexplorer.com/soccer/', 'https://www.oddschecker.com/football', 'https://understat.com/', 'https://fbref.com/en/matches/', 'https://www.fotmob.com/',
];

const truncate = (text: string, max = MAX_CONTENT) => text.length > max ? text.slice(0, max) + '\n...[truncated]' : text;
const isBlocked = (text: string) => !text || text.length < 400 || ['cloudflare','security verification','access denied','captcha','verify you are human','ddos protection','just a moment','checking your browser'].some(x => text.toLowerCase().includes(x));

async function fetchWithTimeout(url: string, options: RequestInit, timeout: number): Promise<Response> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}

function keyPool(name: string): string[] { return (process.env[name] || '').split(',').map(x => x.trim()).filter(Boolean); }
let serperIdx = 0, taloreIdx = 0, allSportsIdx = 0;

// Small TTL/in-flight cache prevents repeated identical agent searches from multiplying load.
const SEARCH_CACHE_TTL = 30_000;
const searchCache = new Map<string, { expires: number; result: ToolResult }>();
const searchInflight = new Map<string, Promise<ToolResult>>();
function cachedSearch(key: string, fn: () => Promise<ToolResult>): Promise<ToolResult> {
  const hit = searchCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.result);
  const running = searchInflight.get(key);
  if (running) return running;
  const p = fn().then(result => { searchCache.set(key, { expires: Date.now() + SEARCH_CACHE_TTL, result }); return result; }).finally(() => searchInflight.delete(key));
  searchInflight.set(key, p); return p;
}

export function webSearch(query: string): Promise<ToolResult> {
  const key = `web:${query.trim().toLowerCase()}`;
  return cachedSearch(key, async () => {
    try {
      const res = await fetchWithTimeout(`${DUCKDUCKGO_URL}?${new URLSearchParams({ q: query })}`, { headers: BROWSER_HEADERS }, SEARCH_TIMEOUT);
      const $ = cheerio.load(await res.text()); const out: string[] = [];
      $('.result__body').each((_, el) => { const t = $(el).find('.result__title').text().trim(); const s = $(el).find('.result__snippet').text().trim(); const u = $(el).find('a.result__url').text().trim(); if (t || s) out.push(`${t}\n${s}\n${u}`); });
      const data = out.slice(0, 10).join('\n---\n'); return data.length >= 100 ? { success: true, data: truncate(data), source: 'web_search' } : { success: false, data: '', error: 'No search results', source: 'web_search' };
    } catch (e) { return { success: false, data: '', error: String(e), source: 'web_search' }; }
  });
}

export function serpSearch(query: string): Promise<ToolResult> {
  const key = `serper:${query.trim().toLowerCase()}`;
  return cachedSearch(key, async () => {
    const pool = keyPool('SERP_APIs'); if (!pool.length) return webSearch(query);
    for (let i = 0; i < pool.length; i++) { const apiKey = pool[serperIdx++ % pool.length]; try {
      const res = await fetchWithTimeout(SERPER_URL, { method: 'POST', headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, num: 10 }) }, SEARCH_TIMEOUT);
      if (res.status === 401 || res.status === 403 || !res.ok) continue;
      const j = await res.json() as any; const p: string[] = []; if (j.answerBox?.answer) p.push(j.answerBox.answer); if (j.answerBox?.snippet) p.push(j.answerBox.snippet); if (j.knowledgeGraph?.description) p.push(j.knowledgeGraph.description);
      for (const r of j.organic || []) p.push([r.title, r.snippet, r.link].filter(Boolean).join('\n'));
      if (p.length) return { success: true, data: truncate(p.join('\n---\n'), 8000), source: 'serper_search' };
    } catch {} }
    return webSearch(query);
  });
}

export function taloredataSearch(query: string): Promise<ToolResult> {
  const key = `talore:${query.trim().toLowerCase()}`;
  return cachedSearch(key, async () => {
    const pool = keyPool('SEARCH_APIs'); if (!pool.length) return webSearch(query);
    for (let i = 0; i < pool.length; i++) { const apiKey = pool[taloreIdx++ % pool.length]; try {
      const body = new URLSearchParams({ engine: 'google', json: '2', q: query });
      const res = await fetchWithTimeout(TALORDATA_SERP, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, SEARCH_TIMEOUT);
      const env = await res.json() as any; if (env.code === 400) break; if (env.code !== 0 || !env.data?.json) continue;
      const raw = Object.keys(env.data.json).sort((a,b) => Number(a)-Number(b)).map(k => env.data.json[k]).join(''); const j = JSON.parse(raw); const rows = j.organic || [];
      if (rows.length) return { success: true, data: truncate(rows.slice(0,12).map((r:any) => [r.title,r.description,r.link].filter(Boolean).join('\n')).join('\n---\n'), 6000), source: 'talordata_search' };
    } catch {} }
    return webSearch(query);
  });
}

export async function allSportsFixtures(dateFrom: string, dateTo = dateFrom): Promise<ToolResult> {
  const pool = keyPool('ALL_SPORTS_APIs'); if (!pool.length) return { success:false,data:'',error:'No ALL_SPORTS_APIs keys configured',source:'allsports_fixtures' };
  for (let i=0;i<pool.length;i++) { const key=pool[allSportsIdx++%pool.length]; try {
    const p=new URLSearchParams({met:'Fixtures',APIkey:key,from:dateFrom,to:dateTo}); const r=await fetchWithTimeout(`${ALLSPORTS_URL}?${p}`,{headers:{Accept:'application/json'}},SEARCH_TIMEOUT); if(!r.ok) continue;
    const j=await r.json() as any; if(!j.success||!j.result?.length) continue; const lines=j.result.map((e:any)=>`${e.event_date} ${e.event_time||''} | ${e.event_home_team} vs ${e.event_away_team} | ${e.event_league_name||e.league_name||''} (${e.event_country_name||''}) | ${e.event_status||''}`); return {success:true,data:truncate(`[AllSports Fixtures ${dateFrom}–${dateTo}]\n${lines.join('\n')}`,12000),source:'allsports_fixtures'};
  } catch {} }
  return {success:false,data:'',error:'All AllSports API keys failed',source:'allsports_fixtures'};
}

export async function allSportsLivescore(): Promise<ToolResult> {
  const pool=keyPool('ALL_SPORTS_APIs'); if(!pool.length)return{success:false,data:'',error:'No ALL_SPORTS_APIs keys configured',source:'allsports_livescore'};
  for(let i=0;i<pool.length;i++){const key=pool[allSportsIdx++%pool.length];try{const p=new URLSearchParams({met:'Livescore',APIkey:key});const r=await fetchWithTimeout(`${ALLSPORTS_URL}?${p}`,{headers:{Accept:'application/json'}},SEARCH_TIMEOUT);if(!r.ok)continue;const j=await r.json() as any;if(!j.success||!j.result?.length)return{success:true,data:'No live matches currently in progress',source:'allsports_livescore'};return{success:true,data:truncate(j.result.map((e:any)=>`${e.event_home_team} ${e.event_home_team_score??'-'}:${e.event_away_team_score??'-'} ${e.event_away_team} | ${e.event_league_name||''} | ${e.event_status||''}`).join('\n'),8000),source:'allsports_livescore'};}catch{}}
  return{success:false,data:'',error:'All AllSports API keys failed',source:'allsports_livescore'};
}

export async function fetchUrl(url:string,useMobile=false):Promise<ToolResult>{try{const r=await fetchWithTimeout(url,{headers:{...BROWSER_HEADERS,'User-Agent':useMobile?MOBILE_UA:DESKTOP_UA}},FETCH_TIMEOUT);if(!r.ok)return{success:false,data:'',error:`HTTP ${r.status}`,source:'fetch_url'};const $=cheerio.load(await r.text());$('script,style,nav,header,footer,.ad,.ads,.cookie-banner,[class*="cookie"],[id*="cookie"]').remove();const text=$('body').text().replace(/\s+/g,' ').trim();return text.length>=100?{success:true,data:truncate(text),source:'fetch_url'}:{success:false,data:'',error:'Page too short or empty',source:'fetch_url'};}catch(e){return{success:false,data:'',error:String(e),source:'fetch_url'}}}

// ---------------------------------------------------------------------------
// Local browser pool: one shared Chromium process, max 2 pages, queued work.
// This is deliberately kept in-process so a single Render worker does not fork
// Chrome for every scrape. Contexts/pages are closed after every operation.
// ---------------------------------------------------------------------------
let browser: Browser | null = null;
let browserStarting: Promise<Browser> | null = null;
const selectorCache = new Map<string,string>();
const MAX_BROWSER_PAGES = Math.max(1, Math.min(2, Number(process.env.BROWSER_MAX_CONCURRENCY || 2)));
const RSS_GUARD_BYTES = Math.max(256, Number(process.env.BROWSER_RSS_GUARD_MB || 430)) * 1024 * 1024;
let activeBrowserPages = 0;
const browserQueue: Array<() => void> = [];
let browserWatchdog: NodeJS.Timeout | null = null;

function rssBytes(){ return process.memoryUsage().rss; }
function memoryGuard(){
  const rss = rssBytes();
  if (rss >= RSS_GUARD_BYTES) throw new Error(`Browser memory guard: Node RSS ${(rss/1048576).toFixed(0)}MB >= ${(RSS_GUARD_BYTES/1048576).toFixed(0)}MB safety limit`);
}
function acquireBrowserSlot(): Promise<void>{
  if (activeBrowserPages < MAX_BROWSER_PAGES) { activeBrowserPages++; return Promise.resolve(); }
  return new Promise(resolve => browserQueue.push(() => { activeBrowserPages++; resolve(); }));
}
function releaseBrowserSlot(){ activeBrowserPages=Math.max(0,activeBrowserPages-1); const next=browserQueue.shift(); if(next)next(); }

function findChromeExecutable(): string | null {
  const configured = [process.env.LOCAL_CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH].filter(Boolean) as string[];
  const candidates = [...configured,
    '/opt/render/project/.chrome/chrome/linux-127.0.6533.88/chrome-linux64/chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/nix/var/nix/profiles/default/bin/chromium', '/nix/var/nix/profiles/default/bin/chromium-browser'];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  const roots = ['/opt/render/project/.chrome/chrome','/opt/render/.cache/puppeteer/chrome'];
  const stack = [...roots]; let visited = 0;
  while(stack.length && visited++ < 500){ const dir=stack.pop()!; let entries:fs.Dirent[]=[]; try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{continue;} for(const e of entries){const p=path.join(dir,e.name);if(e.isDirectory())stack.push(p);else if(e.isFile()&&e.name==='chrome'&&fs.existsSync(p))return p;} }
  return null;
}

function browserArgs(){ return [
  '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu',
  '--disable-extensions','--disable-plugins','--disable-component-update','--disable-background-networking',
  '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-breakpad',
  '--disable-crash-reporter','--disable-client-side-phishing-detection','--disable-sync',
  '--disable-default-apps','--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
  '--no-first-run','--no-default-browser-check','--password-store=basic','--use-mock-keychain',
  '--mute-audio','--no-service-autorun','--metrics-recording-only','--renderer-process-limit=2',
]; }

async function getBrowser():Promise<Browser>{
  if(browser?.connected)return browser;
  if(browserStarting)return browserStarting;
  browserStarting=(async()=>{
    memoryGuard();
    const executablePath=findChromeExecutable();
    if(!executablePath) throw new Error('Local Chromium executable not found. Set LOCAL_CHROME_PATH or PUPPETEER_EXECUTABLE_PATH to the installed Chrome binary.');
    console.log(`[Browser] Starting shared Chromium: ${executablePath} | maxPages=${MAX_BROWSER_PAGES} | RSS guard=${Math.round(RSS_GUARD_BYTES/1048576)}MB`);
    const b=await puppeteer.launch({headless:true,executablePath,args:browserArgs(),handleSIGINT:false,handleSIGTERM:false,handleSIGHUP:false});
    browser=b;
    if(browserWatchdog)clearInterval(browserWatchdog);
    browserWatchdog=setInterval(()=>{ if(browser&&!browser.connected){ console.warn('[Browser] Chromium disconnected; clearing shared instance'); browser=null; } },30_000);
    return b;
  })();
  try{return await browserStarting;}finally{browserStarting=null;}
}

async function resetBrowser(reason:string){ const b=browser; browser=null; if(b){console.warn(`[Browser] Restarting shared Chromium: ${reason}`);try{await b.close();}catch{}} }

async function withBrowserPage<T>(work:(page:Page)=>Promise<T>):Promise<T>{
  memoryGuard();
  await acquireBrowserSlot();
  let context:BrowserContext|null=null; let page:Page|null=null;
  try{
    memoryGuard();
    const b=await getBrowser();
    memoryGuard();
    context=await b.createBrowserContext();
    page=await context.newPage();
    await configureBrowserPage(page);
    return await work(page);
  }catch(err){
    const message=String(err);
    if(/Target closed|Session closed|Connection closed|browser.*disconnected|Protocol error/i.test(message))await resetBrowser(message);
    throw err;
  }finally{
    try{if(page)await page.close();}catch{}
    try{if(context)await context.close();}catch{}
    releaseBrowserSlot();
  }
}

async function configureBrowserPage(page:Page){
  await page.setUserAgent(DESKTOP_UA);
  await page.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9',Accept:'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'});
  await page.setRequestInterception(true);
  page.on('request',req=>{ try{ const type=req.resourceType(); if(['image','stylesheet','font','media','websocket'].includes(type))req.abort(); else req.continue(); }catch{} });
  await page.setDefaultNavigationTimeout(30_000); await page.setDefaultTimeout(30_000);
}

function cacheKey(url:string,selector:string){try{const u=new URL(url);return `${u.hostname}${u.pathname}|${selector}`;}catch{return `${url}|${selector}`;}}
async function navigate(page:Page,url:string,waitTime:number){await page.goto(url,{waitUntil:'domcontentloaded',timeout:30_000});if(waitTime>0)await new Promise(r=>setTimeout(r,Math.min(waitTime,10_000)));}
async function discoverSelectors(page:Page,hint:string):Promise<string[]>{return page.evaluate((h)=>{const els=Array.from(document.querySelectorAll('div,table,ul,ol,section,article,main,tbody,tr'));const out:{s:string;n:number}[]=[];for(const el of els){const text=(el as HTMLElement).innerText||'';if(text.length<100||text.length>30000)continue;let n=0;if(/\b[1-9]\.\d{2}\b/.test(text))n+=3;if(/[A-Z][a-z]+\s+[-–]\s+[A-Z][a-z]+/.test(text))n+=2;if(/\b\d{1,2}:\d{2}\b/.test(text))n+=2;if(/odds|bet|kickoff|vs|match|fixture|score/i.test(text))n++;if(h&&text.toLowerCase().includes(h.toLowerCase()))n+=2;if(n<3)continue;const id=(el as HTMLElement).id,cls=(el as HTMLElement).className;let s=el.tagName.toLowerCase();if(id)s=`#${id}`;else if(typeof cls==='string'&&cls.trim())s=`${s}.${cls.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_-]/g,'')}`;out.push({s,n});}return [...new Set(out.sort((a,b)=>b.n-a.n).slice(0,12).map(x=>x.s))];},hint);}
async function extract(page:Page,selector:string){return page.evaluate(sel=>Array.from(document.querySelectorAll(sel)).map(e=>(e as HTMLElement).innerText||'').join('\n').trim(),selector);}

export async function scrape(url:string,selector:string,waitTime=7000):Promise<ToolResult>{
  const key=cacheKey(url,selector);
  try{
    return await withBrowserPage(async page=>{
      await navigate(page,url,waitTime);
      const candidates=[selectorCache.get(key),selector].filter(Boolean) as string[]; let text='';
      for(const s of candidates){try{const t=await extract(page,s);if(t.length>=100){text=t;break;}}catch{}}
      if(text.length<100){
        console.log(`[SCRAPE] Selector mismatch: ${selector} @ ${url}; inspecting live DOM`);
        for(const s of await discoverSelectors(page,selector)){try{const t=await extract(page,s);if(t.length>=100){text=t;selectorCache.set(key,s);console.log(`[SCRAPE] Recovered selector: ${s}`);break;}}catch{}}
      }
      if(text.length<100){text=await page.evaluate(()=>document.body?.innerText||'');if(text.length>=100)console.log(`[SCRAPE] Using full-body fallback after selector recovery failed: ${url}`);}
      if(text.length<100)return{success:false,data:'',error:'Scrape yielded insufficient content after local selector recovery',source:'scrape:local-browser'};
      if(isBlocked(text))return{success:false,data:text,blocked:true,error:'Content blocked',source:'scrape:local-browser'};
      return{success:true,data:truncate(text,14000),source:'scrape:local-browser'};
    });
  }catch(e){return{success:false,data:'',error:String(e),source:'scrape:local-browser'};}
}

export async function scrapeFlashscore(dateStr?:string):Promise<ToolResult>{const today=dateStr||new Date().toISOString().slice(0,10);const r=await scrape('https://www.flashscore.mobi/?d=0&s=1','#main',6000);return r.success?{...r,data:`[Date: ${today}] [Source: flashscore:local-browser]\n${r.data}`,source:'flashscore:local-browser'}:r;}

export async function fetchMatchesToday(sport='football',dateStr?:string):Promise<ToolResult>{const today=dateStr||new Date().toISOString().slice(0,10);const sources=['https://www.livescore.com/en/','https://www.bbc.com/sport/football/scores-fixtures','https://www.azscore.com/football/today.html','https://www.scoreboard.com/en/','https://footystats.org/today/'];const [flash,...rest]=await Promise.allSettled([scrapeFlashscore(dateStr),...sources.map(u=>fetchUrl(u))]);const data:string[]=[];if(flash.status==='fulfilled'&&flash.value.success)data.push(`=== FLASHSCORE ===\n${flash.value.data}`);rest.forEach((r,i)=>{if(r.status==='fulfilled'&&r.value.success&&!r.value.blocked)data.push(`=== ${sources[i]} ===\n${r.value.data.slice(0,4000)}`);});if(data.length)return{success:true,data:`[Date: ${today}] [Sport: ${sport}]\n${data.join('\n\n').slice(0,20000)}`,source:'fetch_matches_today:local-browser'};return taloredataSearch(`football matches fixtures today ${today} kickoff times schedule`);}

export async function multiSourceOdds(fixture:string):Promise<ToolResult>{const q=encodeURIComponent(fixture);const targets=[`https://www.oddsportal.com/search/results/?q=${q}`,`https://www.betexplorer.com/results/?sport=soccer&q=${q}`,'https://www.oddschecker.com/football','https://www.pinnacle.com/en/soccer/matchups'];const results=await Promise.allSettled(targets.map(u=>scrape(u,'body',7000)));const data=results.flatMap((r,i)=>r.status==='fulfilled'&&r.value.success?[`--- ${targets[i]} ---\n${r.value.data.slice(0,3500)}`]:[]);return data.length?{success:true,data:truncate(data.join('\n\n'),16000),source:'multi_source_odds'}:taloredataSearch(`${fixture} odds today site:oddsportal.com OR site:betexplorer.com OR site:pinnacle.com`);}

export async function fetchFbrefStats(team:string,_league?:string):Promise<ToolResult>{const s=await taloredataSearch(`${team} xG stats ${new Date().getFullYear()} site:fbref.com`);const m=s.data.match(/https?:\/\/[^\s]+fbref\.com[^\s]*/);if(m){const r=await scrape(m[0],'#stats_shooting, #stats_standard, body',8000);if(r.success)return{...r,data:`[FBref Stats: ${team}]\n${r.data.slice(0,10000)}`};}return s;}
export async function fetchUnderstatXg(team:string):Promise<ToolResult>{const r=await fetchUrl(`https://understat.com/team/${team.replace(/\s+/g,'_')}`);return r.success?{...r,data:`[Understat xG: ${team}]\n${r.data.slice(0,8000)}`}:taloredataSearch(`${team} understat xG per game season ${new Date().getFullYear()}`);}
export async function fetchLineups(fixture:string):Promise<ToolResult>{const today=new Date().toISOString().slice(0,10);const [a,b]=await Promise.allSettled([taloredataSearch(`${fixture} confirmed starting lineup ${today}`),scrape(`https://www.sofascore.com/search/events/${encodeURIComponent(fixture)}`,'body',8000)]);const out:string[]=[];if(a.status==='fulfilled'&&a.value.success)out.push(a.value.data);if(b.status==='fulfilled'&&b.value.success)out.push(b.value.data);return out.length?{success:true,data:out.join('\n---\n'),source:'fetch_lineups'}:taloredataSearch(`${fixture} predicted XI ${today}`);}
export async function calculateKelly(trueProbability:number,decimalOdds:number,bankroll=1000):Promise<ToolResult>{if(decimalOdds<=1||trueProbability<=0||trueProbability>=1)return{success:false,data:'',error:'Invalid inputs for Kelly Criterion'};const b=decimalOdds-1,q=1-trueProbability,k=Math.max(0,(b*trueProbability-q)/b),ev=trueProbability*decimalOdds-1;return{success:true,data:JSON.stringify({true_probability:`${(trueProbability*100).toFixed(1)}%`,decimal_odds:decimalOdds,implied_prob:`${((1/decimalOdds)*100).toFixed(1)}%`,edge:`${(ev*100).toFixed(2)}%`,full_kelly_pct:`${(k*100).toFixed(2)}%`,half_kelly_pct:`${(k*50).toFixed(2)}%`,quarter_kelly_pct:`${(k*25).toFixed(2)}%`},null,2),source:'calculate_kelly'};}
export async function bookSlip(url:string,selector:string,waitTime=7000){return scrape(url,selector,waitTime);}
export async function placeBetTool(input:Record<string,unknown>):Promise<ToolResult>{try{const {placeBet}=await import('../booking/engine.js');const r=await placeBet({platform:String(input.platform||process.env.BOOKING_PLATFORM||'sportybet') as import('../booking/types.js').PlatformId,fixture:String(input.fixture||''),market:String(input.market||'Match Result'),selection:String(input.selection||''),minOdds:Number(input.min_odds??input.minOdds??1.5),stakeUnits:Number(input.stake_units??input.stakeUnits??1)});return r.success?{success:true,data:`BET PLACED\nPlatform: ${r.platform}\nBet ID: ${r.betId||'N/A'}\nOdds: ${r.oddsObtained}\nReturn: ${r.potentialReturn}`,source:'place_bet'}:{success:false,data:'',error:r.reason||r.error||'Booking failed',source:'place_bet'};}catch(e){return{success:false,data:'',error:String(e),source:'place_bet'}}}

const BLOCKED_URLS=new Map<string,number>();
function isUrlBlocked(url:string){const t=BLOCKED_URLS.get(url)||0;if(Date.now()<t)return true;BLOCKED_URLS.delete(url);return false;}
function markUrlBlocked(url:string){BLOCKED_URLS.set(url,Date.now()+60000);}
function fallbackQuery(url:string,input:Record<string,unknown>){const base=String(input.fixture||input.query||'');if(url.includes('odds'))return `${base} odds bookmaker comparison today`;if(url.includes('sofascore')||url.includes('transfermarkt'))return `${base} confirmed lineup starting XI today`;if(url.includes('fbref')||url.includes('soccerway'))return `${base} head to head form results`;if(url.includes('understat')||url.includes('footystats'))return `${base} xG stats form this season`;return base||url;}

export async function dispatchTool(toolName:string,input:Record<string,unknown>):Promise<ToolResult>{
  console.log(`[TOOL] ${toolName}:`,JSON.stringify(input).slice(0,180));
  switch(toolName){
    case 'web_search':return webSearch(String(input.query||''));
    case 'serper_search':return serpSearch(String(input.query||''));
    case 'talordata_search':return taloredataSearch(String(input.query||''));
    case 'allsports_fixtures':return allSportsFixtures(String(input.date||input.from||new Date().toISOString().slice(0,10)),input.to?String(input.to):undefined);
    case 'allsports_livescore':return allSportsLivescore();
    case 'fetch_url':{const u=String(input.url||'');if(isUrlBlocked(u))return taloredataSearch(fallbackQuery(u,input));const r=await fetchUrl(u,Boolean(input.mobile));if(!r.success||r.blocked){markUrlBlocked(u);return taloredataSearch(fallbackQuery(u,input));}return r;}
    case 'scrape':{const u=String(input.url||'');if(isUrlBlocked(u))return taloredataSearch(fallbackQuery(u,input));const r=await scrape(u,String(input.selector||'body'),Number(input.waitTime??7000));if(!r.success||r.blocked){markUrlBlocked(u);return taloredataSearch(fallbackQuery(u,input));}return r;}
    case 'book_slip':return bookSlip(String(input.url||input.bookmaker_url||''),String(input.selector||'body'),Number(input.waitTime??7000));
    case 'fetch_matches_today':return fetchMatchesToday(String(input.sport||'football'),String(input.date||''));
    case 'scrape_flashscore':return scrapeFlashscore(String(input.date||''));
    case 'multi_source_odds':return multiSourceOdds(String(input.fixture||input.query||''));
    case 'fetch_fbref_stats':return fetchFbrefStats(String(input.team||input.fixture||''),String(input.league||''));
    case 'fetch_understat_xg':return fetchUnderstatXg(String(input.team||''));
    case 'fetch_lineups':return fetchLineups(String(input.fixture||''));
    case 'calculate_kelly':return calculateKelly(Number(input.true_probability||input.prob||0),Number(input.decimal_odds||input.odds||0),Number(input.bankroll||1000));
    case 'place_bet':return placeBetTool(input);
    default:return{success:false,data:'',error:`Unknown tool: ${toolName}`};
  }
}
