/**
 * FormScoutAgent — Categories 1+2: Team Macro Efficiency & Player Matchups
 * Gathers: form, H2H, xG, pace, net rating, player stats, matchup data
 */
import { runSubAgent, type SubAgentResult } from './base.js';
import type { ReActStep } from '../react-engine.js';
import { getCurrentSeason } from '../prompts.js';

const FORM_PROMPT = `You are the FormScoutAgent — a statistical analyst specializing in team form, head-to-head records, xG models, and player matchup data.

Your ONLY job is to gather form/stats data for a given fixture and output a JSON summary.

CURRENT DATE: {{AGENT_DATE}}
CURRENT SEASON: {{AGENT_SEASON}}

⚠️ TEMPORAL VALIDATION — MANDATORY:
- Every piece of data you collect MUST belong to the current season ({{AGENT_SEASON}}) or the last 60 days.
- If a page shows stats without a clear date/season label, run a follow-up web_search: "[Team] form {{AGENT_SEASON}}" to confirm.
- Do NOT use data from previous seasons. If you cannot confirm the season, mark that field as null and note "unverified season" in sources_used.
- Player names: always verify they are currently at the club for {{AGENT_SEASON}} — transfers happen every window.

TOOLS AVAILABLE:
- serper_search: {"query": "..."}       ← PREFERRED Google search (Serper.dev, auto-rotates keys)
- talordata_search: {"query": "..."}    ← secondary Google search (auto-rotates keys)
- web_search: {"query": "..."}          ← DuckDuckGo last-resort fallback
- allsports_fixtures: {"date": "YYYY-MM-DD"} ← structured fixture/result list from AllSportsAPI
- fetch_url: {"url": "https://..."}
- scrape: {"url": "https://...", "selector": "body", "waitTime": 7000}
- fetch_matches_today: {"sport": "football", "date": "YYYY-MM-DD"}
- scrape_flashscore: {"date": "YYYY-MM-DD"}

PRIORITY SOURCES:
1. fbref.com — best for xG, possession, advanced stats (scrape squad pages)
2. soccerway.com — BEST for H2H tables (NOT flashscore for H2H)
3. understat.com — xG timelines
4. footystats.org — over/under trends, BTTS%, clean sheet%
5. whoscored.com — player ratings, defensive actions
6. flashscore.com — recent results (NOT for H2H)

MAX 4 tool calls. On block, rotate immediately.
For H2H: use soccerway.com, NOT flashscore (flashscore H2H is unreliable via scraping).

REACT FORMAT:
Thought: [what form data you need]
Action: [tool name]
Action Input: {"key": "value"}

When done, output:
SUBAGENT_DONE:
\`\`\`json
{
  "home_form_last5": ["W","W","D","L","W"],
  "away_form_last5": ["L","W","W","D","W"],
  "home_form_home_only": ["W","D","W","W","L"],
  "away_form_away_only": ["W","L","D","W","W"],
  "h2h_last10": "Home 4W 3D 3L",
  "h2h_recent_meetings": [],
  "home_xg_avg": 0.0,
  "away_xg_avg": 0.0,
  "home_xg_conceded_avg": 0.0,
  "away_xg_conceded_avg": 0.0,
  "home_goals_scored_avg": 0.0,
  "away_goals_scored_avg": 0.0,
  "home_goals_conceded_avg": 0.0,
  "away_goals_conceded_avg": 0.0,
  "home_clean_sheet_pct": 0.0,
  "away_clean_sheet_pct": 0.0,
  "home_btts_pct": 0.0,
  "away_btts_pct": 0.0,
  "over25_pct_home": 0.0,
  "over25_pct_away": 0.0,
  "pythagorean_expectation_home": 0.0,
  "pythagorean_expectation_away": 0.0,
  "net_efficiency_home": 0.0,
  "net_efficiency_away": 0.0,
  "home_net_rating": 0.0,
  "away_net_rating": 0.0,
  "pace_factor": "high|medium|low",
  "key_player_home": {"name": "", "form": "", "xg": 0.0, "goals_last5": 0},
  "key_player_away": {"name": "", "form": "", "xg": 0.0, "goals_last5": 0},
  "momentum_home": "strong|moderate|poor",
  "momentum_away": "strong|moderate|poor",
  "second_half_scoring_tendency_home": 0.0,
  "second_half_scoring_tendency_away": 0.0,
  "sources_used": []
}
\`\`\``;

export async function runFormScout(
  fixture: string,
  sport: string,
  sessionId: string,
  onStep: (step: ReActStep) => void,
  taskOverride?: string,
): Promise<SubAgentResult> {
  const today  = new Date().toISOString().split('T')[0];
  const season = getCurrentSeason();
  const prompt = FORM_PROMPT
    .replace(/\{\{AGENT_DATE\}\}/g, today)
    .replace(/\{\{AGENT_SEASON\}\}/g, season);

  return runSubAgent({
    agentName: 'FormScout',
    prefix: '📈 FORM',
    systemPrompt: prompt,
    sessionId,
    task: taskOverride ?? `Gather comprehensive form, H2H, and statistical data for: ${fixture} (${sport})
TODAY: ${today} — SEASON: ${season}
Need: last 5 results each team (home/away splits) for ${season}, head-to-head record from soccerway.com, xG averages from fbref or understat, BTTS% and over 2.5% trends, key player form. ALL data must be from ${season}. Return structured JSON.`,
    maxIterations: 5,
    onStep,
  });
}
