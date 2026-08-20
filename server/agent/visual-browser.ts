import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';
import { currentVisualSessionId, publishVisual } from './visual-events.js';

const VISUAL_ACTION_MAX_STEPS = Math.max(2, Math.min(6, Number(process.env.VISUAL_ACTION_MAX_STEPS || 5)));
const VISUAL_ACTION_MAX_WAIT_MS = Math.max(500, Math.min(6000, Number(process.env.VISUAL_ACTION_MAX_WAIT_MS || 5000)));
const VISUAL_ACTION_MIN_WAIT_MS = Math.max(150, Math.min(1000, Number(process.env.VISUAL_ACTION_MIN_WAIT_MS || 350)));
const VISUAL_OBSERVATION_MAX_CHARS = 9000;

interface VisualDecision {
  action: 'READY' | 'WAIT' | 'SCROLL' | 'CLICK' | 'BLOCKED' | 'STOP';
  waitMs?: number;
  scrollY?: number;
  selector?: string;
  reason?: string;
  data?: string;
  challengeType?: string;
  confidence?: number;
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function extractJson(text: string): VisualDecision | null {
  const candidates = [text.trim(), text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<VisualDecision>;
      if (!parsed || typeof parsed.action !== 'string') continue;
      const action = parsed.action.toUpperCase() as VisualDecision['action'];
      if (!['READY', 'WAIT', 'SCROLL', 'CLICK', 'BLOCKED', 'STOP'].includes(action)) continue;
      return {
        action,
        waitMs: typeof parsed.waitMs === 'number' ? parsed.waitMs : undefined,
        scrollY: typeof parsed.scrollY === 'number' ? parsed.scrollY : undefined,
        selector: typeof parsed.selector === 'string' ? parsed.selector : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 600) : undefined,
        data: typeof parsed.data === 'string' ? parsed.data.slice(0, VISUAL_OBSERVATION_MAX_CHARS) : undefined,
        challengeType: typeof parsed.challengeType === 'string' ? parsed.challengeType.slice(0, 200) : undefined,
        confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : undefined,
      };
    } catch {}
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<VisualDecision>;
    if (!parsed?.action) return null;
    const action = String(parsed.action).toUpperCase() as VisualDecision['action'];
    if (!['READY', 'WAIT', 'SCROLL', 'CLICK', 'BLOCKED', 'STOP'].includes(action)) return null;
    return {
      action,
      waitMs: typeof parsed.waitMs === 'number' ? parsed.waitMs : undefined,
      scrollY: typeof parsed.scrollY === 'number' ? parsed.scrollY : undefined,
      selector: typeof parsed.selector === 'string' ? parsed.selector : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 600) : undefined,
      data: typeof parsed.data === 'string' ? parsed.data.slice(0, VISUAL_OBSERVATION_MAX_CHARS) : undefined,
      challengeType: typeof parsed.challengeType === 'string' ? parsed.challengeType.slice(0, 200) : undefined,
      confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : undefined,
    };
  } catch { return null; }
}

async function wait(ms: number): Promise<void> { await new Promise(resolve => setTimeout(resolve, clamp(ms, VISUAL_ACTION_MIN_WAIT_MS, VISUAL_ACTION_MAX_WAIT_MS))); }

async function pageDiagnostics(page: Page): Promise<{ readyState:string; title:string; textLength:number; htmlLength:number; viewport:string; scrollY:number; scrollHeight:number; }> {
  return page.evaluate(() => ({
    readyState: document.readyState,
    title: document.title || '',
    textLength: (document.body?.innerText || '').trim().length,
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement?.scrollHeight || 0),
  })).catch(() => ({ readyState:'unknown', title:'', textLength:0, htmlLength:0, viewport:'unknown', scrollY:0, scrollHeight:0 }));
}

