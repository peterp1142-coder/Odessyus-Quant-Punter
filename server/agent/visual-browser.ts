import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';
import { currentVisualSessionId, publishVisual, publishVerification, markVerificationResuming } from './visual-events.js';
import { holdVerificationSession, waitForVerificationResume, completeVerificationSession, clearVerificationSession } from './browser-verification.js';

const VISUAL_ACTION_MAX_STEPS = Math.max(2, Math.min(8, Number(process.env.VISUAL_ACTION_MAX_STEPS || 6)));
const VISUAL_ACTION_MAX_WAIT_MS = Math.max(500, Math.min(6000, Number(process.env.VISUAL_ACTION_MAX_WAIT_MS || 5000)));
const VISUAL_ACTION_MIN_WAIT_MS = Math.max(150, Math.min(1000, Number(process.env.VISUAL_ACTION_MIN_WAIT_MS || 350)));
const VISUAL_OBSERVATION_MAX_CHARS = 9000;
const BLANK_PAGE_MAX_OBSERVATIONS = Math.max(2, Math.min(3, Number(process.env.VISUAL_BLANK_MAX_OBSERVATIONS || 2)));
const READY_MIN_CONFIDENCE = Math.max(0.55, Math.min(0.95, Number(process.env.VISUAL_READY_MIN_CONFIDENCE || 0.7)));

type PageState = 'TARGET' | 'PARTIAL' | 'WRONG' | 'ERROR' | 'BLOCKED' | 'LOADING' | 'UNKNOWN';

interface VisualDecision {
  action: 'READY' | 'WAIT' | 'SCROLL' | 'CLICK' | 'NAVIGATE' | 'BLOCKED' | 'STOP';
  pageState?: PageState;
  objectiveSatisfied?: boolean;
  waitMs?: number;
  scrollY?: number;
  selector?: string;
  url?: string;
  reason?: string;
  data?: string;
  challengeType?: string;
  confidence?: number;
}

interface PageDiagnostics {
  readyState: string;
  title: string;
  textLength: number;
  htmlLength: number;
  viewport: string;
  scrollY: number;
  scrollHeight: number;
  url: string;
  pageError: string | null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function extractJson(text: string): VisualDecision | null {
  const candidates = [text.trim(), text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()];
  for (const candidate of candidates) {
    try {
      const p = JSON.parse(candidate) as Partial<VisualDecision>;
      if (!p || typeof p.action !== 'string') continue;
      const action = String(p.action).toUpperCase() as VisualDecision['action'];
      if (!['READY', 'WAIT', 'SCROLL', 'CLICK', 'NAVIGATE', 'BLOCKED', 'STOP'].includes(action)) continue;
      return {
        action,
        pageState: typeof p.pageState === 'string' ? String(p.pageState).toUpperCase() as PageState : undefined,
        objectiveSatisfied: typeof p.objectiveSatisfied === 'boolean' ? p.objectiveSatisfied : undefined,
        waitMs: typeof p.waitMs === 'number' ? p.waitMs : undefined,
        scrollY: typeof p.scrollY === 'number' ? p.scrollY : undefined,
        selector: typeof p.selector === 'string' ? p.selector : undefined,
        url: typeof p.url === 'string' ? p.url : undefined,
        reason: typeof p.reason === 'string' ? p.reason.slice(0, 700) : undefined,
        data: typeof p.data === 'string' ? p.data.slice(0, VISUAL_OBSERVATION_MAX_CHARS) : undefined,
        challengeType: typeof p.challengeType === 'string' ? p.challengeType.slice(0, 200) : undefined,
        confidence: typeof p.confidence === 'number' ? clamp(p.confidence, 0, 1) : undefined,
      };
    } catch {}
  }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const p = JSON.parse(match[0]) as Partial<VisualDecision>;
    const action = String(p.action || '').toUpperCase() as VisualDecision['action'];
    if (!['READY', 'WAIT', 'SCROLL', 'CLICK', 'NAVIGATE', 'BLOCKED', 'STOP'].includes(action)) return null;
    return {
      action,
      pageState: typeof p.pageState === 'string' ? String(p.pageState).toUpperCase() as PageState : undefined,
      objectiveSatisfied: typeof p.objectiveSatisfied === 'boolean' ? p.objectiveSatisfied : undefined,
      waitMs: typeof p.waitMs === 'number' ? p.waitMs : undefined,
      scrollY: typeof p.scrollY === 'number' ? p.scrollY : undefined,
      selector: typeof p.selector === 'string' ? p.selector : undefined,
      url: typeof p.url === 'string' ? p.url : undefined,
      reason: typeof p.reason === 'string' ? p.reason.slice(0, 700) : undefined,
      data: typeof p.data === 'string' ? p.data.slice(0, VISUAL_OBSERVATION_MAX_CHARS) : undefined,
      challengeType: typeof p.challengeType === 'string' ? p.challengeType.slice(0, 200) : undefined,
      confidence: typeof p.confidence === 'number' ? clamp(p.confidence, 0, 1) : undefined,
    };
  } catch {
    return null;
  }
}

