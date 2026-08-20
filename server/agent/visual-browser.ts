import type { Page } from 'puppeteer-core';
import { mistralPool } from './mistral-pool.js';

/**
 * Visual recovery is deliberately a last resort: the local Chromium page is
 * already open, so we reuse it rather than launching another browser.
 *
 * The project is pinned to the v1 Mistral TypeScript SDK. That SDK validates
 * multimodal message parts locally and does not accept the newer `image_url`
 * shape that was being passed here. Uploading the compact screenshot and
 * referencing it as a `file` matches the SDK/API contract and also keeps the
 * screenshot off the request body after the call completes.
 */
export async function inspectPageVisually(page: Page, hint = ''): Promise<string> {
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
      'Inspect this live sports webpage screenshot.',
      hint ? `Original selector/hint: ${hint}.` : '',
      'Extract ONLY text/data visibly present in the screenshot.',
      'Prioritize fixture names, kickoff times, scores, market/odds labels, and visible navigation.',
      'Do not infer missing values.',
      'If the screenshot is a consent, captcha, login, or anti-bot page, say BLOCKED.',
      'Return concise plain text.',
    ].filter(Boolean).join(' ');

    const response = await mistralPool.call(async client => {
      // The installed v1 SDK expects a `file` content part with a fileId.
      // Uploading the screenshot also avoids the SDK-side ZodError caused by
      // sending `{ type: "image_url" }` to a schema that only accepts `file`
      // for this multimodal content union.
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
    // Screenshots are disposable recovery artifacts. Delete them promptly so
    // repeated selector recovery cannot accumulate remote files.
    if (uploadedFileId) {
      try {
        const fileId = uploadedFileId;
        await mistralPool.call(client => client.files.delete({ fileId }));
      } catch (error) {
        console.warn('[VISUAL] Could not delete temporary screenshot:', error instanceof Error ? error.message : String(error));
      }
    }
  }
}
