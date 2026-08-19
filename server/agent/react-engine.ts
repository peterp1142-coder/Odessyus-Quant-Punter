import { buildSystemPrompt } from './prompts.js';
import { dispatchTool } from './tools.js';
import { mistralPool } from './mistral-pool.js';
import { saveCheckpoint, loadCheckpoint, clearCheckpoint } from './checkpoint.js';

export interface ReActStep {
  type: 'thought' | 'action' | 'observation' | 'synthesis' | 'error' | 'status';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  iteration?: number;
  timestamp?: string;
}

export interface ReActResult {
  steps: ReActStep[];
  finalAnswer: string;
  success: boolean;
  error?: string;
}

type MessageRole = 'user' | 'assistant' | 'system';
interface ChatMessage { role: MessageRole; content: string; }

const MAX_ITERATIONS = 12;
const AGENT_NAME     = 'ReActMain';

function ts(): string { return new Date().toISOString(); }

function parseReActResponse(content: string): {
  type: 'action' | 'final' | 'ambiguous';
  thought: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  finalContent?: string;
} {
  const trimmed = content.trim();

  if (trimmed.includes('FINAL_ANSWER:')) {
    const idx = trimmed.indexOf('FINAL_ANSWER:');
    return { type: 'final', thought: '', finalContent: trimmed.substring(idx + 13).trim() };
  }

  const thoughtMatch = trimmed.match(/Thought:\s*([\s\S]*?)(?=Action:|$)/i);
  const actionMatch  = trimmed.match(/Action:\s*([^\n]+)/i);
  const inputMatch   = trimmed.match(/Action Input:\s*([\s\S]*?)(?=Thought:|Action:|FINAL_ANSWER:|$)/i);

  const thought   = thoughtMatch?.[1]?.trim() || '';
  // Strip markdown bold (**tool**), backticks (`tool`), and stray asterisks
  // that the LLM sometimes wraps around the tool name.
  const rawAction = (actionMatch?.[1]?.trim() || '').replace(/^[*`]+|[*`]+$/g, '').trim();
  const rawInput  = inputMatch?.[1]?.trim()   || '{}';

  if (!rawAction) {
    if (trimmed.length > 300) return { type: 'final', thought, finalContent: trimmed };
    return { type: 'ambiguous', thought };
  }

  let toolInput: Record<string, unknown> = {};
  try {
    const clean = rawInput.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    toolInput = JSON.parse(clean);
  } catch {
    const urlM   = rawInput.match(/"url"\s*:\s*"([^"]+)"/);
    const queryM = rawInput.match(/"query"\s*:\s*"([^"]+)"/);
    const selM   = rawInput.match(/"selector"\s*:\s*"([^"]+)"/);
    if (urlM)   toolInput.url      = urlM[1];
    if (queryM) toolInput.query    = queryM[1];
    if (selM)   toolInput.selector = selM[1];
    if (!Object.keys(toolInput).length) {
      const bare = rawInput.replace(/[{}'"]/g, '').trim();
      if (bare.startsWith('http')) toolInput.url = bare;
      else toolInput.query = bare;
    }
  }

  return { type: 'action', thought, toolName: rawAction, toolInput };
}