async function wait(ms: number) {
  await new Promise(resolve => setTimeout(resolve, clamp(ms, VISUAL_ACTION_MIN_WAIT_MS, VISUAL_ACTION_MAX_WAIT_MS)));
}

async function pageDiagnostics(page: Page): Promise<PageDiagnostics> {
  const base = await page.evaluate(() => ({
    readyState: document.readyState,
    title: document.title || '',
    textLength: (document.body?.innerText || '').trim().length,
    htmlLength: document.documentElement?.outerHTML?.length || 0,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement?.scrollHeight || 0),
    url: location.href,
    bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 12000),
  })).catch(() => ({ readyState: 'unknown', title: '', textLength: 0, htmlLength: 0, viewport: 'unknown', scrollY: 0, scrollHeight: 0, url: page.url(), bodyText: '' }));

  const normalized = `${base.title} ${base.bodyText}`.toLowerCase();
  const pageError = /page not found|404\s*(?:error|not found)?|this page isn't available|we couldn't find|does not exist|not available|error 404/.test(normalized)
    ? 'PAGE_NOT_FOUND_OR_UNAVAILABLE'
    : /access denied|forbidden|too many requests|rate limit exceeded/.test(normalized)
      ? 'ACCESS_DENIED_OR_RATE_LIMITED'
      : null;

  return { ...base, pageError };
}

async function discoverVisibleCandidates(page: Page, hint: string): Promise<Array<{ selector: string; text: string }>> {
  return page.evaluate(h => {
    const elements = Array.from(document.querySelectorAll('main,[role="main"],#content,#main,#root,#app,table,tbody,tr,article,section,nav,button,a,div'));
    const candidates: Array<{ selector: string; text: string; score: number }> = [];
    for (const element of elements) {
      const node = element as HTMLElement;
      const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 40 || text.length > 12000) continue;
      let score = 0;
      if (/\b\d{1,2}:\d{2}\b/.test(text)) score += 3;
      if (/\b(?:vs\.?|v\.)\b/i.test(text)) score += 3;
      if (/\b(?:fixture|match|matches|kickoff|schedule|score|odds|bet|football|soccer)\b/i.test(text)) score += 2;
      if (/\b(?:today|tomorrow|aug|sep|oct|nov|dec|jan|feb|mar|apr|may|jun|jul)\b/i.test(text)) score++;
      if (/\b[1-9]\.[0-9]{2}\b/.test(text)) score += 2;
      if (h && text.toLowerCase().includes(h.toLowerCase())) score++;
      let selector = node.tagName.toLowerCase();
      const id = node.id;
      const className = typeof node.className === 'string' ? node.className.trim() : '';
      if (id && /^[A-Za-z_][\w:-]*$/.test(id)) selector = `#${id}`;
      else if (className) {
        const first = className.split(/\s+/).find(Boolean);
        if (first && /^[A-Za-z_][\w-]*$/.test(first)) selector = `${selector}.${first}`;
      }
      if (score >= 3) candidates.push({ selector, text, score });
    }
    const seen = new Set<string>();
    return candidates
      .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
      .filter(x => !seen.has(x.selector) && seen.add(x.selector))
      .slice(0, 12)
      .map(({ selector, text }) => ({ selector, text: text.slice(0, 1800) }));
  }, hint);
}