async function discoverVisibleCandidates(page: Page, hint: string): Promise<Array<{ selector:string; text:string }>> {
  return page.evaluate((h) => {
    const elements = Array.from(document.querySelectorAll('main, [role="main"], #content, #main, #root, #app, table, tbody, tr, article, section, nav, button, a, div'));
    const candidates:Array<{selector:string;text:string;score:number}> = [];
    for (const element of elements) {
      const node = element as HTMLElement;
      const text = (node.innerText || '').replace(/\s+/g,' ').trim();
      if (text.length < 40 || text.length > 12000) continue;
      let score = 0;
      if (/\b\d{1,2}:\d{2}\b/.test(text)) score += 3;
      if (/\b(?:vs\.?|v\.)\b/i.test(text)) score += 3;
      if (/\b(?:fixture|match|matches|kickoff|schedule|score|odds|bet|football|soccer)\b/i.test(text)) score += 2;
      if (/\b(?:today|tomorrow|aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul)\b/i.test(text)) score += 1;
      if (/\b[1-9]\.[0-9]{2}\b/.test(text)) score += 2;
      if (h && text.toLowerCase().includes(h.toLowerCase())) score += 1;
      let selector = node.tagName.toLowerCase();
      const id = node.id;
      const className = typeof node.className === 'string' ? node.className.trim() : '';
      if (id && /^[A-Za-z_][\w:-]*$/.test(id)) selector = `#${id}`;
      else if (className) {
        const firstClass = className.split(/\s+/).find(Boolean);
        if (firstClass && /^[A-Za-z_][\w-]*$/.test(firstClass)) selector = `${selector}.${firstClass}`;
      }
      if (score >= 3) candidates.push({ selector, text, score });
    }
    const seen = new Set<string>();
    return candidates.sort((a,b)=>b.score-a.score||b.text.length-a.text.length).filter(item=>!seen.has(item.selector)&&seen.add(item.selector)).slice(0,12).map(({selector,text})=>({selector,text:text.slice(0,1800)}));
  }, hint);
}

async function executeDecision(page:Page, decision:VisualDecision, allowedSelectors:Set<string>):Promise<boolean>{
  switch(decision.action){
    case 'WAIT': await wait(Number(decision.waitMs||1500)); return true;
    case 'SCROLL': await page.evaluate((dy)=>window.scrollBy({top:dy,left:0,behavior:'instant'}),clamp(Number(decision.scrollY||650),-1200,1600)); await wait(VISUAL_ACTION_MIN_WAIT_MS); return true;
    case 'CLICK':
      if(!decision.selector||!allowedSelectors.has(decision.selector)) return false;
      try{const target=await page.$(decision.selector);if(!target)return false;await target.click({delay:60});await wait(VISUAL_ACTION_MIN_WAIT_MS);return true;}catch{return false;}
    default:return false;
  }
}

async function deleteUploadedFile(fileId:string|undefined):Promise<void>{
  if(!fileId)return;
  try{await mistralPool.call(client=>client.files.delete({fileId}));}
  catch(error){const message=error instanceof Error?error.message:String(error);if(!/404|not found/i.test(message))console.warn('[VISUAL] Could not delete temporary screenshot:',message);}
}

/**
 * Intent-driven browser vision loop. CAPTCHA/anti-bot challenges are detected and
 * classified by Mistral, but the browser does not automate their completion or
 * bypass. Instead it returns a human-verification requirement to the agent/UI.
 */