export async function runReActLoop(
  userQuery: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  conversationHistory: ChatMessage[] = [],
): Promise<ReActResult> {
  const steps: ReActStep[] = [];

  const emit = (step: ReActStep): ReActStep => {
    const s = { ...step, timestamp: ts() };
    steps.push(s);
    onStep(s);
    return s;
  };

  const poolStatus = mistralPool.status();
  emit({ type: 'status', content: `🔍 Odessyus initializing — ${poolStatus.total} key(s) in pool (${poolStatus.available} available)…` });

  // ── Checkpoint: try to resume ──────────────────────────────────────────
  const existing = await loadCheckpoint(sessionId, AGENT_NAME);
  let messages: ChatMessage[];
  let startIteration: number;

  if (existing && existing.iteration < MAX_ITERATIONS - 1) {
    emit({ type: 'status', content: `Resuming ReAct from checkpoint @ iteration ${existing.iteration}` });
    for (const s of existing.steps as ReActStep[]) steps.push(s);
    messages = existing.messages as ChatMessage[];
    startIteration = existing.iteration;
  } else {
    messages = [
      { role: 'system', content: buildSystemPrompt() },
      ...conversationHistory.slice(-8),
      { role: 'user',   content: userQuery },
    ];
    startIteration = 0;
  }

  try {
    let iteration = startIteration;

    while (iteration < MAX_ITERATIONS) {
      iteration++;
      emit({ type: 'status', content: `🔄 ReAct iteration ${iteration}/${MAX_ITERATIONS} — gathering feature vectors…` });

      const response = await mistralPool.call(client =>
        client.chat.complete({
          model: 'mistral-large-latest',
          messages: messages as any,
          temperature: 0.15,
          maxTokens: 3500,
        })
      );

      const assistantContent = response.choices?.[0]?.message?.content || '';
      if (typeof assistantContent !== 'string' || !assistantContent.trim()) {
        emit({ type: 'error', content: 'Empty model response.', iteration });
        break;
      }

      const parsed = parseReActResponse(assistantContent);

      if (parsed.type === 'final') {
        emit({ type: 'synthesis', content: parsed.finalContent || assistantContent, iteration });
        await clearCheckpoint(sessionId, AGENT_NAME);
        return { steps, finalAnswer: parsed.finalContent || assistantContent, success: true };
      }

      if (parsed.type === 'ambiguous') {
        emit({ type: 'synthesis', content: assistantContent, iteration });
        await clearCheckpoint(sessionId, AGENT_NAME);
        return { steps, finalAnswer: assistantContent, success: true };
      }

      // Action step
      if (parsed.thought) emit({ type: 'thought', content: parsed.thought, iteration });

      if (!parsed.toolName) {
        emit({ type: 'error', content: 'No tool specified.', iteration });
        break;
      }

      emit({ type: 'action', content: `Calling ${parsed.toolName}`, toolName: parsed.toolName, toolInput: parsed.toolInput, iteration });

      const toolResult = await dispatchTool(parsed.toolName, parsed.toolInput || {});
      let observationText: string;
      if (toolResult.success) {
        observationText = toolResult.data || 'Tool returned empty result.';
      } else if (toolResult.blocked) {
        observationText = `BLOCKED: Anti-bot wall detected. ${toolResult.error}. Rotate to alternative source from the dictionary.`;
      } else {
        observationText = `ERROR: ${toolResult.error || 'Tool failed.'}`;
      }

      emit({
        type: 'observation',
        content: observationText.length > 2000 ? observationText.substring(0, 2000) + '…[truncated]' : observationText,
        iteration,
      });

      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({ role: 'user',      content: `Observation: ${observationText.substring(0, 6000)}` });

      // ── Checkpoint after each iteration ─────────────────────────────
      await saveCheckpoint({
        sessionId, agentName: AGENT_NAME, messages, iteration,
        steps: [...steps], rawOutput: assistantContent,
        accumulatedData: {}, savedAt: Date.now(), version: 2,
      });
    }

    // Force final answer after max iterations
    emit({ type: 'status', content: '📝 Synthesizing prediction across all gathered feature vectors…' });
    messages.push({
      role: 'user',
      content: 'Iteration budget reached. Synthesize all gathered data now. Produce FINAL_ANSWER using the full mandatory structure including all 6 feature categories, Monte Carlo probabilities, ensemble model weighting, EV calculation, and star confidence tier.',
    });

    const finalResp = await mistralPool.call(client =>
      client.chat.complete({
        model: 'mistral-large-latest',
        messages: messages as any,
        temperature: 0.1,
        maxTokens: 5000,
      })
    );

    const fc = finalResp.choices?.[0]?.message?.content || 'Unable to generate prediction.';
    const fp = parseReActResponse(typeof fc === 'string' ? fc : '');
    const answer = fp.finalContent || (typeof fc === 'string' ? fc : '');

    emit({ type: 'synthesis', content: answer });
    await clearCheckpoint(sessionId, AGENT_NAME);
    return { steps, finalAnswer: answer, success: true };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[ReAct] Error:', msg);
    emit({ type: 'error', content: `Agent error: ${msg}` });
    return { steps, finalAnswer: '', success: false, error: msg };
  }
}

