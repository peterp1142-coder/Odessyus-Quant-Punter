import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';
import { getCurrentSeason } from '../prompts.js';

const ODDS_PROMPT=`You are OddsScout. Gather VERIFIED, current market prices for the EXACT fixture and TARGET MARKET.
CURRENT DATE: {{AGENT_DATE}} | SEASON: {{AGENT_SEASON}}

SOURCE HIERARCHY (use in this order):
1) Structured odds APIs when configured: The Odds API, API-Football, UK Odds API.
2) Odds comparison sites: OddsChecker, OddsPortal, BetExplorer.
3) Match/market aggregators: Flashscore, Sofascore.
4) Direct bookmaker pages when accessible: bet365, Pinnacle, William Hill, Unibet, Sky Bet, Betway, Bet9ja, 1xBet.
Never treat a generic article, prediction page, search snippet, or model-generated price as an odds source.

VERIFICATION RULES:
- Match the EXACT fixture, competition, date and market.
- For 1X2 return home/draw/away separately.
- For Over/Under include the exact line (e.g. 2.5), not a different total.
- For BTTS return Yes/No separately.
- A price is VERIFIED only when the same selection is corroborated by at least TWO independent sources, OR one structured bookmaker/API source plus one independent comparison source.
- Record the timestamp/date of each source when available.
- Normalize all odds to DECIMAL before comparing.
- Calculate implied probability from the verified decimal price; do not trust a displayed percentage if it conflicts with the price.
- Report best available price, consensus/median price, number of independent sources, and source dispersion.
- If sources conflict materially, mark the market UNVERIFIED rather than averaging blindly.
- Never invent or estimate a missing price.

WEBSITE SEARCH TARGETS:
OddsChecker: https://www.oddschecker.com/football
OddsPortal: https://www.oddsportal.com/football
BetExplorer: https://www.betexplorer.com/football/
Flashscore: https://www.flashscore.com/football/
Sofascore: https://www.sofascore.com/football
The Odds API: https://the-odds-api.com/
API-Football: https://www.api-football.com/
UK Odds API: https://docs.ukoddsapi.com/

TOOLS: serper_search, talordata_search, web_search, fetch_url, scrape.

When done: SUBAGENT_DONE:
\`\`\`json
{"opening_odds_home":null,"opening_odds_draw":null,"opening_odds_away":null,"current_odds_home":null,"current_odds_draw":null,"current_odds_away":null,"selection_odds":null,"selection_implied_prob":null,"implied_prob_home":null,"implied_prob_draw":null,"implied_prob_away":null,"line_delta_home":0,"line_movement_direction":"stable","public_betting_pct":null,"handle_pct":null,"reverse_line_movement":false,"sharp_money_side":"unclear","best_available_odds":null,"median_market_odds":null,"odds_source_count":0,"independent_source_count":0,"odds_agreement_pct":null,"odds_verified":false,"odds_timestamp":null,"bookmaker_variance":null,"arbitrage_detected":false,"market_notes":"","sources_used":[]}
\`\`\``;

export async function runOddsScout(fixture:string,sport:string,sessionId:string,onStep:(step:ReActStep)=>void,taskOverride?:string):Promise<SubAgentResult>{
  const today=new Date().toISOString().split('T')[0],season=getCurrentSeason();
  return runSubAgent({
    agentName:'OddsScout',prefix:'📊 ODDS',
    systemPrompt:ODDS_PROMPT.replace(/\{\{AGENT_DATE\}\}/g,today).replace(/\{\{AGENT_SEASON\}\}/g,season),
    sessionId,
    task:taskOverride??`Find VERIFIED current odds for EXACT fixture: ${fixture} (${sport}). TARGET MARKET MUST be preserved from the user query. Search OddsChecker, OddsPortal, BetExplorer, Flashscore/Sofascore and at least one direct bookmaker/API source. Return exact selection_odds, selection_implied_prob, odds_verified, independent_source_count and sources_used. Today ${today}, season ${season}.`,
    maxIterations:8,
    onStep
  });
}

const MULTI=`You are OddsScout scanning ONLY the supplied fixtures. Current date {{AGENT_DATE}}.
Never invent fixtures or historical prices. For every candidate, search the exact fixture on OddsChecker, OddsPortal, BetExplorer, Flashscore/Sofascore and, when accessible, a direct bookmaker or structured odds API.
Only rank a price as VERIFIED when at least two independent sources corroborate the same market/selection. Normalize to decimal odds and report best price, median price, source count, agreement %, timestamp, and whether the price is verified.
For each pick, market and odds must be the exact same selection. If price cannot be verified, mark skip.
SUBAGENT_DONE:
\`\`\`json
{"picks":[{"fixture":"","market":"","best_available_odds":null,"median_market_odds":null,"implied_prob_pct":null,"odds_verified":false,"independent_source_count":0,"odds_agreement_pct":null,"odds_timestamp":null,"sharp_money_side":"unclear","line_movement":"stable","reverse_line_movement":false,"ev_estimate_pct":null,"value_tier":"skip","rationale":""}],"sources_used":[]}
\`\`\``;

export async function runOddsScoutMulti(fixtures:string[],sport:string,matchDate:string,sessionId:string,onStep:(step:ReActStep)=>void):Promise<SubAgentResult>{
  const season=getCurrentSeason();
  return runSubAgent({
    agentName:'OddsScout',prefix:'📊 ODDS',
    systemPrompt:MULTI.replace(/\{\{AGENT_DATE\}\}/g,matchDate),
    sessionId,
    task:`Scan ONLY these ${sport} fixtures on ${matchDate}:\n${fixtures.map((f,i)=>`${i+1}. ${f}`).join('\n')}\nFind current odds using the source hierarchy. Do not accept a search snippet as a verified price.`,
    maxIterations:10,
    onStep
  });
}
