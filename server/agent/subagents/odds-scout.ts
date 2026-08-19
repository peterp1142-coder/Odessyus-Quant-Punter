import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';
import { getCurrentSeason } from '../prompts.js';
const ODDS_PROMPT=`You are OddsScout. Gather VERIFIED, current market prices for the EXACT fixture and TARGET MARKET.
CURRENT DATE: {{AGENT_DATE}} | SEASON: {{AGENT_SEASON}}
Never substitute a home-win price for another market. For 1X2 return home/draw/away separately. For Over/Under/BTTS return the exact requested line.
Only use prices for the specified fixture/date. If the requested market price cannot be verified, return null — never estimate it.
TOOLS: serper_search, talordata_search, web_search, fetch_url, scrape.
When done: SUBAGENT_DONE:\n\`\`\`json
{"opening_odds_home":null,"opening_odds_draw":null,"opening_odds_away":null,"current_odds_home":null,"current_odds_draw":null,"current_odds_away":null,"selection_odds":null,"selection_implied_prob":null,"implied_prob_home":null,"implied_prob_draw":null,"implied_prob_away":null,"line_delta_home":0,"line_movement_direction":"stable","public_betting_pct":null,"handle_pct":null,"reverse_line_movement":false,"sharp_money_side":"unclear","best_available_odds":null,"bookmaker_variance":null,"arbitrage_detected":false,"market_notes":"","sources_used":[]}
\`\`\``;
export async function runOddsScout(fixture:string,sport:string,sessionId:string,onStep:(step:ReActStep)=>void,taskOverride?:string):Promise<SubAgentResult>{const today=new Date().toISOString().split('T')[0],season=getCurrentSeason();return runSubAgent({agentName:'OddsScout',prefix:'📊 ODDS',systemPrompt:ODDS_PROMPT.replace(/\{\{AGENT_DATE\}\}/g,today).replace(/\{\{AGENT_SEASON\}\}/g,season),sessionId,task:taskOverride??`Find VERIFIED current odds for EXACT fixture: ${fixture} (${sport}). TARGET MARKET MUST be preserved from the user query. Return exact selection_odds and selection_implied_prob. Today ${today}, season ${season}.`,maxIterations:5,onStep});}
const MULTI=`You are OddsScout scanning ONLY the supplied fixtures. Current date {{AGENT_DATE}}. Never invent fixtures or historical prices. Rank only verified current prices. For each pick, market and odds must be the exact same selection. If price cannot be verified, mark skip.
SUBAGENT_DONE:\n\`\`\`json
{"picks":[{"fixture":"","market":"","best_available_odds":null,"implied_prob_pct":null,"sharp_money_side":"unclear","line_movement":"stable","reverse_line_movement":false,"ev_estimate_pct":null,"value_tier":"skip","rationale":""}],"sources_used":[]}
\`\`\``;
export async function runOddsScoutMulti(fixtures:string[],sport:string,matchDate:string,sessionId:string,onStep:(step:ReActStep)=>void):Promise<SubAgentResult>{const season=getCurrentSeason();return runSubAgent({agentName:'OddsScout',prefix:'📊 ODDS',systemPrompt:MULTI.replace(/\{\{AGENT_DATE\}\}/g,matchDate),sessionId,task:`Scan ONLY these ${sport} fixtures on ${matchDate}:\n${fixtures.map((f,i)=>`${i+1}. ${f}`).join('\n')}\nFind current odds and rank verified value candidates.`,maxIterations:8,onStep});}
