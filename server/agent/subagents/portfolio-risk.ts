import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT=`You are PortfolioRiskScout, a portfolio construction and correlation specialist.
Your only job is to assess proposed accumulator legs for dependence and concentration.
Check same-game dependence, same-team dependence, same-league concentration, common-factor exposure, market-type concentration and whether multiplication of probabilities would be invalid.
Never invent correlation coefficients. Use explicit evidence or label correlation as unknown.
Return JSON only under SUBAGENT_DONE.`;

export async function runPortfolioRiskScout(fixture:string,sport:string,sessionId:string,onStep:(step:ReActStep)=>void,taskOverride?:string):Promise<SubAgentResult>{
 return runSubAgent({agentName:'PortfolioRiskScout',prefix:'🧩 PORTFOLIO',systemPrompt:PROMPT,sessionId,maxIterations:5,task:taskOverride??`Review the candidate portfolio for ${fixture} (${sport}). Return {"legs":[],"same_game_links":[],"same_team_links":[],"league_concentration":null,"market_concentration":null,"common_factor_exposure":[],"joint_probability_method":"unknown","independence_valid":false,"portfolio_risk_score":null,"recommended_action":"hold|trim|reject","sources_used":[]}.`,onStep});
}
