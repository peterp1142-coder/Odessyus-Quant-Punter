import { query } from '../db/index.js';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY || '';
const AIRTABLE_BASE_ID_ENV = process.env.AIRTABLE_BASE_ID || '';
const AIRTABLE_WORKSPACE_ID = process.env.AIRTABLE_WORKSPACE_ID || '';

const AIRTABLE_API = 'https://api.airtable.com/v0';

/* -------------------- UTIL -------------------- */

const safeNumber = (n: any): number | undefined =>
  typeof n === 'number' && !isNaN(n) ? n : undefined;

const toISO = (d: any): string | undefined => {
  if (!d) return undefined;

  const date = new Date(d);

  return isNaN(date.getTime())
    ? undefined
    : date.toISOString();
};

const cleanFields = (obj: Record<string, any>) => {
  const out: Record<string, any> = {};

  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'number' && isNaN(v)) continue;

    out[k] = v;
  }

  return out;
};

/* -------------------- SCHEMA -------------------- */

const TABLE_DEFS = [
  {
    name: 'Predictions',
    fields: [
      { name: 'Prediction ID', type: 'singleLineText' },
      { name: 'Fixture', type: 'singleLineText' },
      { name: 'Sport', type: 'singleLineText' },
      { name: 'League', type: 'singleLineText' },
      { name: 'Market', type: 'singleLineText' },
      { name: 'Kickoff Time', type: 'dateTime' },
      { name: 'Predicted Prob %', type: 'number', options: { precision: 2 } },
      { name: 'Implied Prob %', type: 'number', options: { precision: 2 } },
      { name: 'EV %', type: 'number', options: { precision: 4 } },
      { name: 'Star Rating', type: 'number', options: { precision: 0 } },
      { name: 'Recommended Odds', type: 'number', options: { precision: 3 } },
      { name: 'Data Completeness', type: 'number', options: { precision: 1 } },
      { name: 'Is Value Bet', type: 'checkbox' },
      { name: 'Recommended Stake', type: 'singleLineText' },
      { name: 'Market Score', type: 'number', options: { precision: 4 } },
      { name: 'Form Score', type: 'number', options: { precision: 4 } },
      { name: 'Injury Score', type: 'number', options: { precision: 4 } },
      { name: 'Sentiment Score', type: 'number', options: { precision: 4 } },
      { name: 'MC Home Win %', type: 'number', options: { precision: 4 } },
      { name: 'MC Draw %', type: 'number', options: { precision: 4 } },
      { name: 'MC Away Win %', type: 'number', options: { precision: 4 } },
      { name: 'MC Std Dev', type: 'number', options: { precision: 4 } },
      { name: 'Is Combo', type: 'checkbox' },
      { name: 'Combo Leg IDs', type: 'singleLineText' },
      { name: 'Goal Statement', type: 'multilineText' },
      { name: 'Created At', type: 'dateTime' },
    ],
  },
  {
    name: 'Results',
    fields: [
      { name: 'Prediction ID', type: 'singleLineText' },
      { name: 'Fixture', type: 'singleLineText' },
      { name: 'Market', type: 'singleLineText' },
      { name: 'Actual Outcome', type: 'singleLineText' },
      {
        name: 'Result',
        type: 'singleSelect',
        options: {
          choices: [
            { name: 'pending' },
            { name: 'won' },
            { name: 'lost' },
            { name: 'void' },
            { name: 'half_win' },
            { name: 'half_loss' },
            { name: 'push' },
            { name: 'manual_review' },
          ],
        },
      },
      { name: 'Void Reason', type: 'singleLineText' },
      { name: 'Settled At', type: 'dateTime' },
      { name: 'Final Score', type: 'singleLineText' },
      { name: 'ROI', type: 'number', options: { precision: 4 } },
    ],
  },
];

/* -------------------- API -------------------- */