export function extractPredictionData(finalAnswer: string): {
  fixture: string;
  market: string;
  probability: number;
  confidence: number;
  recommendedOdds: number;
  goalStatement: string;
  starRating: number;
  expectedValue: number;
} {
  const fixtureM = finalAnswer.match(/\*\*Fixture:\*\*\s*([^\n]+)/i)
    || finalAnswer.match(/Fixture:\s*([^\n]+)/i)
    || finalAnswer.match(/([A-Z][a-zA-Zs]+ vs?\.? [A-Z][a-zA-Zs]+)/);
  const fixture = fixtureM?.[1]?.trim() || 'Unknown Fixture';

  const marketM = finalAnswer.match(/\*\*(?:MARKET|Target Market|Market):\*\*\s*([^\n]+)/i)
    || finalAnswer.match(/MARKET:\s*([^\n]+)/i)
    || finalAnswer.match(/Target Market:\s*([^\n]+)/i);
  const market = marketM?.[1]?.replace(/\*\*/g, '').trim() || 'Match Result';

  const trueM = finalAnswer.match(/(?:Our )?true probability[:\s]+(\d+(?:\.\d+)?)\s*%/i)
    || finalAnswer.match(/P\((?:Home Win|Over|BTTS|Away Win)\)[:\s]+(\d+(?:\.\d+)?)\s*%/i);
  const probability = trueM ? parseFloat(trueM[1]) : 50;

  const confM = finalAnswer.match(/Overall Confidence[^|]*\|[^|]*\*\*(\d+(?:\.\d+)?)\s*\/\s*10\*\*/i)
    || finalAnswer.match(/overall\s+confidence[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10/i)
    || finalAnswer.match(/confidence[:\s]+(\d+(?:\.\d+)?)\s*\/\s*10/i);
  const confidence = confM ? parseFloat(confM[1]) * 10 : 60;

  const starM = finalAnswer.match(/⭐+.*?(\d)\s*\/\s*5/i)
    || finalAnswer.match(/Confidence Tier:\s*⭐{1,5}.*?(\d)/i)
    || finalAnswer.match(/(\d)\s*star/i);
  const starRating = starM ? Math.min(5, Math.max(1, parseInt(starM[1]))) : 3;

  const oddsM = finalAnswer.match(/\*\*MINIMUM ODDS:\*\*\s*(\d+\.\d+)/i)
    || finalAnswer.match(/minimum\s+odds[:\s]+(\d+\.\d+)/i)
    || finalAnswer.match(/Recommended.*?odds[:\s]+(\d+\.\d+)/i);
  const recommendedOdds = oddsM ? parseFloat(oddsM[1]) : 0;

  const evM = finalAnswer.match(/\*\*EXPECTED VALUE:\*\*\s*\+?([0-9.]+)%/i)
    || finalAnswer.match(/Expected Value.*?\+?([0-9.]+)%/i)
    || finalAnswer.match(/EV[:\s]+\+?([0-9.]+)%/i);
  const expectedValue = evM ? parseFloat(evM[1]) / 100 : 0;

  const goalM = finalAnswer.match(/\*\*Goal Statement:\*\*\s*([^\n]+)/i)
    || finalAnswer.match(/Goal Statement:\s*([^\n]+)/i);
  const goalStatement = goalM?.[1]?.trim() || market;

  return { fixture, market, probability, confidence, recommendedOdds, goalStatement, starRating, expectedValue };
}
