import { query } from '../db/index.js';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID_ENV = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_WORKSPACE_ID = process.env.AIRTABLE_WORKSPACE_ID || '';
const AIRTABLE_API = 'https://api.airtable.com/v0';

const safeNumber = (n: any): number | undefined => typeof n === 'number' && !isNaN(n) ? n : undefined;
const toISO = (d: any): string | undefined => { if (!d) return undefined; const date = new Date(d); return isNaN(date.getTime()) ? undefined : date.toISOString(); };
const cleanFields = (obj: Record<string, any>) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'number' && isNaN(v))));

const EXTRA_PREDICTION_FIELDS = [
  { name: 'Selection', type: 'singleLineText' },
  { name: 'Decision Type', type: 'singleLineText' },
  { name: 'Validation Status', type: 'singleLineText' },
  { name: 'Betting Status', type: 'singleLineText' },
  { name: 'Confidence %', type: 'number', options: { precision: 2 } },
];

type AirtableInit = { baseId: string; tables: Record<string, string>; fields: Record<string, Set<string>> };
let cache: AirtableInit | null = null;

async function airtableFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${AIRTABLE_API}${path}`, { ...options, headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json', ...options.headers } });
  if (!res.ok) { const text = await res.text(); console.error('[Airtable ERROR]', res.status, text); throw new Error(`Airtable ${res.status}: ${text}`); }
  return res.json();
}

async function ensureRegistry() {
  await query(`CREATE TABLE IF NOT EXISTS airtable_registry (id INT AUTO_INCREMENT PRIMARY KEY, base_id VARCHAR(100), table_name VARCHAR(100), table_id VARCHAR(100), UNIQUE KEY uniq (base_id, table_name))`);
}

async function register(baseId: string, name: string, id: string) {
  await query(`INSERT INTO airtable_registry (base_id, table_name, table_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE table_id = VALUES(table_id)`, [baseId, name, id]);
}

async function createBase() {
  if (!AIRTABLE_WORKSPACE_ID) throw new Error('Missing AIRTABLE_WORKSPACE_ID');
  const data = await airtableFetch('/meta/bases', { method: 'POST', body: JSON.stringify({ name: 'Odessyus Quant Punter', workspaceId: AIRTABLE_WORKSPACE_ID }) });
  return data.id as string;
}

async function ensurePredictionFields(baseId: string, tableId: string, existing: Set<string>) {
  for (const field of EXTRA_PREDICTION_FIELDS) {
    if (existing.has(field.name)) continue;
    try {
      await airtableFetch(`/meta/bases/${baseId}/tables/${tableId}/fields`, { method: 'POST', body: JSON.stringify(field) });
      existing.add(field.name);
    } catch (error) {
      console.warn(`[Airtable] Could not create field ${field.name}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

export async function initAirtable(): Promise<AirtableInit | null> {
  if (!AIRTABLE_API_KEY) { console.warn('[Airtable] Missing API key. Skipping.'); return null; }
  await ensureRegistry();

  let baseId = AIRTABLE_BASE_ID_ENV || '';
  if (!baseId) {
    const rows = await query<any[]>('SELECT base_id FROM airtable_registry LIMIT 1');
    if (rows.length) baseId = rows[0].base_id;
  }
  if (!baseId) { console.log('[Airtable] Creating new base...'); baseId = await createBase(); }

  const schema = await airtableFetch(`/meta/bases/${baseId}/tables`);
  const tables: Record<string, string> = {};
  const fields: Record<string, Set<string>> = {};

  for (const table of schema.tables || []) {
    tables[table.name] = table.id;
    fields[table.name] = new Set((table.fields || []).map((f: any) => f.name));
    await register(baseId, table.name, table.id);
  }

  if (tables['Predictions']) await ensurePredictionFields(baseId, tables['Predictions'], fields['Predictions'] || new Set());
  cache = { baseId, tables, fields };
  return cache;
}

function parseDecisionPayload(goalStatement: any) {
  if (typeof goalStatement !== 'string') return null;
  try {
    const parsed = JSON.parse(goalStatement);
    if (!parsed || !parsed.primaryBet) return null;
    return parsed;
  } catch { return null; }
}

function predictionFields(data: any, decision: any, decisionType: string, available: Set<string>, id: string) {
  const market = decision?.market || data.market;
  const selection = decision?.selection || '';
  const probabilityPct = Number.isFinite(Number(decision?.probability_pct)) ? Number(decision.probability_pct) : safeNumber(data.predictedProb * 100);
  const odds = Number.isFinite(Number(decision?.odds)) ? Number(decision.odds) : safeNumber(data.recommendedOdds);
  const ev = Number.isFinite(Number(decision?.ev_pct)) ? Number(decision.ev_pct) : safeNumber(data.evPct * 100);
  const validation = decision?.validation || (data.isValueBet ? 'VALIDATED' : 'UNVERIFIED');
  const status = decision?.status || (data.isValueBet ? 'BET' : 'SKIP');
  const confidence = Number.isFinite(Number(decision?.confidence_pct)) ? Number(decision.confidence_pct) : safeNumber(data.dataCompleteness);

  const base: Record<string, any> = {
    'Prediction ID': id,
    Fixture: data.fixture,
    Sport: data.sport,
    League: data.league,
    Market: market,
    'Kickoff Time': toISO(data.kickoffTime),
    'Predicted Prob %': probabilityPct,
    'Implied Prob %': odds && odds > 1 ? 100 / odds : safeNumber(data.impliedProb * 100),
    'EV %': ev,
    'Star Rating': safeNumber(data.starRating),
    'Recommended Odds': odds,
    'Data Completeness': safeNumber(data.dataCompleteness),
    'Is Value Bet': status === 'BET' || data.isValueBet === true,
    'Recommended Stake': decisionType === 'PRIMARY_BET' && status === 'BET' ? data.recommendedStake : 'WATCHLIST',
    'Market Score': safeNumber(data.categoryProbabilities?.market),
    'Form Score': safeNumber(data.categoryProbabilities?.form),
    'Injury Score': safeNumber(data.categoryProbabilities?.injury),
    'Sentiment Score': safeNumber(data.categoryProbabilities?.sentiment),
    'MC Home Win %': safeNumber(data.monteCarlo?.home),
    'MC Draw %': safeNumber(data.monteCarlo?.draw),
    'MC Away Win %': safeNumber(data.monteCarlo?.away),
    'MC Std Dev': safeNumber(data.monteCarlo?.stdDev),
    'Is Combo': data.isCombo,
    'Combo Leg IDs': data.comboLegIds,
    'Goal Statement': decision?.reason || data.goalStatement,
    'Created At': new Date().toISOString(),
    'Selection': selection,
    'Decision Type': decisionType,
    'Validation Status': validation,
    'Betting Status': status,
    'Confidence %': confidence,
  };
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(cleanFields(base))) if (available.has(k) || !['Selection','Decision Type','Validation Status','Betting Status','Confidence %'].includes(k)) out[k] = v;
  return out;
}

