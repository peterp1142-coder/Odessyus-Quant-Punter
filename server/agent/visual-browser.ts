import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';
import { currentVisualSessionId, publishVisual } from './visual-events.js';

const VISUAL_PAGE_READY_TIMEOUT_MS = Math.max(5_000, Math.min(20_000, Number(process.env.VISUAL_PAGE_READY_TIMEOUT_MS || 12_000)));
const VISUAL_PAINT_SETTLE_MS = Math.max(250, Math.min(2_000, Number(process.env.VISUAL_PAINT_SETTLE_MS || 700)));

/**
 * Give client-rendered pages a real chance to paint before taking the frame.
 * `domcontentloaded` is not sufficient for ESPN/365Scores/etc.; their useful
 * content arrives asynchronously after the initial document is parsed.
 */
async function waitForRenderablePage(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => document.readyState === 'interactive' || document.readyState === 'complete',
      { timeout: VISUAL_PAGE_READY_TIMEOUT_MS },
    );
  } catch {
    // Some heavily scripted pages never report complete; continue to the
    // content heuristic rather than failing the visual recovery outright.
  }

  try {
    await page.waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        const text = (body.innerText || '').replace(/\s+/g, ' ').trim();
        const structuralContent = body.querySelector(
          'main, [role="main"], #content, #main, #root, #app, table, article, section',
        );
        return text.length >= 160 || Boolean(structuralContent);
      },
      { timeout: VISUAL_PAGE_READY_TIMEOUT_MS },
    );
  } catch {
    // A blocked/empty page is still useful to Mistral: it can identify the
    // consent/captcha/anti-bot state from the rendered frame.
  }

  // Allow one browser paint cycle after the DOM/content heuristic succeeds.
  await new Promise(resolve => setTimeout(resolve, VISUAL_PAINT_SETTLE_MS));
}

/**
 * Visual recovery reuses the already-open local Chromium page. It is used when
 * the DOM selector is stale or the page structure is ambiguous, not as a
 * source of fabricated facts. The model is shown the screenshot plus compact
 * DOM candidates so it can help rank the live page structure like a human.
 *
 * The screenshot is also published to the authenticated dashboard while this
 * inspection is running. It is deliberately kept out of the durable job trace
 * so a sequence of screenshots cannot bloat MySQL or the agent checkpoint.
 */
export async function inspectPageVisually(
  page: Page,
  hint = '',
  candidateContext = '',
  sessionId = currentVisualSessionId() || '',
): Promise<string> {
  if (process.env.VISUAL_BROWSER_ENABLED === 'false') return '';

  let uploadedFileId: string | undefined;
  try {
    await waitForRenderablePage(page);

    const diagnostics = await page.evaluate(() => ({
      readyState: document.readyState,
      title: document.title || '',
      textLength: (document.body?.innerText || '').trim().length,
      htmlLength: document.documentElement?.outerHTML?.length || 0,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    })).catch(() => ({ readyState: 'unknown', title: '', textLength: 0, htmlLength: 0, viewport: 'unknown' }));

    console.log(
      `[VISUAL] Page ready check: readyState=${diagnostics.readyState} text=${diagnostics.textLength} html=${diagnostics.htmlLength} viewport=${diagnostics.viewport} url=${page.url()}`,
    );

    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 55,
      fullPage: false,
      encoding: 'base64',
    });

    if (sessionId) {
      publishVisual({
        sessionId,
        image: `data:image/jpeg;base64,${screenshot}`,
        url: page.url(),
        hint,
      });
      console.log(`[VISUAL] Live screenshot published to dashboard: ${page.url()}`);
    }

    const prompt = [
      'Inspect this live sports webpage screenshot and its compact DOM context.',
      hint ? `Original selector/hint: ${hint}.` : '',
      candidateContext ? `Candidate DOM extracts:\n${candidateContext}` : '',
      `Browser diagnostics: readyState=${diagnostics.readyState}, visibleTextLength=${diagnostics.textLength}, htmlLength=${diagnostics.htmlLength}, viewport=${diagnostics.viewport}.`,
      'Determine whether the page is a real fixture/odds/sports page, blocked/consent/captcha, or unrelated.',
      'If candidate selectors are supplied, identify the BEST_SELECTOR only when one clearly corresponds to the visible fixture/market content.',
      'Use the selector text exactly as supplied; do not invent class names.',
      'Then extract ONLY text/data visibly present or present in the supplied candidate DOM.',
      'Prioritize fixture names, kickoff times, scores, market/odds labels, and visible navigation.',
      'Do not infer missing values.',
      'If the screenshot is a consent, captcha, login, or anti-bot page, say BLOCKED.',
      'Return concise plain text. If a selector is confidently identified, put `BEST_SELECTOR: <selector>` on its own line.',
    ].filter(Boolean).join('\n');

    const response = await mistralPool.call(async client => {
      const uploaded = await client.files.upload({
        file: {
          fileName: `browser-screenshot-${Date.now()}.jpg`,
          content: Buffer.from(screenshot, 'base64'),
        },
        purpose: 'ocr',
      });
      uploadedFileId = uploaded.id;

      return client.chat.complete({
        model: process.env.VISUAL_BROWSER_MODEL || 'mistral-large-latest',
        temperature: 0,
        maxTokens: 900,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'file', fileId: uploaded.id },
          ],
        }] as any,
      });
    });

    const text = response.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim().slice(0, 7000) : '';
  } catch (error) {
    console.warn('[VISUAL] Screenshot analysis unavailable:', error instanceof Error ? error.message : String(error));
    return '';
  } finally {
    if (uploadedFileId) {
      try {
        const fileId = uploadedFileId;
        await mistralPool.call(client => client.files.delete({ fileId }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/404|not found/i.test(message)) {
          console.warn('[VISUAL] Could not delete temporary screenshot:', message);
        }
      }
    }
  }
}
