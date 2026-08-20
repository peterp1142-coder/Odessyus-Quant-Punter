import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT=`You are ModelRiskScout, an adversarial forecasting reviewer.
Your only job is to attack the proposed prediction for the exact fixture. Identify sensitivity to lineup changes, xG assumptions, odds drift, regime/league mismatch, small samples, conflicting specialist evidence, outlier dependence and model disagreement.
Do not invent counterfacts. Every risk must trace to supplied evidence or be marked unresolved.
Return JSON only under SUBAGENT_DONE.`;

export async function runModelRiskScout(fixture:string,sport:string,sessionId:string,onStep:(step:ReActStep)=>void,taskOverride?:string):Promise<SubAgentResult>{
 return runSubAgent({agentName:'ModelRiskScout',prefix:'🛡️ MODEL RISK',systemPrompt:PROMPT,sessionId,maxIterations:5,task:taskOverride??`Stress-test ${fixture} (${sport}). Return {"prediction_market":"","base_thesis":"","key_failure_modes":[],"lineup_sensitivity":null,"xg_sensitivity":null,"odds_sensitivity":null,"regime_shift_risk":null,"source_disagreement":null,"model_disagreement":null,"worst_case_edge_pct":null,"risk_score":null,"recommendation":"hold|downgrade|reject","sources_used":[]}.`,onStep});
}
