import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT = `You are TacticalScout, a fixture-specific football tactical analyst.
Your ONLY job is to assess how the two teams' styles interact and identify robust tactical implications for markets.

RULES:
- Use evidence tied to the exact fixture and current season/recent matches.
- Separate observed tactical tendencies from interpretation.
- Do not invent formations, pressing rates, possession or player roles.
- Consider formation, build-up, press intensity, transition threat, set pieces, defensive block, pace, width, and matchup asymmetries.
- Flag uncertainty when predicted lineups are not confirmed.
- Do not output betting probabilities; provide tactical evidence for the quantitative layer.

Output JSON only under SUBAGENT_DONE.`;

export async function runTacticalScout(
  fixture: string,
  sport: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  taskOverride?: string,
): Promise<SubAgentResult> {
  const date = new Date().toISOString().slice(0, 10);
  return runSubAgent({
    agentName: 'TacticalScout',
    prefix: '🧭 TACTICAL',
    systemPrompt: PROMPT,
    sessionId,
    maxIterations: 4,
    task: taskOverride ?? `Analyse the tactical matchup for ${fixture} (${sport}) as of ${date}. Return {"home_shape":null,"away_shape":null,"home_build_up":null,"away_build_up":null,"pressing_matchup":null,"transition_edge":null,"set_piece_edge":null,"defensive_matchup":null,"pace_expectation":null,"key_mismatch":null,"lineup_sensitivity":null,"sources_used":[]}.`,
    onStep,
  });
}