export async function logPrediction(data: any) {
  const init = cache || await initAirtable();
  if (!init) return;
  const tableId = init.tables['Predictions'];
  if (!tableId) { console.error('Missing Predictions table ID'); return; }
  const available = init.fields['Predictions'] || new Set<string>();
  const decisionPayload = parseDecisionPayload(data.goalStatement);

  const records: Array<{ fields: Record<string, any> }> = [];
  if (decisionPayload?.primaryBet) {
    records.push({ fields: predictionFields(data, decisionPayload.primaryBet, 'PRIMARY_BET', available, `${data.predictionId}-primary`) });
    for (let i = 0; i < (decisionPayload.alternativePicks || []).length; i++) {
      const pick = decisionPayload.alternativePicks[i];
      records.push({ fields: predictionFields(data, pick, 'ALTERNATIVE', available, `${data.predictionId}-alt-${i + 1}`) });
    }
  } else {
    records.push({ fields: predictionFields(data, null, 'LEGACY', available, data.predictionId) });
  }

  if (records.length) await airtableFetch(`/${init.baseId}/${tableId}`, { method: 'POST', body: JSON.stringify({ records }) });
}

export async function logResult(data: any) {
  const init = cache || await initAirtable();
  if (!init) return;
  const tableId = init.tables['Results'];
  if (!tableId) { console.error('Missing Results table ID'); return; }
  const fields = cleanFields({ 'Prediction ID': data.predictionId, Fixture: data.fixture, Market: data.market, 'Actual Outcome': data.actualOutcome, Result: data.result, 'Void Reason': data.voidReason, 'Final Score': data.finalScore, ROI: safeNumber(data.roi), 'Settled At': new Date().toISOString() });
  await airtableFetch(`/${init.baseId}/${tableId}`, { method: 'POST', body: JSON.stringify({ records: [{ fields }] }) });
}
