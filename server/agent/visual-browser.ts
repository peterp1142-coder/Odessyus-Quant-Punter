import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';

/**
 * Visual recovery is deliberately a last resort: the local Chromium page is
 * already open, so we reuse it rather than launching another browser. Mistral
 * receives only a compact screenshot and is asked to read visible fixture data
 * and navigation cues. It never supplies fabricated odds or facts.
 */
export async function inspectPageVisually(page: Page, hint = ''): Promise<string> {
  if (process.env.VISUAL_BROWSER_ENABLED === 'false') return '';
  try {
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false, encoding: 'base64' });
    const image = `data:image/jpeg;base64,${screenshot}`;
    const response = await mistralPool.call(client => client.chat.complete({
      model: process.env.VISUAL_BROWSER_MODEL || 'mistral-large-latest',
      temperature: 0,
      maxTokens: 900,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: `Inspect this live sports webpage screenshot. ${hint ? `Original selector/hint: ${hint}.` : ''} Extract ONLY text/data visibly present in the screenshot. Prioritize fixture names, kickoff times, scores, market/odds labels, and visible navigation. Do not infer missing values. If the screenshot is a consent, captcha, login, or anti-bot page, say BLOCKED. Return concise plain text.` },
          { type: 'image_url', image_url: image },
        ],
      }] as any,
    }));
    const text = response.choices?.[0]?.message?.content;
    return typeof text === 'string' ? text.trim().slice(0, 7000) : '';
  } catch (error) {
    console.warn('[VISUAL] Screenshot analysis unavailable:', error instanceof Error ? error.message : String(error));
    return '';
  }
}
