const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.cwd());
const schema = path.join(root, 'server/db/schema.ts');
const settlement = path.join(root, 'server/agent/settlement.ts');

function patch(file, transform, label) {
  const source = fs.readFileSync(file, 'utf8');
  const next = transform(source);
  if (next === source) {
    console.log(`[exact-settlement] ${label}: already applied`);
    return;
  }
  fs.writeFileSync(file, next, 'utf8');
  console.log(`[exact-settlement] ${label}: applied`);
}

patch(schema, source => {
  if (source.includes("['prediction_selection'")) return source;
  const marker = "const newCols:[string,string][]=[['closing_odds'";
  if (!source.includes(marker)) throw new Error('schema migration marker not found');
  return source.replace(
    marker,
    "const newCols:[string,string][]=[['prediction_selection',\"VARCHAR(500) COMMENT 'exact selected outcome for the prediction; never inferred from 1X2'\"],['closing_odds'"
  );
}, 'prediction_selection migration');

patch(settlement, source => {
  let next = source;

  if (!next.includes('prediction_selection')) {
    next = next.replace(
      /interface PendingPick \{[\s\S]*?created_at: Date;\n\}/,
      `interface PendingPick {
  id: string;
  fixture: string;
  prediction_market: string;
  prediction_selection: string | null;
  goal_statement: string | null;
  event_date: Date | null;
  recommended_odds: number | null;
  created_at: Date;
}`
    );
  }

  if (!next.includes('prediction_selection, goal_statement')) {
    next = next.replace(
      /SELECT id, fixture, prediction_market, prediction_selection, event_date, recommended_odds, created_at/,
      'SELECT id, fixture, prediction_market, prediction_selection, goal_statement, event_date, recommended_odds, created_at'
    );
  }

  if (!next.includes('function resolveSelection(')) {
    next = next.replace(
      /interface SettlementResult/,
      `function resolveSelection(pick: PendingPick): string | null {
  if (pick.prediction_selection && pick.prediction_selection.trim()) return pick.prediction_selection.trim();
  if (pick.goal_statement) {
    try {
      const parsed = JSON.parse(pick.goal_statement);
      const candidate = parsed?.primaryBet?.selection || parsed?.primaryBet?.pick || parsed?.primaryBet?.name;
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    } catch {}
  }
  return null;
}

interface SettlementResult`
    );
  }

  if (next.includes('const settlement = settleMarket(pick.prediction_market, pick.prediction_selection,')) {
    next = next.replace(
      'const settlement = settleMarket(pick.prediction_market, pick.prediction_selection, score.homeScore, score.awayScore);',
      'const resolvedSelection = resolveSelection(pick);\n    const settlement = settleMarket(pick.prediction_market, resolvedSelection, score.homeScore, score.awayScore);'
    );
  }

  return next;
}, 'exact selection resolution for settlement');

// Build-time guard: the generated settlement source must refuse an implicit 1X2 fallback.
const compiled = fs.readFileSync(settlement, 'utf8');
if (/m\.includes\(['"]1x2['"]\)/.test(compiled)) {
  throw new Error('Settlement guard failed: implicit 1X2 fallback remains');
}
if (!compiled.includes('missing_selection')) {
  throw new Error('Settlement guard failed: missing-selection manual review rule absent');
}
if (!compiled.includes('prediction_selection')) {
  throw new Error('Settlement guard failed: prediction_selection not present');
}
console.log('[exact-settlement] Guard passed: settlement requires the exact selected pick.');