export async function inspectPageVisually(page:Page,hint='',candidateContext='',sessionId=currentVisualSessionId()||''):Promise<string>{
  if(process.env.VISUAL_BROWSER_ENABLED==='false')return '';
  let lastUsefulData='';
  try{
    for(let step=0;step<VISUAL_ACTION_MAX_STEPS;step++){
      const diagnostics=await pageDiagnostics(page);
      const candidates=await discoverVisibleCandidates(page,hint);
      const allowedSelectors=new Set(candidates.map(c=>c.selector));
      const liveContext=candidates.map(c=>`SELECTOR: ${c.selector}\nTEXT: ${c.text}`).join('\n---\n');
      const mergedContext=[candidateContext,liveContext].filter(Boolean).join('\n=== LIVE CANDIDATES ===\n').slice(0,14000);
      const screenshot=await page.screenshot({type:'jpeg',quality:55,fullPage:false,encoding:'base64'});
      if(sessionId){publishVisual({sessionId,image:`data:image/jpeg;base64,${screenshot}`,url:page.url(),hint});}
      console.log(`[VISUAL] Observe step=${step+1}/${VISUAL_ACTION_MAX_STEPS} readyState=${diagnostics.readyState} text=${diagnostics.textLength} scroll=${diagnostics.scrollY}/${diagnostics.scrollHeight} url=${page.url()}`);

      const prompt=[
        'You are the visual browser controller for a sports research agent. Behave like a careful human browsing with intent.',
        `Goal: ${hint||'find useful football fixture, market, odds, or schedule information on this page'}.`,
        'Look at the CURRENT screenshot first. Use DOM candidates only as supporting evidence.',
        `Browser state: readyState=${diagnostics.readyState}; visibleTextLength=${diagnostics.textLength}; scroll=${diagnostics.scrollY}/${diagnostics.scrollHeight}; title=${diagnostics.title||'(none)'}.`,
        mergedContext?`Visible candidate DOM:\n${mergedContext}`:'',
        'If the page is blank, skeleton-loading, spinner-loading, or clearly still rendering, choose WAIT with a sensible waitMs rather than pretending it is ready.',
        'If content is below the fold, choose SCROLL with a sensible scrollY.',
        'If a visible navigation control is needed to reach the requested content, choose CLICK using EXACTLY one selector from the supplied candidates. Never invent a selector.',
        'If the page already contains enough relevant information, choose READY and put the useful extracted information in data.',
        'If the page is blocked by a CAPTCHA, anti-bot challenge, consent gate, or login wall, choose BLOCKED and identify the challenge type in challengeType.',
        'CAPTCHA POLICY: detect and classify the challenge only. Do not solve it, bypass it, defeat it, or provide automated solving instructions. Set reason to HUMAN_VERIFICATION_REQUIRED.',
        'Never invent facts, teams, odds, times, or selectors.',
        'Use WAIT because the page is genuinely loading, not as a reflex. Prefer the smallest wait likely to reveal new content.',
        'Return ONLY JSON with this shape: {"action":"READY|WAIT|SCROLL|CLICK|BLOCKED|STOP","waitMs":1500,"scrollY":700,"selector":"#example","reason":"...","challengeType":"reCAPTCHA|hCaptcha|Cloudflare Turnstile|image|checkbox|unknown|none","confidence":0.0,"data":"..."}. Omit fields that are not relevant.',
      ].filter(Boolean).join('\n');

      const response=await mistralPool.call(async client=>{
        let fileId:string|undefined;
        try{
          const uploaded=await client.files.upload({file:{fileName:`browser-observation-${Date.now()}.jpg`,content:Buffer.from(screenshot,'base64')},purpose:'ocr'});
          fileId=uploaded.id;
          return await client.chat.complete({model:process.env.VISUAL_BROWSER_MODEL||'mistral-large-latest',temperature:0,maxTokens:750,messages:[{role:'user',content:[{type:'text',text:prompt},{type:'file',fileId:uploaded.id}]}]} as any);
        }finally{await deleteUploadedFile(fileId);}
      });

      const responseText=response.choices?.[0]?.message?.content;
      const decision=typeof responseText==='string'?extractJson(responseText):null;
      if(!decision){console.warn('[VISUAL] Mistral returned no valid browser decision; stopping visual loop safely.');break;}
      console.log(`[VISUAL] Decision action=${decision.action}${decision.waitMs?` wait=${decision.waitMs}ms`:''}${decision.selector?` selector=${decision.selector}`:''}${decision.challengeType?` challenge=${decision.challengeType}`:''}${decision.reason?` reason=${decision.reason}`:''}`);
      if(decision.data)lastUsefulData=decision.data;
      if(decision.action==='READY')return decision.data||lastUsefulData;
      if(decision.action==='BLOCKED'){
        const challenge=decision.challengeType&&decision.challengeType!=='none'?decision.challengeType:'anti-bot/verification challenge';
        console.warn(`[VISUAL] Human verification required: ${challenge}`);
        return `[HUMAN_VERIFICATION_REQUIRED]\nChallenge: ${challenge}\nConfidence: ${decision.confidence!=null?decision.confidence.toFixed(2):'unknown'}\nReason: ${decision.reason||'Verification page detected.'}${lastUsefulData?`\n${lastUsefulData}`:''}`;
      }
      if(decision.action==='STOP')break;
      const acted=await executeDecision(page,decision,allowedSelectors);
      if(!acted){console.warn('[VISUAL] Requested browser action could not be safely executed; stopping visual loop.');break;}
    }
    return lastUsefulData;
  }catch(error){console.warn('[VISUAL] Intent-driven visual browsing unavailable:',error instanceof Error?error.message:String(error));return lastUsefulData;}
}
