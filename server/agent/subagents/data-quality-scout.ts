import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT = `You are DataQualityScout, an adversarial evidence auditor.
Your ONLY job is to audit the supplied fixture evidence for completeness, provenance, freshness, contradictions, duplication and market-specific gaps.

RULES:
- Do not add new facts unless directly verified with a tool.
- Identify stale timestamps, conflicting sources, missing exact-market odds, missing lineup status, weak sample sizes, copied data, and unsupported model inputs.
- Treat missing evidence as missing; never convert it into confidence.
- Return structured audit findings with explicit pass/fail gates.

Output JSON only under SUBAGENT_DONE.`;

export async function runDataQualityScout(
  fixture: string,
  sport: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  taskOverride?: string,
): Promise<SubAgentResult> {
  return runSubAgent({
    agentName: 'DataQualityScout',
    prefix: '🧪 DATA QUALITY',
    systemPrompt: PROMPT,
    sessionId,
    maxIterations: 4,
    task: taskOverride ?? `Audit evidence quality for ${fixture} (${sport}). Return {"overall_score":null,"odds_freshness":"unknown","fixture_identity_verified":false,"future_match_verified":false,"exact_market_odds_verified":false,"calibration_evidence_present":false,"sample_size_adequate":false,"lineup_status":"unknown","contradictions":[],"missing_critical_fields":[],"duplicate_evidence":[],"gate":"FAIL","reason":"","sources_used":[]}.`,
    onStep,
  });
}