async function airtableFetch(
  path: string,
  options: RequestInit = {}
) {
  const res = await fetch(`${AIRTABLE_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();

    console.error(
      '[Airtable ERROR]',
      res.status,
      text
    );

    throw new Error(
      `Airtable ${res.status}: ${text}`
    );
  }

  return res.json();
}

/* -------------------- INIT -------------------- */

async function ensureRegistry() {
  await query(`
    CREATE TABLE IF NOT EXISTS airtable_registry (
      id INT AUTO_INCREMENT PRIMARY KEY,
      base_id VARCHAR(100),
      table_name VARCHAR(100),
      table_id VARCHAR(100),
      UNIQUE KEY uniq (base_id, table_name)
    )
  `);
}

async function register(
  baseId: string,
  name: string,
  id: string
) {
  await query(
    `
    INSERT INTO airtable_registry
      (base_id, table_name, table_id)
    VALUES (?, ?, ?)
    ON DUPLICATE KEY UPDATE
      table_id = VALUES(table_id)
    `,
    [
      baseId,
      name,
      id,
    ]
  );
}


/**
 * Creates a new Airtable base.
 * Tables must be created separately through Metadata API.
 */
async function createBase() {
  if (!AIRTABLE_WORKSPACE_ID) {
    throw new Error(
      'Missing AIRTABLE_WORKSPACE_ID'
    );
  }

  const data = await airtableFetch(
    '/meta/bases',
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'Odessyus Quant Punter',
        workspaceId: AIRTABLE_WORKSPACE_ID,
      }),
    }
  );

  return data.id;
}


type AirtableInit = {
  baseId: string;
  tables: Record<string, string>;
};


let cache: AirtableInit | null = null;


export async function initAirtable(): Promise<AirtableInit | null> {

  if (!AIRTABLE_API_KEY) {
    console.warn(
      '[Airtable] Missing API key. Skipping.'
    );

    return null;
  }

  await ensureRegistry();

  let baseId =
    AIRTABLE_BASE_ID_ENV || '';

  if (!baseId) {
    const rows =
      await query<any[]>(
        'SELECT base_id FROM airtable_registry LIMIT 1'
      );

    if (rows.length) {
      baseId = rows[0].base_id;
    }
  }


  if (!baseId) {
    console.log(
      '[Airtable] Creating new base...'
    );

    baseId = await createBase();
  }


  const schema =
    await airtableFetch(
      `/meta/bases/${baseId}/tables`
    );


  const tables: Record<string,string> = {};


  for (const table of schema.tables) {

    tables[table.name] = table.id;

    await register(
      baseId,
      table.name,
      table.id
    );
  }


  cache = {
    baseId,
    tables,
  };


  return cache;
}


/* -------------------- LOGGING -------------------- */

export async function logPrediction(data: any) {

  const init =
    cache || await initAirtable();

  if (!init) return;


  const tableId =
    init.tables['Predictions'];


  if (!tableId) {
    console.error(
      'Missing Predictions table ID'
    );

    return;
  }


  const fields = cleanFields({

    'Prediction ID':
      data.predictionId,

    Fixture:
      data.fixture,

    Sport:
      data.sport,

    League:
      data.league,

    Market:
      data.market,

    'Kickoff Time':
      toISO(data.kickoffTime),

    'Predicted Prob %':
      safeNumber(data.predictedProb * 100),

    'Implied Prob %':
      safeNumber(data.impliedProb * 100),

    'EV %':
      safeNumber(data.evPct * 100),

    'Star Rating':
      safeNumber(data.starRating),

    'Recommended Odds':
      safeNumber(data.recommendedOdds),

    'Data Completeness':
      safeNumber(data.dataCompleteness),

    'Is Value Bet':
      data.isValueBet,

    'Recommended Stake':
      data.recommendedStake,

    'Market Score':
      safeNumber(data.categoryProbabilities?.market),

    'Form Score':
      safeNumber(data.categoryProbabilities?.form),

    'Injury Score':
      safeNumber(data.categoryProbabilities?.injury),

    'Sentiment Score':
      safeNumber(data.categoryProbabilities?.sentiment),

    'MC Home Win %':
      safeNumber(data.monteCarlo?.home),

    'MC Draw %':
      safeNumber(data.monteCarlo?.draw),

    'MC Away Win %':
      safeNumber(data.monteCarlo?.away),

    'MC Std Dev':
      safeNumber(data.monteCarlo?.stdDev),

    'Is Combo':
      data.isCombo,

    'Combo Leg IDs':
      data.comboLegIds,

    'Goal Statement':
      data.goalStatement,

    'Created At':
      new Date().toISOString(),
  });


  await airtableFetch(
    `/${init.baseId}/${tableId}`,
    {
      method: 'POST',
      body: JSON.stringify({
        records: [
          { fields }
        ],
      }),
    }
  );
}


export async function logResult(data: any) {

  const init =
    cache || await initAirtable();

  if (!init) return;


  const tableId =
    init.tables['Results'];


  if (!tableId) {
    console.error(
      'Missing Results table ID'
    );

    return;
  }


  const fields = cleanFields({

    'Prediction ID':
      data.predictionId,

    Fixture:
      data.fixture,

    Market:
      data.market,

    'Actual Outcome':
      data.actualOutcome,

    Result:
      data.result,

    'Void Reason':
      data.voidReason,

    'Final Score':
      data.finalScore,

    ROI:
      safeNumber(data.roi),

    'Settled At':
      new Date().toISOString(),
  });


  await airtableFetch(
    `/${init.baseId}/${tableId}`,
    {
      method: 'POST',
      body: JSON.stringify({
        records: [
          { fields }
        ],
      }),
    }
  );
}