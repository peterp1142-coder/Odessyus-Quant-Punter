const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.cwd());
const files = {
  orchestrator: path.join(root, 'server/agent/orchestrator.ts'),
  scheduler: path.join(root, 'server/agent/fixture-task-scheduler.ts'),
  tools: path.join(root, 'server/agent/tools.ts'),
  settlement: path.join(root, 'server/agent/settlement.ts'),
  schema: path.join(root, 'server/db/schema.ts'),
};

function patch(file, transform, label) {
  const source = fs.readFileSync(file, 'utf8');
  const next = transform(source);
  if (next !== source) {
    fs.writeFileSync(file, next, 'utf8');
    console.log('[safe-patch] ' + label + ': applied');
  } else {
    console.log('[safe-patch] ' + label + ': already applied');
  }
}

patch(files.orchestrator, function (source) {
  return source
    .replace(/const MAX_DISCOVERY_FIXTURES=Math\.max\(1,Number\(process\.env\.MAX_DISCOVERY_FIXTURES\|\|\d+\)\);/, 'const MAX_DISCOVERY_FIXTURES=Math.max(1,Number(process.env.MAX_DISCOVERY_FIXTURES||200));')
    .replace(/const MAX_FIXTURE_PIPELINES=Math\.max\(1,Number\(process\.env\.MAX_FIXTURE_PIPELINES\|\|\d+\)\);/, 'const MAX_FIXTURE_PIPELINES=Math.max(1,Math.min(100,Number(process.env.MAX_FIXTURE_PIPELINES||100)));');
}, '100-fixture production cap');

patch(files.scheduler, function (source) {
  return source.replace(
    /const MAX_QUEUE_DEPTH = Math\.max\(2, Number\(process\.env\.AGENT_MAX_QUEUE_DEPTH \|\| \d+\)\);/,
    'const MAX_QUEUE_DEPTH = Math.max(100, Number(process.env.AGENT_MAX_QUEUE_DEPTH || 150));'
  );
}, '100-fixture scheduler capacity');

patch(files.schema, function (source) {
  if (source.includes('prediction_selection')) return source;
  return source
    .replace(
      "prediction_market VARCHAR(500) NOT NULL,goal_statement TEXT,",
      "prediction_market VARCHAR(500) NOT NULL,prediction_selection VARCHAR(500),goal_statement TEXT,"
    )
    .replace(
      "const newCols:[string,string][]=[",
      "const newCols:[string,string][]=[['prediction_selection',\"VARCHAR(500) COMMENT 'exact selected market outcome'\"],"
    );
}, 'prediction selection schema');

patch(files.tools, function (source) {
  if (source.includes('export async function allSportsFinalScores')) return source;
  const addition = [
    '',
    'export async function allSportsFinalScores(dateFrom: string, dateTo = dateFrom): Promise<ToolResult> {',
    "  const pool = keyPool('ALL_SPORTS_APIs');",
    "  if (!pool.length) return { success:false, data:'', error:'No ALL_SPORTS_APIs keys configured', source:'allsports_final_scores' };",
    '  for (let i = 0; i < pool.length; i++) {',
    '    const key = pool[allSportsIdx++ % pool.length];',
    '    try {',
    "      const p = new URLSearchParams({ met:'Fixtures', APIkey:key, from:dateFrom, to:dateTo });",
    "      const url = ALLSPORTS_URL + '?' + p.toString();",
    "      const r = await fetchWithTimeout(url, { headers:{ Accept:'application/json' } }, SEARCH_TIMEOUT);",
    '      if (!r.ok) continue;',
    '      const j = await r.json() as any;',
    '      if (!j.success || !Array.isArray(j.result)) continue;',
    "      const lines = j.result.map((e:any) => {",
    "        const hs = e.event_home_final_score ?? e.event_home_team_score ?? e.event_home_team_ft_score;",
    "        const as = e.event_away_final_score ?? e.event_away_team_score ?? e.event_away_team_ft_score;",
    "        return [e.event_date, e.event_time || '', e.event_home_team, e.event_away_team, hs ?? '', as ?? '', e.event_status || '', e.event_league_name || e.league_name || ''].join(' | ');",
    '      });',
    "      return { success:true, data:truncate(lines.join('\\n'), 12000), source:'allsports_final_scores' };",
    '    } catch {}',
    '  }',
    "  return { success:false, data:'', error:'All AllSports final-score requests failed', source:'allsports_final_scores' };",
    '}',
    ''
  ].join('\n');
  return source + addition;
}, 'finished-score feed');

