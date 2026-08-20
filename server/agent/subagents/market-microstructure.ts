import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';

const PROMPT = `You are MarketMicrostructureScout, a specialist in bookmaker/exchange price integrity.
Your only job is to verify exact-market price structure for the assigned fixture.
Check opening vs current price, cross-bookmaker dispersion, overround, stale/suspended markets, exchange vs bookmaker discrepancy, liquidity/availability signals, line velocity and CLV opportunity.
Never estimate a price that was not observed. Never substitute another market.
Return JSON only under SUBAGENT_DONE with nulls for unavailable fields.`;

export async function runMarketMicrostructureScout(fixture:string,sport:string,sessionId:string,onStep:(step:ReActStep)=>void,taskOverride?:string):Promise<SubAgentResult>{
  const date=new Date().toISOString().slice(0,10);
  return runSubAgent({agentName:'MarketMicrostructureScout',prefix:'💹 MICROSTRUCTURE',systemPrompt:PROMPT,sessionId,maxIterations:5,task:taskOverride??`Verify market microstructure for ${fixture} (${sport}) on ${date}. Return {"market":"","selection":"","opening_odds":null,"current_odds":null,"best_odds":null,"bookmaker_count":0,"bookmaker_dispersion":null,"overround":null,"exchange_odds":null,"liquidity_signal":"unknown","stale_price":false,"market_suspended":false,"line_velocity":null,"clv_opportunity":null,"price_confidence":0,"sources_used":[]}.`,onStep});
}
