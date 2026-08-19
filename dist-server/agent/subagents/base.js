/**
 * runSubAgent — the core ReAct loop for all specialist subagents.
 *
 * v2 Upgrades:
 *  - Upgraded model: mistral-large-latest (highest accuracy)
 *  - maxIterations increased to 8 (more data gathering per agent)
 *  - Smarter duplicate detection (hash-based URL/query deduplication)
 *  - Better change-approach injection with tool-specific hints
 *  - Observation truncation increased to 6000 chars for richer data
 */
import { dispatchTool } from '../tools.js';
import { mistralPool } from '../mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from '../checkpoint.js';
const CHANGE_APPROACH_HINTS = {
    scrape: 'Switch from scrape to fetch_url, or use serper_search / talordata_search to find the data. Never re-scrape the same blocked URL.',
    fetch_url: 'Switch from fetch_url to serper_search or talordata_search, or try a completely different URL from your priority list.',
    web_search: 'Try serper_search or talordata_search instead, or reformulate query with shorter team names and a site: operator.',
    talordata_search: 'Try serper_search (different Google backend) or reformulate: fewer words, different angle, or fall back to fetch_url.',
    serper_search: 'Try talordata_search with a different query, or fetch_url with a direct sports-data URL (fbref, understat, sofascore).',
    allsports_fixtures: 'Try fetch_matches_today or serper_search as a fallback for fixture data.',
    allsports_livescore: 'Try scrape_flashscore or fetch_matches_today for live match data.',
};
function buildChangeApproachMessage(consecutiveErrors, failedTools, triedSources, remainingIter) {
    const toolHints = [...new Set(failedTools)]
        .map(t => CHANGE_APPROACH_HINTS[t] || 'Try a completely different source and tool.')
        .join(' ');
    return `⚠️ MANDATORY STRATEGY CHANGE (${consecutiveErrors} consecutive failures):
FAILED SOURCES — do NOT retry any of these: ${triedSources.slice(-8).join(' | ')}
${toolHints}
You have ${remainingIter} iteration(s) remaining. Each must use a NEW source or query.
If you genuinely cannot gather data, output SUBAGENT_DONE now with whatever you have and mark fields as "unavailable".`;
}
export async function runSubAgent(opts) {
    const { agentName, systemPrompt, task, sessionId = 'default', maxIterations = 8, prefix = '', onStep, } = opts;
    const steps = [];
    const toolErrors = [];
    const now = () => new Date().toISOString();
    const triedHashes = new Set(); // prevent exact duplicate calls
    const emit = (step) => {
        const s = { ...step, content: prefix ? `[${prefix}] ${step.content}` : step.content, timestamp: now() };
        steps.push(s);
        onStep(s);
        return s;
    };
    // ── Checkpoint: try to resume ────────────────────────────────────────────
    const existing = await loadCheckpoint(sessionId, agentName);
    let messages;
    let startIteration;
    let rawOutput;
    let accumulatedData;
    if (existing && existing.iteration < maxIterations - 1) {
        emit({ type: 'status', content: `Resuming from checkpoint @ iteration ${existing.iteration}` });
        for (const s of existing.steps)
            steps.push(s);
        messages = existing.messages;
        startIteration = existing.iteration;
        rawOutput = existing.rawOutput;
        accumulatedData = existing.accumulatedData || {};
    }
    else {
        messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task },
        ];
        startIteration = 0;
        rawOutput = '';
        accumulatedData = {};
    }
    // ── Error tracking ────────────────────────────────────────────────────────
    let consecutiveErrors = 0;
    const triedSources = [];
    const failedToolNames = [];
    try {
        for (let i = startIteration; i < maxIterations; i++) {
            const resp = await mistralPool.call(client => client.chat.complete({
                model: 'mistral-large-latest',
                messages: messages,
                temperature: 0.1,
                maxTokens: 2500,
            }));
            const content = resp.choices?.[0]?.message?.content || '';
            if (typeof content !== 'string' || !content.trim())
                break;
            rawOutput = content;
            // ── Check for SUBAGENT_DONE ──────────────────────────────────────────
            if (content.includes('SUBAGENT_DONE:')) {
                const idx = content.indexOf('SUBAGENT_DONE:');
                rawOutput = content.substring(idx + 14).trim();
                emit({ type: 'synthesis', content: `${agentName} complete`, iteration: i + 1 });
                break;
            }
            // ── Parse Thought / Action / Action Input ────────────────────────────
            const thoughtM = content.match(/Thought:\s*([\s\S]*?)(?=Action:|SUBAGENT_DONE:|$)/i);
            const actionM = content.match(/Action:\s*([^\n]+)/i);
            const inputM = content.match(/Action Input:\s*([\s\S]*?)(?=Thought:|Action:|SUBAGENT_DONE:|$)/i);
            const thought = thoughtM?.[1]?.trim() || '';
            // Strip markdown bold (**tool**), backticks, and stray asterisks that the
            // LLM sometimes wraps around tool names, e.g. "Action: **scrape**".
            const toolName = (actionM?.[1]?.trim() || '').replace(/^[*`]+|[*`]+$/g, '').trim();
            const rawInput = inputM?.[1]?.trim() || '{}';
            if (thought)
                emit({ type: 'thought', content: thought, iteration: i + 1 });
            if (!toolName) {
                rawOutput = content;
                emit({ type: 'synthesis', content: `${agentName} complete`, iteration: i + 1 });
                break;
            }
            // ── Parse tool input ─────────────────────────────────────────────────
            let toolInput = {};
            try {
                const clean = rawInput.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
                toolInput = JSON.parse(clean);
            }
            catch {
                const urlM = rawInput.match(/"url"\s*:\s*"([^"]+)"/);
                const qM = rawInput.match(/"query"\s*:\s*"([^"]+)"/);
                const selM = rawInput.match(/"selector"\s*:\s*"([^"]+)"/);
                if (urlM)
                    toolInput.url = urlM[1];
                if (qM)
                    toolInput.query = qM[1];
                if (selM)
                    toolInput.selector = selM[1];
                if (!Object.keys(toolInput).length)
                    toolInput.query = rawInput.replace(/[{}"]/g, '').trim();
            }
            // Deduplication check
            const sourceKey = String(toolInput.url || toolInput.query || '').substring(0, 150);
            const callHash = `${toolName}:${sourceKey}`;
            if (triedHashes.has(callHash)) {
                emit({ type: 'status', content: `Skipping duplicate call: ${callHash.substring(0, 80)}`, iteration: i + 1 });
                messages.push({ role: 'user', content: `You already tried "${sourceKey}" — use a DIFFERENT source or query.` });
                consecutiveErrors++;
                continue;
            }
            triedHashes.add(callHash);
            if (sourceKey)
                triedSources.push(sourceKey);
            emit({ type: 'action', content: `→ ${toolName}`, toolName, toolInput, iteration: i + 1 });
            // ── Dispatch tool ─────────────────────────────────────────────────────
            const result = await dispatchTool(toolName, toolInput);
            let obs;
            if (result.success && !result.blocked) {
                obs = (result.data || 'Empty result').substring(0, 6000);
                consecutiveErrors = 0;
                failedToolNames.length = 0;
            }
            else {
                consecutiveErrors++;
                failedToolNames.push(toolName);
                toolErrors.push(`${toolName}: ${result.error || 'blocked'}`);
                if (result.blocked) {
                    obs = `BLOCKED (${consecutiveErrors}): Anti-bot wall on "${sourceKey}". Do NOT retry this source.`;
                }
                else {
                    obs = `ERROR (${consecutiveErrors}): ${result.error || 'unknown'} — source: "${sourceKey}". Do NOT retry.`;
                }
            }
            emit({
                type: 'observation',
                content: obs.substring(0, 800) + (obs.length > 800 ? '…' : ''),
                iteration: i + 1,
            });
            messages.push({ role: 'assistant', content });
            messages.push({ role: 'user', content: `Observation: ${obs}` });
            // ── Inject CHANGE APPROACH directive after 2+ consecutive errors ─────
            if (consecutiveErrors >= 2) {
                const remaining = maxIterations - i - 1;
                if (consecutiveErrors >= 3 || remaining <= 1) {
                    emit({ type: 'status', content: `⚠️ ${agentName}: ${consecutiveErrors} failures — forcing wrap-up.` });
                    messages.push({
                        role: 'user',
                        content: `You have ${consecutiveErrors} consecutive errors and only ${remaining} iteration(s) left.
STOP using tools immediately. Output SUBAGENT_DONE with your best estimates using all data gathered so far.
Mark unavailable fields as null. Include a "data_unavailable_reason" note in sources_used.`,
                    });
                }
                else {
                    const hint = buildChangeApproachMessage(consecutiveErrors, failedToolNames, triedSources, remaining);
                    emit({ type: 'status', content: `🔄 ${agentName}: strategy change injection (${consecutiveErrors} errors)` });
                    messages.push({ role: 'user', content: hint });
                }
            }
            // ── Checkpoint after every iteration ─────────────────────────────────
            await saveCheckpoint({
                sessionId, agentName, messages,
                iteration: i + 1, steps: [...steps],
                rawOutput, accumulatedData,
                savedAt: Date.now(), version: 3,
            });
        }
        // ── Forced synthesis if loop exhausted without SUBAGENT_DONE ───────────
        // If the last LLM response was another tool call (not a done signal),
        // make one final call to force the agent to wrap up gracefully.
        const hasDone = rawOutput.includes('SUBAGENT_DONE:');
        const hasJson = /\{[\s\S]+\}/.test(rawOutput);
        if (!hasDone && !hasJson && messages.length > 2) {
            try {
                emit({ type: 'status', content: `${agentName}: iteration budget exhausted — forcing wrap-up synthesis.` });
                messages.push({
                    role: 'user',
                    content: `Iteration budget fully exhausted. You MUST stop using tools immediately.
Output SUBAGENT_DONE: followed by a JSON object with all data you have gathered so far.
Set unavailable fields to null. Include a "partial": true flag.`,
                });
                const wrapResp = await mistralPool.call(client => client.chat.complete({
                    model: 'mistral-large-latest',
                    messages: messages,
                    temperature: 0.0,
                    maxTokens: 1500,
                }));
                const wrapContent = wrapResp.choices?.[0]?.message?.content;
                if (typeof wrapContent === 'string' && wrapContent) {
                    rawOutput = wrapContent;
                    if (wrapContent.includes('SUBAGENT_DONE:')) {
                        const idx = wrapContent.indexOf('SUBAGENT_DONE:');
                        rawOutput = wrapContent.substring(idx + 14).trim();
                    }
                }
            }
            catch { /* synthesis failed — fall through with whatever rawOutput we have */ }
        }
        // ── Parse structured output ───────────────────────────────────────────
        let data = {};
        try {
            const jsonMatch = rawOutput.match(/```json\s*([\s\S]+?)\s*```/) || rawOutput.match(/(\{[\s\S]+\})/);
            if (jsonMatch)
                data = JSON.parse(jsonMatch[1]);
        }
        catch {
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', content: `${agentName} error: ${msg}` });
        return { agentName, success: false, data: {}, steps, rawOutput: '', error: msg, toolErrors };
    }
}
//# sourceMappingURL=base.js.map