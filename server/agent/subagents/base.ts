/**
 * runSubAgent — the core ReAct loop for all specialist subagents.
 *
 * Safety/quality guarantees:
 *  - Fixture-scoped context isolation for multi-match runs.
 *  - Strict rejection of placeholder / synthetic URLs and tool names.
 *  - No invented values, averages or "fallback facts" when evidence is absent.
 *  - Explicitly marks unavailable fields instead of manufacturing them.
 */

import { dispatchTool } from '../tools.js';
import type { ReActStep } from '../react-engine.js';
import { mistralPool } from '../mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../checkpoint.js';

export interface SubAgentResult {
  agentName: string;
  success: boolean;
  partial?: boolean;
  data: Record<string, unknown>;
  steps: ReActStep[];
  rawOutput: string;
  error?: string;
  toolErrors?: string[];
}

type MsgRole = 'user' | 'assistant' | 'system';
interface Msg { role: MsgRole; content: string; }

const CHANGE_APPROACH_HINTS: Record<string, string> = {
  scrape:              'Switch from scrape to fetch_url, or use serper_search / talordata_search to find the data. Never re-scrape the same blocked URL.',
  fetch_url:           'Switch from fetch_url to serper_search or talordata_search, or try a completely different URL from your priority list.',
  web_search:          'Try serper_search or talordata_search instead, or reformulate query with shorter team names and a site: operator.',
  talordata_search:    'Try serper_search (different Google backend) or reformulate: fewer words, different angle, or fall back to fetch_url.',
  serper_search:       'Try talordata_search with a different query, or fetch_url with a direct sports-data URL (fbref, understat, sofascore).',
  allsports_fixtures:  'Try fetch_matches_today or serper_search as a fallback for fixture data.',
  allsports_livescore: 'Try scrape_flashscore or fetch_matches_today for live match data.',
};

const INVALID_TOOL_NAME_PATTERNS = [
  /excluded\s+from\s+analysis/i,
  /waiting/i,
  /proceeding/i,
  /final\s+json/i,
  /^fallback$/i,
  /action\s+input/i,
];

function buildChangeApproachMessage(
  consecutiveErrors: number,
  failedTools: string[],
  triedSources: string[],
  remainingIter: number,
): string {
  const toolHints = [...new Set(failedTools)]
    .map(t => CHANGE_APPROACH_HINTS[t] || 'Try a completely different source and tool.')
    .join(' ');
  return `⚠️ MANDATORY STRATEGY CHANGE (${consecutiveErrors} consecutive failures):
FAILED SOURCES — do NOT retry any of these: ${triedSources.slice(-8).join(' | ')}
${toolHints}
You have ${remainingIter} iteration(s) remaining. Each must use a NEW source or query.
If you genuinely cannot gather data, output SUBAGENT_DONE now. DO NOT invent or estimate missing factual fields.`;
}

function extractTargetFixture(task: string): string | null {
  const patterns = [
    /(?:for|about)\s*:\s*([^\n]+?)(?:\s*\([^\n]+\))?(?:\n|$)/i,
    /fixture\s*=\s*([^\n]+)/i,
    /\[([^\]]+\s+vs\.?\s+[^\]]+)\]/i,
  ];
  for (const pattern of patterns) {
    const m = task.match(pattern);
    const value = m?.[1]?.trim();
    if (value && /\s+(?:vs\.?|v\.?)\s+/i.test(value)) return value;
  }
  return null;
}

function normalizeFixture(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').replace(/\s*(?:vs\.?|v\.?)\s*/g, ' vs ').trim();
}

/**
 * Multi-fixture orchestrator output is wrapped as:
 *   === Team A vs Team B ===\n...
 *   === Team C vs Team D ===\n...
 * Remove other fixture blocks before the specialist sees prior context.
 */
