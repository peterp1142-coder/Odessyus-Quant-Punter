import { serpSearch, taloredataSearch, webSearch, fetchUrl } from './tools.js';

export interface ManagerIntel {
  player: string;
  club: string;
  sentiment: 'strong_positive' | 'positive' | 'neutral' | 'uncertain' | 'negative' | 'strong_negative';
  roleSecurity: number;
  minutesRisk: number;
  tacticalUpside: number;
  quoteSignals: string[];
  latestEvidence: string[];
  freshnessDays: number;
  confidence: number;
}

const positive = ['will start','will play','first choice','back in contention','ready to play','our starting','important player','key player','can play in two positions','higher up the pitch','more advanced','penalties','set pieces','corner','free-kick'];
const negative = ['not ready','not available','will not play','won’t play','out','ruled out','needs more time','manage his minutes','minutes restriction','rotation','competition for his place','doubtful'];

function classify(text: string) {
  const t = text.toLowerCase();
  const pos = positive.filter(x => t.includes(x));
  const neg = negative.filter(x => t.includes(x));
  let sentiment: ManagerIntel['sentiment'] = 'neutral';
  if (neg.length >= 2 && pos.length === 0) sentiment = 'strong_negative';
  else if (neg.length > pos.length) sentiment = 'negative';
  else if (pos.length >= 2 && neg.length === 0) sentiment = 'strong_positive';
  else if (pos.length > neg.length) sentiment = 'positive';
  else if (neg.length === 1 || pos.length === 1) sentiment = 'uncertain';
  const roleSecurity = Math.max(0, Math.min(1, 0.5 + pos.length * 0.10 - neg.length * 0.14));
  const minutesRisk = Math.max(0, Math.min(1, neg.length * 0.16 - pos.length * 0.06));
  const tacticalUpside = Math.max(0, Math.min(1,
    0.25 +
      (t.includes('higher up') || t.includes('more advanced') || t.includes('second striker') || t.includes('set pieces') || t.includes('penalt') ? 0.35 : 0) +
      (t.includes('two positions') || t.includes('multiple positions') ? 0.15 : 0)
  ));
  return {
    sentiment,
    roleSecurity,
    minutesRisk,
    tacticalUpside,
    quoteSignals: [...pos.map(x => `positive:${x}`), ...neg.map(x => `negative:${x}`)]
  };
}

function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(/https?:\/\/[^\s<>"'\)\]]+/g) || []) {
    const url = raw.replace(/[.,;]+$/g, '');
    if (!seen.has(url)) { seen.add(url); urls.push(url); }
    if (urls.length >= 8) break;
  }
  return urls;
}

async function search(query: string) {
  console.log(`[FPL SEARCH] Query: ${query}`);
  const started = Date.now();
  const tasks:[string,Promise<any>][] = [
    ['serper_search', serpSearch(query)],
    ['talordata_search', taloredataSearch(query)],
    ['web_search', webSearch(query)],
  ];
  const results = await Promise.allSettled(tasks.map(([,promise])=>promise));
  const searchBlocks:string[] = [];
  for(let i=0;i<results.length;i++){
    const result=results[i];
    const [provider]=tasks[i];
    if(result.status==='fulfilled'){
      console.log(`[FPL SEARCH] ${provider}: success=${result.value.success} source=${result.value.source||'unknown'} bytes=${result.value.data?.length||0}`);
      if(result.value.success&&result.value.data) searchBlocks.push(result.value.data);
    } else {
      console.error(`[FPL SEARCH] ${provider}: failed: ${result.reason instanceof Error?result.reason.message:String(result.reason)}`);
    }
  }
  console.log(`[FPL SEARCH] Search APIs completed in ${Date.now()-started}ms; blocks=${searchBlocks.length}`);
  if (!searchBlocks.length) return '';

  // Search APIs find candidate pages; Node fetch then hydrates those URLs. No Chromium is used.
  const urls = [...new Set(searchBlocks.flatMap(extractUrls))].slice(0, 8);
  console.log(`[FPL FETCH] Hydrating ${urls.length} discovered source URLs`);
  const pages = await Promise.allSettled(urls.map(url=>fetchUrl(url)));
  const fetchedBlocks:string[]=[];
  for(let i=0;i<pages.length;i++){
    const r=pages[i];
    if(r.status==='fulfilled'){
      console.log(`[FPL FETCH] ${urls[i]}: success=${r.value.success} source=${r.value.source||'fetch_url'} bytes=${r.value.data?.length||0}`);
      if(r.value.success&&!r.value.blocked) fetchedBlocks.push(`=== FETCHED SOURCE ${urls[i]} ===\n${r.value.data.slice(0,5000)}`);
    } else {
      console.error(`[FPL FETCH] ${urls[i]}: failed: ${r.reason instanceof Error?r.reason.message:String(r.reason)}`);
    }
  }
  console.log(`[FPL FETCH] Source hydration complete: fetched=${fetchedBlocks.length}`);

  return [...searchBlocks.map((s,i)=>`=== SEARCH SOURCE ${i+1} ===\n${s.slice(0,5000)}`),...fetchedBlocks]
    .join('\n--- INDEPENDENT SOURCE ---\n')
    .slice(0,14000);
}

export async function analyzeFplManagerIntel(
  players: Array<{ player: string; club: string }>
): Promise<{ success: boolean; data: ManagerIntel[]; source: string; error?: string }> {
  const out: ManagerIntel[]=[];
  console.log(`[FPL SEARCH] Manager/player research queue: ${Math.min(players.length,120)} players`);
  for (const item of players.slice(0,120)) {
    try {
      const q=`${item.player} ${item.club} manager press conference 2026/27 FPL start role minutes rotation injury set pieces site:premierleague.com OR site:${item.club.toLowerCase().replace(/\s+/g,'')}.com`;
      console.log(`[FPL SEARCH] Researching player ${item.player} (${item.club})`);
      const evidence=await search(q);
      const c=classify(evidence);
      const daysMatch=evidence.match(/(\d+)\s+days?\s+ago/i);
      const freshnessDays=daysMatch?Number(daysMatch[1]):999;
      const confidence=Math.max(0.2,Math.min(0.95,(evidence.length>1200?0.82:0.55)-(freshnessDays>7?0.2:0)));
      out.push({...item,...c,latestEvidence:evidence.split('\n--- INDEPENDENT SOURCE ---\n').filter(Boolean).slice(0,4),freshnessDays,confidence});
    } catch(e) {
      console.error(`[FPL SEARCH] Player research failed for ${item.player}: ${e instanceof Error?e.message:String(e)}`);
      out.push({player:item.player,club:item.club,sentiment:'uncertain',roleSecurity:0.5,minutesRisk:0.3,tacticalUpside:0.25,quoteSignals:[],latestEvidence:[],freshnessDays:999,confidence:0.2});
    }
  }
  console.log(`[FPL SEARCH] Manager/player research queue complete: ${out.length} players`);
  return {success:true,data:out,source:'FPLManagerIntel'};
}