import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';

/**
 * Visual recovery reuses the already-open local Chromium page. It is used when
 * the DOM selector is stale or the page structure is ambiguous, not as a
 * source of fabricated facts. The model is shown the screenshot plus compact
 * DOM candidates so it can help rank the live page structure like a human.
 */
export async function inspectPageVisually(
  page: Page,
  hint = '',
  candidateContext = '',
): Promise<string> {
  if (process.env.VISUAL_BROWSER_ENABLED === 'false') return '';

  let uploadedFileId: string | undefined;
  try {
    const screenshot = await page.screenshot({
      type: 'jpeg',
      quality: 55,
      fullPage: false,
      encoding: 'base64',
    });

    const prompt = [
      'Inspect this live sports webpage screenshot and its compact DOM context.',
      hint ? `Original selector/hint: ${hint}.` : '',
      candidateContext ? `Candidate DOM extracts:\n${candidateContext}` : '',
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
        // Mistral may have already reclaimed the short-lived upload. A 404 is
        // harmless and should never pollute the browser recovery logs.
        const message = error instanceof Error ? error.message : String(error);
        if (!/404|not found/i.test(message)) {
          console.warn('[VISUAL] Could not delete temporary screenshot:', message);
        }
      }
    }
  }
}