function isolateFixtureContext(task: string, targetFixture: string | null): string {
  if (!targetFixture) return task;
  const normalizedTarget = normalizeFixture(targetFixture);
  const marker = /===\s*([^=\n]+?\s+vs\.?\s+[^=\n]+?)\s*===/gi;
  const matches = [...task.matchAll(marker)];
  if (!matches.length) return task;

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? task.length) : task.length;
    const fixture = normalizeFixture(matches[i][1]);
    if (fixture === normalizedTarget) sections.push(task.slice(start, end));
  }

  if (!sections.length) {
    // Keep the task's own instruction, discard unrelated multi-fixture result blocks.
    const firstMarker = matches[0].index ?? task.length;
    return `${task.slice(0, firstMarker).trim()}\n\n=== FIXTURE-ISOLATED PRIOR CONTEXT ===\nNo prior result block was retained because it did not match the requested fixture.`;
  }

  const instructionEnd = matches[0].index ?? 0;
  return `${task.slice(0, instructionEnd).trim()}\n\n=== FIXTURE-ISOLATED PRIOR CONTEXT ===\n${sections.join('\n')}`;
}

function containsPlaceholderUrl(input: Record<string, unknown>): boolean {
  const values = [input.url, input.query].filter(Boolean).map(String);
  return values.some(v => /123456|placeholder|example\.com|<[^>]+>|\.{3,}|\/goto\?url=/i.test(v));
}

function qualityGuardInstruction(agentName: string, fixture: string | null): string {
  const fixtureText = fixture ? ` The ONLY fixture you are allowed to research is: ${fixture}.` : '';
  return `QUALITY GATE FOR ${agentName.toUpperCase()}:${fixtureText}
- Never transfer facts, teams, players, sources, injuries, weather, odds or referee data from another fixture.
- Never invent a value because a source is missing. Use null/unavailable and explain why.
- Never use generic league/UEFA averages as if they were the assigned referee's actual statistics.
- Never use placeholder URLs, IDs, synthetic paths, or guessed entity identifiers.
- Never output a draft as final evidence when it contains placeholder values.
- If a tool cannot verify a fact, stop trying to manufacture it and mark it unavailable.
- A valid JSON object is not evidence by itself; every factual field must be traceable to a tool observation or clearly marked unavailable.`;
}