patch(files.settlement, function (source) {
  let next = source;
  next = next.replace(
    "import { allSportsLivescore } from './tools.js';",
    "import { allSportsLivescore, allSportsFinalScores, serpSearch } from './tools.js';"
  );
  next = next.replace(
    /interface PendingPick \{[\s\S]*?created_at: Date;\n\}/,
    [
      'interface PendingPick {',
      '  id: string;',
      '  fixture: string;',
      '  prediction_market: string;',
      '  prediction_selection: string | null;',
      '  event_date: Date | null;',
      '  recommended_odds: number | null;',
      '  created_at: Date;',
      '}'
    ].join('\n')
  );
  next = next.replace(
    'SELECT id, fixture, prediction_market, event_date, recommended_odds, created_at',
    'SELECT id, fixture, prediction_market, prediction_selection, event_date, recommended_odds, created_at'
  );
  next = next.replace(
    'const score = await fetchScore(pick.fixture);',
    'const score = await fetchScore(pick.fixture, pick.event_date);'
  );
  next = next.replace(
    'const settlement = settleMarket(pick.prediction_market, score.homeScore, score.awayScore);',
    'const settlement = settleMarket(pick.prediction_market, pick.prediction_selection, score.homeScore, score.awayScore);'
  );
  next = next.replace(
    'function settleMarket(market: string, home: number, away: number): SettlementResult {',
    'function settleMarket(market: string, selection: string | null, home: number, away: number): SettlementResult {\n  const m = market.toLowerCase();\n  const s = String(selection || "").toLowerCase().trim();\n  if (!s) return { outcome:"manual_review", actualOutcome:"missing_selection", voidReason:"Missing exact selection for market: " + market, roi:0 };'
  );
  next = next.replace(
    '  const m = market.toLowerCase();\n  const totalGoals',
    '  const totalGoals'
  );
  next = next.replace(
    "  if (m.includes('home win') || (m.includes('match result') && m.includes('home')) || m === '1x2') {",
    "  if (m.includes('home win') || (m.includes('match result') && s.includes('home'))) {"
  );
  next = next.replace(
    "  if (m.includes('away win') || (m.includes('match result') && m.includes('away'))) {",
    "  if (m.includes('away win') || (m.includes('match result') && s.includes('away'))) {"
  );
  next = next.replace(
    "  if (m.includes('draw')) {",
    "  if (m.includes('draw') && (s === 'draw' || s.includes('draw'))) {"
  );
  next = next.replace(
    "  if (m.includes('btts') || m.includes('both teams')) {",
    "  if (m.includes('btts') || m.includes('both teams')) {"
  );
  next = next.replace("if (m.includes('yes') && bttsYes)", "if ((s.includes('yes') || m.includes('yes')) && bttsYes)");
  next = next.replace("if (m.includes('no') && bttsNo)", "if ((s.includes('no') || m.includes('no')) && bttsNo)");
  next = next.replace(
    "  if (m.includes('over 2.5') || m.includes('over2.5') || (m.includes('over') && m.includes('2.5'))) {",
    "  if (m.includes('over 2.5') || m.includes('over2.5') || (m.includes('over') && m.includes('2.5')) || s.includes('over 2.5')) {"
  );
  next = next.replace(
    "  if (m.includes('under 2.5') || m.includes('under2.5') || (m.includes('under') && m.includes('2.5'))) {",
    "  if (m.includes('under 2.5') || m.includes('under2.5') || (m.includes('under') && m.includes('2.5')) || s.includes('under 2.5')) {"
  );
  next = next.replace(
    "  if (m.includes('over 3.5') || m.includes('over3.5')) {",
    "  if (m.includes('over 3.5') || m.includes('over3.5') || s.includes('over 3.5')) {"
  );
  next = next.replace(
    "  if (m.includes('under 3.5') || m.includes('under3.5')) {",
    "  if (m.includes('under 3.5') || m.includes('under3.5') || s.includes('under 3.5')) {"
  );
  return next;
}, 'exact market selection settlement');

console.log('[safe-patch] production hardening complete');
