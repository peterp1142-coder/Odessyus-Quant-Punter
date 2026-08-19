/**
 * OddsScoutAgent — Category 5: Market Dynamics & Sharp Money Flow
 * Gathers: opening/current lines, public %, handle %, RLM, arbitrage, CLV
 */
import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';
import { getCurrentSeason } from '../prompts.js';

const ODDS_PROMPT = `You are the OddsScoutAgent — a specialist in reading betting markets, sharp money signals, and line movement.

Your ONLY job is to gather odds and market data for a given fixture, then output a JSON summary.

CURRENT DATE: {{AGENT_DATE}}
CURRENT SEASON: {{AGENT_SEASON}}

⚠️ TEMPORAL VALIDATION — MANDATORY:
- Odds and line data MUST be for a match scheduled on or near {{AGENT_DATE}}.
- If you find odds for a match in a different season or month, discard them — do NOT use historical odds as current odds.
- If the fixture has already been played (result is available), note "match_completed: true" and use final result odds only.

TOOLS AVAILABLE:
- serper_search: {"query": "..."}       ← PREFERRED Google search (Serper.dev, auto-rotates keys)
- talordata_search: {"query": "..."}    ← secondary Google search (auto-rotates keys)
- web_search: {"query": "..."}          ← DuckDuckGo last-resort fallback
- fetch_url: {"url": "https://..."}
- scrape: {"url": "https://...", "selector": "body", "waitTime": 7000}
- fetch_matches_today: {"sport": "football", "date": "YYYY-MM-DD"}  ← get today's fixtures
- scrape_flashscore: {"date": "YYYY-MM-DD"}  ← dedicated flashscore.mobi scraper

PRIORITY SOURCES (in order):
1. sportybet.com — selector: body (TOP-TIER, usually open)
2. oddsportal.com/[sport]/[league]/[fixture]
3. oddschecker.com
4. betexplorer.com
5. flashscore.com/odds
6. pinnacle.com (sharpest market)
7. betfair.com/exchange (true market price)

MAX 4 tool calls. On block, rotate immediately.

REACT FORMAT:
Thought: [what odds data you need]
Action: [tool name]
Action Input: {"key": "value"}

When done, output:
SUBAGENT_DONE:
\`\`\`json
{
  "opening_odds_home": 0.0,
  "opening_odds_draw": 0.0,
  "opening_odds_away": 0.0,
  "current_odds_home": 0.0,
  "current_odds_draw": 0.0,
  "current_odds_away": 0.0,
  "line_delta_home": 0.0,
  "line_movement_direction": "shortening|drifting|stable",
  "implied_prob_home": 0.0,
  "implied_prob_draw": 0.0,
  "implied_prob_away": 0.0,
  "public_betting_pct": 0.0,
  "handle_pct": 0.0,
  "reverse_line_movement": false,
  "sharp_money_side": "home|draw|away|unclear",
  "best_available_odds": 0.0,
  "bookmaker_variance": 0.0,
  "arbitrage_detected": false,
  "market_notes": "string",
  "sources_used": ["url1", "url2"]
}
\`\`\``;

export async function runOddsScout(
  fixture: string,
  sport: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  taskOverride?: string,
): Promise<SubAgentResult> {
  const today  = new Date().toISOString().split('T')[0];
  const season = getCurrentSeason();
  const prompt = ODDS_PROMPT
    .replace(/\{\{AGENT_DATE\}\}/g, today)
    .replace(/\{\{AGENT_SEASON\}\}/g, season);

  return runSubAgent({
    agentName: 'OddsScout',
    prefix: '📊 ODDS',
    systemPrompt: prompt,
    sessionId,
    task: taskOverride ?? `Gather full market odds and sharp money signals for: ${fixture} (${sport})
TODAY: ${today} — SEASON: ${season}
Find: opening odds, current odds, line movement direction, public % vs handle %, any reverse line movement.
IMPORTANT: Only return odds for THIS fixture on ${today}. Do not use historical odds from past matches.
Check oddsportal first, then oddschecker, betexplorer, pinnacle. Return structured JSON.`,
    maxIterations: 5,
    onStep,
  });
}

// ─── Multi-fixture prompt ─────────────────────────────────────────────────────

const MULTI_ODDS_PROMPT = `You are the OddsScoutAgent scanning multiple fixtures to identify the highest-value bets.

CURRENT DATE: {{AGENT_DATE}}
CURRENT SEASON: {{AGENT_SEASON}}

⚠️ STRICT RULES:
- Only analyse matches from the fixture list provided. Do NOT invent fixtures.
- Odds MUST be for matches on {{AGENT_DATE}}. Discard historical odds.
- You have MAX 8 tool calls — use them efficiently. Check a single odds source that covers multiple matches (oddsportal, sportybet, oddschecker) rather than one call per match.

TOOLS AVAILABLE:
- serper_search: {"query": "..."}       ← PREFERRED Google search
- talordata_search: {"query": "..."}    ← secondary Google search
- web_search: {"query": "..."}          ← DuckDuckGo last-resort
- fetch_url: {"url": "https://..."}
- scrape: {"url": "https://...", "selector": "body", "waitTime": 7000}

STRATEGY:
1. Search oddsportal or sportybet for today's odds overview (covers many matches at once)
2. Look for line movement signals (shortening = sharp money on favourite; drifting = fading)
3. Prioritise matches with: reverse line movement, sharp money, or odds significantly off market consensus

When done, output SUBAGENT_DONE followed by JSON:
\`\`\`json
{
  "picks": [
    {
      "fixture": "Team A vs Team B",
      "market": "Home Win|Draw|Away Win|Over 2.5|BTTS Yes|etc",
      "best_available_odds": 0.0,
      "implied_prob_pct": 0.0,
      "sharp_money_side": "home|draw|away|over|btts|unclear",
      "line_movement": "shortening|drifting|stable",
      "reverse_line_movement": false,
      "ev_estimate_pct": 0.0,
      "value_tier": "A|B|C|skip",
      "rationale": "one sentence reason"
    }
  ],
  "sources_used": ["url1", "url2"]
}
\`\`\`

Sort picks by ev_estimate_pct descending (highest EV first). Include ALL fixtures — mark low-value ones as "skip".`;

/**
 * Multi-fixture OddsScout: scans all discovered fixtures, returns a ranked JSON array by EV.
 * Used for open-ended queries like "best bets today".
 */
export async function runOddsScoutMulti(
  fixtures: string[],
  sport: string,
  matchDate: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
): Promise<SubAgentResult> {
  const season = getCurrentSeason();
  const prompt = MULTI_ODDS_PROMPT
    .replace(/\{\{AGENT_DATE\}\}/g, matchDate)
    .replace(/\{\{AGENT_SEASON\}\}/g, season);

  const fixtureList = fixtures.map((f, i) => `${i + 1}. ${f}`).join('\n');

  return runSubAgent({
    agentName: 'OddsScout',
    prefix: '📊 ODDS',
    systemPrompt: prompt,
    sessionId,
    task: `Scan odds for ALL of the following ${sport} fixtures on ${matchDate} and rank them by expected value.

TODAY'S FIXTURE LIST:
${fixtureList}

Search oddsportal.com or sportybet.com for today's odds across all these matches in as few tool calls as possible.
Identify: line movement direction, sharp money side, any reverse line movement.
Return a ranked JSON array (highest EV first). Mark low-value fixtures as "skip". Season: ${season}.`,
    maxIterations: 8,
    onStep,
  });
}