export async function runSubAgent(opts: {
  agentName: string;
  systemPrompt: string;
  task: string;
  sessionId?: string;
  maxIterations?: number;
  prefix?: string;
  onStep: (step: ReActStep) => void;
}): Promise<SubAgentResult> {
  const {
    agentName,
    systemPrompt,
    task,
    sessionId = 'default',
    maxIterations = 8,
    prefix = '',
    onStep,
  } = opts;

  const targetFixture = extractTargetFixture(task);
  const isolatedTask = isolateFixtureContext(task, targetFixture);
  const guardedSystemPrompt = `${systemPrompt}\n\n${qualityGuardInstruction(agentName, targetFixture)}`;

  const steps: ReActStep[] = [];
  const toolErrors: string[] = [];
  const now = () => new Date().toISOString();
  const triedHashes = new Set<string>();

  const emit = (step: ReActStep): ReActStep => {
    const s = { ...step, content: prefix ? `[${prefix}] ${step.content}` : step.content, timestamp: now() };
    steps.push(s);
    onStep(s);
    return s;
  };

  const existing = await loadCheckpoint(sessionId, agentName);
  let messages: Msg[];
  let startIteration: number;
  let rawOutput: string;
  let accumulatedData: Record<string, unknown>;

  if (existing && existing.iteration < maxIterations - 1) {
    emit({ type: 'status', content: `Resuming from checkpoint @ iteration ${existing.iteration}` });
    for (const s of existing.steps as ReActStep[]) steps.push(s);
    messages = existing.messages as Msg[];
    startIteration = existing.iteration;
    rawOutput = existing.rawOutput;
    accumulatedData = existing.accumulatedData || {};
  } else {
    messages = [
      { role: 'system', content: guardedSystemPrompt },
      { role: 'user',   content: isolatedTask },
    ];
    startIteration = 0;
    rawOutput = '';
    accumulatedData = {};
  }

  let consecutiveErrors = 0;
  const triedSources: string[] = [];
  const failedToolNames: string[] = [];

  try {
    for (let i = startIteration; i < maxIterations; i++) {
      const resp = await mistralPool.call(client =>
        client.chat.complete({
          model: 'mistral-large-latest',
          messages: messages as any,
          temperature: 0.1,
          maxTokens: 2500,
        })
      );

      const content = resp.choices?.[0]?.message?.content || '';
      if (typeof content !== 'string' || !content.trim()) break;
      rawOutput = content;

      if (content.includes('SUBAGENT_DONE:')) {
        const idx = content.indexOf('SUBAGENT_DONE:');
        rawOutput = content.substring(idx + 14).trim();
        emit({ type: 'synthesis', content: `${agentName} complete`, iteration: i + 1 });
        break;
      }

      const thoughtM = content.match(/Thought:\s*([\s\S]*?)(?=Action:|SUBAGENT_DONE:|$)/i);
      const actionM  = content.match(/Action:\s*([^\n]+)/i);
      const inputM   = content.match(/Action Input:\s*([\s\S]*?)(?=Thought:|Action:|SUBAGENT_DONE:|$)/i);

      const thought  = thoughtM?.[1]?.trim() || '';
      const toolName = (actionM?.[1]?.trim() || '').replace(/^[*`]+|[*`]+$/g, '').trim();
      const rawInput = inputM?.[1]?.trim() || '{}';

      if (thought) emit({ type: 'thought', content: thought, iteration: i + 1 });

      if (!toolName) {
        rawOutput = content;
        emit({ type: 'synthesis', content: `${agentName} complete`, iteration: i + 1 });
        break;
      }

      if (INVALID_TOOL_NAME_PATTERNS.some(pattern => pattern.test(toolName))) {
        consecutiveErrors++;
        toolErrors.push(`${toolName}: invalid/non-tool action text`);
        emit({ type: 'error', content: `Ignored invalid tool action text: ${toolName}`, iteration: i + 1 });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: `"${toolName}" is not a tool. Stop acting and output SUBAGENT_DONE with verified data only. Do not invent fallback values.` });
        break;
      }

      let toolInput: Record<string, unknown> = {};
      try {
        const clean = rawInput.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        toolInput = JSON.parse(clean);
      } catch {
        const urlM = rawInput.match(/"url"\s*:\s*"([^"]+)"/);
        const qM   = rawInput.match(/"query"\s*:\s*"([^"]+)"/);
        const selM = rawInput.match(/"selector"\s*:\s*"([^"]+)"/);
        if (urlM) toolInput.url      = urlM[1];
        if (qM)   toolInput.query    = qM[1];
        if (selM) toolInput.selector = selM[1];
        if (!Object.keys(toolInput).length) toolInput.query = rawInput.replace(/[{}\"]/g, '').trim();
      }

      if (containsPlaceholderUrl(toolInput)) {
        consecutiveErrors++;
        const sourceKey = String(toolInput.url || toolInput.query || '').substring(0, 150);
        toolErrors.push(`${toolName}: placeholder/synthetic source rejected`);
        emit({ type: 'error', content: `Rejected placeholder/synthetic source: ${sourceKey}`, iteration: i + 1 });
        messages.push({ role: 'assistant', content });
        messages.push({ role: 'user', content: 'That source contains a placeholder/synthetic URL or unresolved entity ID. Do not retry it. Use a real URL discovered from a tool result or output the field as unavailable.' });
        continue;
      }

      const sourceKey = String(toolInput.url || toolInput.query || '').substring(0, 150);
      const callHash  = `${toolName}:${sourceKey}`;
      if (triedHashes.has(callHash)) {
        emit({ type: 'status', content: `Skipping duplicate call: ${callHash.substring(0, 80)}`, iteration: i + 1 });
        messages.push({ role: 'user', content: `You already tried "${sourceKey}" — use a DIFFERENT source or query.` });
        consecutiveErrors++;
        continue;
      }
      triedHashes.add(callHash);
      if (sourceKey) triedSources.push(sourceKey);

      emit({ type: 'action', content: `→ ${toolName}`, toolName, toolInput, iteration: i + 1 });
      const result = await dispatchTool(toolName, toolInput);

      let obs: string;
      if (result.success && !result.blocked) {
        obs = (result.data || 'Empty result').substring(0, 6000);
        consecutiveErrors = 0;
        failedToolNames.length = 0;
      } else {
        consecutiveErrors++;
        failedToolNames.push(toolName);
        toolErrors.push(`${toolName}: ${result.error || 'blocked'}`);
        if (result.blocked) obs = `BLOCKED (${consecutiveErrors}): Anti-bot wall on "${sourceKey}". Do NOT retry this source.`;
        else obs = `ERROR (${consecutiveErrors}): ${result.error || 'unknown'} — source: "${sourceKey}". Do NOT retry.`;
      }

      emit({
        type: 'observation',
        content: obs.substring(0, 800) + (obs.length > 800 ? '…' : ''),
        iteration: i + 1,
      });

      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `Observation: ${obs}` });

      if (consecutiveErrors >= 2) {
        const remaining = maxIterations - i - 1;
        if (consecutiveErrors >= 3 || remaining <= 1) {
          emit({ type: 'status', content: `⚠️ ${agentName}: ${consecutiveErrors} failures — forcing wrap-up.` });
          messages.push({ role: 'user', content: `You have ${consecutiveErrors} consecutive errors and only ${remaining} iteration(s) left. STOP using tools. Output SUBAGENT_DONE with verified data only; set unavailable fields to null.` });
        } else {
          const hint = buildChangeApproachMessage(consecutiveErrors, failedToolNames, triedSources, remaining);
          emit({ type: 'status', content: `🔄 ${agentName}: strategy change injection (${consecutiveErrors} errors)` });
          messages.push({ role: 'user', content: hint });
        }
      }

      await saveCheckpoint({
        sessionId, agentName, messages,
        iteration: i + 1, steps: [...steps],
        rawOutput, accumulatedData,
        savedAt: Date.now(), version: 4,
      });
    }

    const hasDone  = rawOutput.includes('SUBAGENT_DONE:');
    const hasJson  = /\{[\s\S]+\}/.test(rawOutput);
    if (!hasDone && !hasJson && messages.length > 2) {
      try {
        emit({ type: 'status', content: `${agentName}: iteration budget exhausted — forcing wrap-up synthesis.` });
        messages.push({ role: 'user', content: `Iteration budget fully exhausted. Stop using tools. Output SUBAGENT_DONE followed by JSON only. Set unavailable fields to null. Never invent values or use generic fallbacks.` });
        const wrapResp = await mistralPool.call(client =>
          client.chat.complete({ model: 'mistral-large-latest', messages: messages as any, temperature: 0.0, maxTokens: 1500 })
        );
        const wrapContent = wrapResp.choices?.[0]?.message?.content;
        if (typeof wrapContent === 'string' && wrapContent) {
          rawOutput = wrapContent;
          if (wrapContent.includes('SUBAGENT_DONE:')) rawOutput = wrapContent.substring(wrapContent.indexOf('SUBAGENT_DONE:') + 14).trim();
        }
      } catch { /* fall through */ }
    }

    let data: Record<string, unknown> = {};
    try {
      const jsonMatch = rawOutput.match(/```json\s*([\s\S]+?)\s*```/) || rawOutput.match(/(\{[\s\S]+\})/);
      if (jsonMatch) data = JSON.parse(jsonMatch[1]);
    } catch {
      data = { raw: rawOutput };
    }

    const merged = { ...accumulatedData, ...data };
    const hadErrors = toolErrors.length > 0;
    await clearCheckpoint(sessionId, agentName);

    return {
      agentName,
      success: true,
      partial: hadErrors && Object.keys(data).length > 0,
      data: merged,
      steps,
      rawOutput,
      toolErrors: hadErrors ? toolErrors : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', content: `${agentName} error: ${msg}` });
    return { agentName, success: false, data: {}, steps, rawOutput: '', error: msg, toolErrors };
  }
}