async function executeDecision(page: Page, decision: VisualDecision, allowedSelectors: Set<string>): Promise<boolean> {
  switch (decision.action) {
    case 'WAIT':
      await wait(Number(decision.waitMs || 1500));
      return true;
    case 'SCROLL':
      await page.evaluate(dy => window.scrollBy({ top: dy, left: 0, behavior: 'instant' }), clamp(Number(decision.scrollY || 650), -1200, 1600));
      await wait(VISUAL_ACTION_MIN_WAIT_MS);
      return true;
    case 'CLICK':
      if (!decision.selector || !allowedSelectors.has(decision.selector)) return false;
      try {
        const target = await page.$(decision.selector);
        if (!target) return false;
        await target.click({ delay: 60 });
        await wait(VISUAL_ACTION_MIN_WAIT_MS);
        return true;
      } catch {
        return false;
      }
    case 'NAVIGATE': {
      const targetUrl = String(decision.url || '').trim();
      if (!/^https?:\/\//i.test(targetUrl)) return false;
      try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await wait(VISUAL_ACTION_MIN_WAIT_MS);
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function objectiveSatisfied(decision: VisualDecision, diagnostics: PageDiagnostics): boolean {
  return decision.action === 'READY'
    && decision.objectiveSatisfied === true
    && (decision.confidence ?? 0) >= READY_MIN_CONFIDENCE
    && !diagnostics.pageError
    && decision.pageState === 'TARGET';
}

export async function inspectPageVisually(
  page: Page,
  hint = '',
  candidateContext = '',
  sessionId = currentVisualSessionId() || '',
): Promise<string> {
  if (process.env.VISUAL_BROWSER_ENABLED === 'false') return '';

  let lastUsefulData = '';
  let blankObservations = 0;
  let previousSignature = '';
  let taskState = 'No target evidence has been established yet.';
  const actionHistory: string[] = [];

  try {
    for (let step = 0; step < VISUAL_ACTION_MAX_STEPS; step++) {
      const diagnostics = await pageDiagnostics(page);
      const candidates = await discoverVisibleCandidates(page, hint);
      const allowedSelectors = new Set(candidates.map(c => c.selector));
      const liveContext = candidates.map(c => `SELECTOR: ${c.selector}\nTEXT: ${c.text}`).join('\n---\n');
      const mergedContext = [candidateContext, liveContext].filter(Boolean).join('\n=== LIVE CANDIDATES ===\n').slice(0, 14000);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 65, fullPage: false, encoding: 'base64' });

      if (sessionId) publishVisual({ sessionId, image: `data:image/jpeg;base64,${screenshot}`, url: page.url(), hint });

      const signature = `${diagnostics.url}|${diagnostics.readyState}|${diagnostics.textLength}|${diagnostics.htmlLength}|${diagnostics.scrollHeight}|${diagnostics.pageError || ''}|${candidates.map(c => c.selector).join(',')}`;
      const unchanged = signature === previousSignature;
      previousSignature = signature;
      const isBlank = diagnostics.textLength === 0 && candidates.length === 0;
      if (isBlank) blankObservations = unchanged ? blankObservations + 1 : 1;
      else blankObservations = 0;

      console.log(`[VISUAL] Observe step=${step + 1}/${VISUAL_ACTION_MAX_STEPS} state=${taskState} readyState=${diagnostics.readyState} text=${diagnostics.textLength} scroll=${diagnostics.scrollY}/${diagnostics.scrollHeight} pageState=${diagnostics.pageError || 'normal'} blank=${isBlank} unchanged=${unchanged} url=${page.url()}`);

      if (blankObservations >= BLANK_PAGE_MAX_OBSERVATIONS) {
        console.warn(`[VISUAL] Page remained structurally blank for ${blankObservations} unchanged observations; abandoning visual wait and allowing source fallback.`);
        return `[VISUAL_SOURCE_UNAVAILABLE]\nPage remained blank after ${blankObservations} unchanged observations at ${page.url()}`;
      }

      const prompt = [
        'You are the semantic visual browser controller for a sports research agent.',
        'Behave like a careful human: SEE the screenshot, understand what the page means, compare it to the current objective, then decide what to do next.',
        `OBJECTIVE: ${hint || 'find useful football fixture, market, odds, or schedule information on this page'}.`,
        `TASK STATE: ${taskState}`,
        `ACTION HISTORY: ${actionHistory.slice(-6).join(' | ') || 'none'}`,
        'IMPORTANT: A page being football-related is NOT enough to mark READY. READY means the current page actually satisfies the objective and contains usable target evidence.',
        'Classify the current page as TARGET, PARTIAL, WRONG, ERROR, BLOCKED, LOADING, or UNKNOWN.',
        `Browser state: readyState=${diagnostics.readyState}; visibleTextLength=${diagnostics.textLength}; scroll=${diagnostics.scrollY}/${diagnostics.scrollHeight}; title=${diagnostics.title || '(none)'}; URL=${diagnostics.url}; detectedPageError=${diagnostics.pageError || 'none'}; blank=${isBlank}; unchanged=${unchanged}.`,
        mergedContext ? `Visible DOM candidates (supporting evidence only):\n${mergedContext}` : '',
        'If the screenshot shows a 404, Page Not Found, generic landing page, unrelated sport, unrelated fixture, or generic navigation without the requested data, classify it WRONG or ERROR and DO NOT choose READY.',
        'If the exact target data is visible but incomplete, choose PARTIAL and use CLICK/SCROLL/NAVIGATE to continue.',
        'If the page is still loading and the browser state is genuinely changing, choose WAIT. Do not repeatedly wait on a completed, unchanged blank/error page.',
        'If a visible navigation control is required, choose CLICK using EXACTLY a selector from the supplied candidates. Never invent one.',
        'If a different URL is clearly the correct route for the objective, choose NAVIGATE with the exact URL you can see or infer from an actual visible link. Never invent a URL path or ID.',
        'If the page is blocked by CAPTCHA, anti-bot challenge, consent gate, or login wall, choose BLOCKED and identify the challenge type.',
        'CAPTCHA POLICY: detect and classify only. Do not solve, bypass, defeat, or provide automated solving instructions. Use HUMAN_VERIFICATION_REQUIRED as the reason.',
        'Never invent fixtures, odds, times, teams, statistics, selectors, or URLs.',
        'Return ONLY JSON with this schema: {"action":"READY|WAIT|SCROLL|CLICK|NAVIGATE|BLOCKED|STOP","pageState":"TARGET|PARTIAL|WRONG|ERROR|BLOCKED|LOADING|UNKNOWN","objectiveSatisfied":true,"waitMs":1500,"scrollY":700,"selector":"#example","url":"https://example.com","reason":"...","challengeType":"...","confidence":0.0,"data":"..."}.',
        'For READY: objectiveSatisfied MUST be true, pageState MUST be TARGET, confidence MUST be at least 0.70, and data MUST contain the relevant evidence.',
      ].filter(Boolean).join('\n');

      const responseText = await mistralPool.visionComplete({
        model: process.env.VISUAL_BROWSER_MODEL || 'mistral-large-latest',
        prompt,
        imageBase64: screenshot,
        temperature: 0,
        maxTokens: 900,
      });

      const decision = extractJson(responseText);
      if (!decision) {
        console.warn('[VISUAL] Mistral returned no valid semantic browser decision; stopping visual loop safely.');
        break;
      }

      const pageState = decision.pageState || (diagnostics.pageError ? 'ERROR' : 'UNKNOWN');
      taskState = `Page=${pageState}; objectiveSatisfied=${decision.objectiveSatisfied === true}; confidence=${decision.confidence ?? 'unknown'}; reason=${decision.reason || 'none'}`;
      actionHistory.push(`${decision.action}:${decision.reason || pageState}`);
      if (decision.data) lastUsefulData = decision.data;

      console.log(`[VISUAL] Decision action=${decision.action} pageState=${pageState} objective=${decision.objectiveSatisfied === true} confidence=${decision.confidence ?? 'unknown'}${decision.waitMs ? ` wait=${decision.waitMs}ms` : ''}${decision.url ? ` url=${decision.url}` : ''}${decision.selector ? ` selector=${decision.selector}` : ''}${decision.reason ? ` reason=${decision.reason}` : ''}`);

      if (objectiveSatisfied(decision, diagnostics)) {
        if (sessionId) {
          completeVerificationSession(sessionId);
          clearVerificationSession(sessionId);
        }
        return decision.data || lastUsefulData;
      }

      if (decision.action === 'READY') {
        console.warn(`[VISUAL] Rejected premature READY: pageState=${pageState}, objectiveSatisfied=${decision.objectiveSatisfied}, confidence=${decision.confidence}, pageError=${diagnostics.pageError || 'none'}`);
        if (decision.data) lastUsefulData = decision.data;
        if (pageState === 'TARGET' && decision.objectiveSatisfied !== true) {
          taskState = 'Model claimed the page is relevant but failed the objective-completion proof; continue browsing.';
        }
      }

      if (decision.action === 'BLOCKED') {
        const challenge = decision.challengeType && decision.challengeType !== 'none' ? decision.challengeType : 'anti-bot/verification challenge';
        console.warn(`[VISUAL] Human verification required: ${challenge}`);
        if (!sessionId) return `[HUMAN_VERIFICATION_REQUIRED]\nChallenge: ${challenge}\nConfidence: ${decision.confidence != null ? decision.confidence.toFixed(2) : 'unknown'}\nReason: ${decision.reason || 'Verification page detected.'}`;
        const context = page.browserContext();
        holdVerificationSession(sessionId, page, context, () => {}, { challengeType: challenge, reason: decision.reason || 'Verification page detected.' });
        publishVerification(sessionId, {
          image: `data:image/jpeg;base64,${screenshot}`,
          url: page.url(),
          hint,
          verificationType: challenge,
          verificationReason: decision.reason || 'HUMAN_VERIFICATION_REQUIRED',
        });
        const resumed = await waitForVerificationResume(sessionId);
        if (!resumed) return `[HUMAN_VERIFICATION_EXPIRED]\nChallenge: ${challenge}`;
        markVerificationResuming(sessionId);
        lastUsefulData = '';
        blankObservations = 0;
        previousSignature = '';
        taskState = 'Human verification completed; re-evaluate the page from scratch against the objective.';
        continue;
      }

      if (decision.action === 'STOP') break;

      const acted = await executeDecision(page, decision, allowedSelectors);
      if (!acted) {
        console.warn(`[VISUAL] Requested browser action could not be safely executed: ${decision.action}`);
        break;
      }
    }

    return lastUsefulData;
  } catch (error) {
    console.warn('[VISUAL] Intent-driven visual browsing unavailable:', error instanceof Error ? error.message : String(error));
    return lastUsefulData;
  }
}
