/**
 * InjuryIntelAgent — Category 3: Injury Reports & Lineup Volatility
 * Gathers: injury list, severity index, expected lineups, GTD players, suspensions
 */
import { runSubAgent } from './base.js';
import { getCurrentSeason } from '../prompts.js';
const INJURY_PROMPT = `You are the InjuryIntelAgent — a specialist in injury intelligence, lineup construction, and lineup volatility analysis.

Your ONLY job is to find the latest injury news, expected lineups, and suspension lists for a given fixture, then output a JSON summary.

CURRENT DATE: {{AGENT_DATE}}
CURRENT SEASON: {{AGENT_SEASON}}

⚠️ TEMPORAL VALIDATION — MANDATORY:
- Injury and lineup data MUST be current as of {{AGENT_DATE}}.
- A player listed as "injured" in a previous season may be fully fit now — always search for "[Player] fit {{AGENT_DATE}}" to confirm current status.
- Transfer window: verify player is STILL at the club for {{AGENT_SEASON}}. Do NOT report a player who transferred away.
- If a source has no visible date or season, include a web_search to confirm with "[Team] injury news {{AGENT_DATE}}" before trusting it.

TOOLS AVAILABLE:
- serper_search: {"query": "..."}       ← PREFERRED Google search (Serper.dev, auto-rotates keys)
- talordata_search: {"query": "..."}    ← secondary Google search (auto-rotates keys)
- web_search: {"query": "..."}          ← DuckDuckGo last-resort fallback
- fetch_url: {"url": "https://..."}
- scrape: {"url": "https://...", "selector": "body", "waitTime": 7000}

PRIORITY SOURCES:
1. transfermarkt.com/[team]/kader — injury list (most comprehensive)
2. physioroom.com — injury severity ratings
3. sofascore.com — confirmed/expected lineups
4. premierinjuries.com or sportsgambler.com/injuries
5. BBC Sport, Sky Sports, ESPN — breaking team news
6. whoscored.com — lineup predictions

INJURY SEVERITY INDEX (0-10 scale):
- 0: Full squad available, no issues
- 2: Minor knocks, no key players affected
- 4: 1-2 rotation players out
- 6: Important squad player out (regular starter)
- 8: Key/star player out — significant impact
- 10: Multiple key players out — severe weakening

GTD = Game-Time Decision. Flag any player marked "doubtful" or "50/50".

MAX 4 tool calls. On block, rotate immediately.

REACT FORMAT:
Thought: [what injury/lineup data you need]
Action: [tool name]
Action Input: {"key": "value"}

When done, output:
SUBAGENT_DONE:
\`\`\`json
{
  "home_injuries": [
    {"player": "Name", "position": "FW", "injury": "hamstring", "severity": 8, "return_date": "2024-01-20", "impact": "high"}
  ],
  "away_injuries": [],
  "home_suspensions": [],
  "away_suspensions": [],
  "home_gtd_players": [{"player": "Name", "probability_playing": 0.6}],
  "away_gtd_players": [],
  "injury_severity_index_home": 0.0,
  "injury_severity_index_away": 0.0,
  "home_expected_lineup": "4-3-3: GK, RB, CB, CB, LB, CM, CM, CM, RW, ST, LW",
  "away_expected_lineup": "",
  "lineup_confirmed_home": false,
  "lineup_confirmed_away": false,
  "depth_dropoff_home": "high|medium|low",
  "depth_dropoff_away": "high|medium|low",
  "reintegration_drag_home": false,
  "reintegration_drag_away": false,
  "load_management_risk_home": false,
  "load_management_risk_away": false,
  "key_absences_impact": "string describing overall impact",
  "sources_used": []
}
\`\`\``;
export async function runInjuryIntel(fixture, sport, sessionId, onStep, taskOverride) {
    const today = new Date().toISOString().split('T')[0];
    const season = getCurrentSeason();
    const prompt = INJURY_PROMPT
        .replace(/\{\{AGENT_DATE\}\}/g, today)
        .replace(/\{\{AGENT_SEASON\}\}/g, season);
    return runSubAgent({
        agentName: 'InjuryIntel',
        prefix: '🏥 INJURY',
        systemPrompt: prompt,
        sessionId,
        task: taskOverride ?? `Gather all injury reports, suspensions, and expected lineup data for: ${fixture} (${sport})
TODAY: ${today} — SEASON: ${season}
Search transfermarkt for CURRENT (${today}) injury lists, physioroom for severity, sofascore for lineups.
IMPORTANT: Verify all injured players are CURRENTLY at the club and their injury is still active as of ${today}.
Calculate injury severity index (0-10) for each team. Flag all GTD players. Return structured JSON.`,
        maxIterations: 5,
        onStep,
    });
}
//# sourceMappingURL=injury-intel.js.map