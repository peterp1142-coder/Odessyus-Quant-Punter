import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT = `You are RefereeScout, a fixture-specific officiating analyst.
Your ONLY job is to verify the appointed referee for the exact fixture and gather referee-specific historical tendencies relevant to the requested market.

RULES:
- Verify the referee assignment from an official competition or reliable match source before using statistics.
- Never substitute league averages for referee-specific statistics.
- If the referee is not verified, return null for referee statistics.
- Only use current/relevant seasons where the source clearly identifies the referee.
- Report source conflicts instead of silently choosing one.
- Do not infer a home bias from a tiny sample.

Look for: fouls/game, yellows/game, reds/game, penalties/game, home/away bias evidence, and whether the referee profile is materially relevant to totals/BTTS/card markets.
Output JSON only under SUBAGENT_DONE.`;

export async function runRefereeScout(
  fixture: string,
  sport: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  taskOverride?: string,
): Promise<SubAgentResult> {
  const date = new Date().toISOString().slice(0, 10);
  return runSubAgent({
    agentName: 'RefereeScout',
    prefix: '🧑‍⚖️ REFEREE',
    systemPrompt: PROMPT,
    sessionId,
    maxIterations: 4,
    task: taskOverride ?? `Verify the appointed referee and referee-specific tendencies for ${fixture} (${sport}) on ${date}. Return {"referee_name":null,"assignment_verified":false,"fouls_per_game":null,"yellows_per_game":null,"reds_per_game":null,"penalties_per_game":null,"home_bias_score":null,"market_relevance":null,"conflicts":[],"sources_used":[]}.`,
    onStep,
  });
}
