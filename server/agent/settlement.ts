/**
 * Exact-market prediction settlement.
 * Missing selections are never guessed; unsupported markets go to manual review.
 */

import cron from 'node-cron';
import { query } from '../db/index.js';
import { logResult } from './airtable-logger.js';
import { allSportsLivescore } from './tools.js';
import { fetchFinishedScores } from './final-score.js';

interface PendingPick {
  id: string;
  fixture: string;
  prediction_market: string;
  prediction_selection: string | null;
  goal_statement: string | null;
  event_date: Date | null;
  recommended_odds: number | null;
  created_at: Date;
}

interface ScoreResult { homeScore:number; awayScore:number; status:string; found:boolean; }
interface SettlementResult { outcome:'won'|'lost'|'void'|'half_win'|'half_loss'|'push'|'manual_review'; actualOutcome:string; voidReason?:string; roi:number; }

const INITIAL_DELAY_HOURS = 2;
const MAX_RETRY_HOURS = 6;

async function ensurePredictionSelectionColumn(): Promise<void> {
  const rows = await query<Array<{ column_exists: number }>>(`
    SELECT COUNT(*) AS column_exists
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'predictions'
      AND column_name = 'prediction_selection'
  `);

  if (Number(rows[0]?.column_exists || 0) > 0) return;

  try {
    await query(`ALTER TABLE predictions ADD COLUMN prediction_selection VARCHAR(500) NULL`);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== 'ER_DUP_FIELDNAME') throw err;
  }
}

export function initSettlementCron(): void {
  void ensurePredictionSelectionColumn().catch(err => console.error('[Settlement] Selection-column migration error:', err instanceof Error ? err.message : String(err)));
  console.log('[Settlement] Cron job scheduled (every 30 min)');
  cron.schedule('*/30 * * * *', async () => {
    try { await runSettlementPass(); }
    catch (err) { console.error('[Settlement] Error:', err instanceof Error ? err.message : String(err)); }
  });
  setTimeout(() => { void runSettlementPass().catch(err => console.error('[Settlement] Startup pass error:', err instanceof Error ? err.message : String(err))); }, 60_000);
}

async function runSettlementPass(): Promise<void> {
  await ensurePredictionSelectionColumn();
  const pending = await query<PendingPick[]>(`
    SELECT id, fixture, prediction_market, prediction_selection, goal_statement, event_date, recommended_odds, created_at
    FROM predictions
    WHERE status = 'pending' AND event_date IS NOT NULL
    ORDER BY event_date ASC
    LIMIT 500
  `);
  const now = Date.now();
  for (const pick of pending) {
    const kickoff = pick.event_date ? new Date(pick.event_date).getTime() : new Date(pick.created_at).getTime();
    const hoursSinceKickoff = (now - kickoff) / 3_600_000;
    if (hoursSinceKickoff < INITIAL_DELAY_HOURS) continue;
    if (hoursSinceKickoff > MAX_RETRY_HOURS + 24) { await flagManualReview(pick.id, 'Exceeded retry window — no final score found within 30h'); continue; }
    const score = await fetchScore(pick.fixture, pick.event_date);
    if (!score.found) { if (hoursSinceKickoff > MAX_RETRY_HOURS) await flagManualReview(pick.id, 'No final score found after 6h retry window'); continue; }
    if (score.status && !['Finished','FT','Full Time','Match Finished','AP','AET','final'].includes(score.status)) continue;
    const selection = resolveSelection(pick);
    const settlement = settleMarket(pick.prediction_market, selection, score.homeScore, score.awayScore);
    await applySettlement(pick, settlement, score, selection);
  }
}

function resolveSelection(pick: PendingPick): string | null {
  if (pick.prediction_selection?.trim()) return pick.prediction_selection.trim();
  if (pick.goal_statement) {
    try {
      const parsed = JSON.parse(pick.goal_statement);
      const value = parsed?.primaryBet?.selection || parsed?.primaryBet?.pick || parsed?.primaryBet?.name;
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {}
  }
  return null;
}

function splitFixture(fixture:string): [string,string] {
  const p = fixture.split(/\s+(?:vs\.?|v\.?)\s+/i).map(v=>v.trim()).filter(Boolean);
  return [p[0] || '', p[1] || ''];
}
function normTeam(value:string):string { return value.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }

async function fetchScore(fixture:string,eventDate:Date|null):Promise<ScoreResult> {
  const [home,away] = splitFixture(fixture); if (!home || !away) return {homeScore:-1,awayScore:-1,status:'',found:false};
  const date = eventDate ? new Date(eventDate).toISOString().slice(0,10) : new Date().toISOString().slice(0,10);
  const h = normTeam(home), a = normTeam(away);
  const finished = await fetchFinishedScores(date,date).catch(()=>({success:false,data:''}));
  if (finished.success) {
    for (const line of finished.data.split('\n')) {
      const p=line.split(' | ').map(v=>v.trim());
      const lh=normTeam(p[2]||''), la=normTeam(p[3]||''); const hs=Number(p[4]), as=Number(p[5]);
      if (!Number.isFinite(hs)||!Number.isFinite(as)) continue;
      if ((lh===h&&la===a)||(lh.includes(h)&&la.includes(a))) return {homeScore:hs,awayScore:as,status:p[6]||'FT',found:true};
    }
  }
  const live = await allSportsLivescore().catch(()=>({success:false,data:''} as any));
  if (live.success) {
    for (const line of String(live.data).split('\n')) {
      const n=normTeam(line); if (!n.includes(h)||!n.includes(a)) continue;
      const m=line.match(/(\d+)\s*[-:]\s*(\d+)/); if (m) return {homeScore:Number(m[1]),awayScore:Number(m[2]),status:'FT',found:true};
    }
  }
  return {homeScore:-1,awayScore:-1,status:'',found:false};
}

function settleMarket(market:string,selection:string|null,home:number,away:number):SettlementResult {
  const m=market.toLowerCase().trim(), s=String(selection||'').toLowerCase().trim();
  if (!s) return {outcome:'manual_review',actualOutcome:'missing_selection',voidReason:`Missing exact selection for market: ${market}`,roi:0};
  const total=home+away, homeWin=home>away, awayWin=away>home, draw=home===away;
  const homeSel=/\b(home|home win|1)\b/.test(s), awaySel=/\b(away|away win|2)\b/.test(s), drawSel=/^draw$/.test(s);

  if (m.includes('1x2')||m.includes('match result')||m==='result') {
    if(homeSel)return homeWin?{outcome:'won',actualOutcome:'home_win',roi:0}:{outcome:'lost',actualOutcome:draw?'draw':'away_win',roi:-1};
    if(awaySel)return awayWin?{outcome:'won',actualOutcome:'away_win',roi:0}:{outcome:'lost',actualOutcome:draw?'draw':'home_win',roi:-1};
    if(drawSel)return draw?{outcome:'won',actualOutcome:'draw',roi:0}:{outcome:'lost',actualOutcome:homeWin?'home_win':'away_win',roi:-1};
    return {outcome:'manual_review',actualOutcome:'unknown_1x2_selection',voidReason:`Unrecognized 1X2 selection: ${selection}`,roi:0};
  }
  if(m.includes('dnb')||m.includes('draw no bet')) {
    if(homeSel)return homeWin?{outcome:'won',actualOutcome:'home_win',roi:0}:draw?{outcome:'void',actualOutcome:'draw',voidReason:'DNB — draw refunds stake',roi:0}:{outcome:'lost',actualOutcome:'away_win',roi:-1};
    if(awaySel)return awayWin?{outcome:'won',actualOutcome:'away_win',roi:0}:draw?{outcome:'void',actualOutcome:'draw',voidReason:'DNB — draw refunds stake',roi:0}:{outcome:'lost',actualOutcome:'home_win',roi:-1};
    return {outcome:'manual_review',actualOutcome:'unknown_dnb_selection',voidReason:`Unrecognized DNB selection: ${selection}`,roi:0};
  }
  if(m.includes('btts')||m.includes('both teams')) { const yes=home>0&&away>0; if(/\byes\b/.test(s))return yes?{outcome:'won',actualOutcome:'btts_yes',roi:0}:{outcome:'lost',actualOutcome:'btts_no',roi:-1}; if(/\bno\b/.test(s))return !yes?{outcome:'won',actualOutcome:'btts_no',roi:0}:{outcome:'lost',actualOutcome:'btts_yes',roi:-1}; return {outcome:'manual_review',actualOutcome:'unknown_btts_selection',voidReason:`Unrecognized BTTS selection: ${selection}`,roi:0}; }
  if(/under\s*2\.5/.test(`${m} ${s}`))return total<2.5?{outcome:'won',actualOutcome:'under_2.5',roi:0}:{outcome:'lost',actualOutcome:'over_2.5',roi:-1};
  if(/over\s*2\.5/.test(`${m} ${s}`))return total>2.5?{outcome:'won',actualOutcome:'over_2.5',roi:0}:{outcome:'lost',actualOutcome:'under_2.5',roi:-1};
  if(/under\s*3\.5/.test(`${m} ${s}`))return total<3.5?{outcome:'won',actualOutcome:'under_3.5',roi:0}:{outcome:'lost',actualOutcome:'over_3.5',roi:-1};
  if(/over\s*3\.5/.test(`${m} ${s}`))return total>3.5?{outcome:'won',actualOutcome:'over_3.5',roi:0}:{outcome:'lost',actualOutcome:'under_3.5',roi:-1};
  if(m.includes('double chance')||/^(1x|x2|12)$/.test(s)) { if(s==='1x')return homeWin||draw?{outcome:'won',actualOutcome:'1x',roi:0}:{outcome:'lost',actualOutcome:'away_win',roi:-1}; if(s==='x2')return awayWin||draw?{outcome:'won',actualOutcome:'x2',roi:0}:{outcome:'lost',actualOutcome:'home_win',roi:-1}; if(s==='12')return !draw?{outcome:'won',actualOutcome:'12',roi:0}:{outcome:'lost',actualOutcome:'draw',roi:-1}; return {outcome:'manual_review',actualOutcome:'unknown_double_chance_selection',voidReason:`Unrecognized double chance selection: ${selection}`,roi:0}; }
  if(m.includes('asian')||m.includes('handicap')||/[+-]\s*\d+(?:\.\d+)?/.test(s)) return settleAsianHandicap(`${market} ${selection}`,home,away);
  return {outcome:'manual_review',actualOutcome:'unsupported_market',voidReason:`Automatic settlement not implemented for: ${market} / ${selection}`,roi:0};
}

function settleAsianHandicap(text:string,home:number,away:number):SettlementResult {
  const t=text.toLowerCase(); const match=t.match(/([+-]?\d+(?:\.\d+)?)/); if(!match)return{outcome:'manual_review',actualOutcome:'unknown_ah',voidReason:'Could not parse handicap line',roi:0};
  const line=Number(match[1]), isAway=t.includes('away'), margin=isAway?away-home+line:home-away+line;
  if(margin>0.25)return{outcome:'won',actualOutcome:`ah_${isAway?'away':'home'}_${line}`,roi:0};
  if(margin<-0.25)return{outcome:'lost',actualOutcome:`ah_${isAway?'away':'home'}_${line}`,roi:-1};
  if(margin===0)return{outcome:'push',actualOutcome:`ah_${isAway?'away':'home'}_${line}`,voidReason:'Asian Handicap push — stake refunded',roi:0};
  if(margin===0.25)return{outcome:'half_win',actualOutcome:`ah_${isAway?'away':'home'}_${line}`,voidReason:'Asian Handicap half-win',roi:0.5};
  if(margin===-0.25)return{outcome:'half_loss',actualOutcome:`ah_${isAway?'away':'home'}_${line}`,voidReason:'Asian Handicap half-loss',roi:-0.5};
  return{outcome:'manual_review',actualOutcome:'unresolved_ah',voidReason:`Unresolved handicap margin: ${margin}`,roi:0};
}

async function applySettlement(pick:PendingPick,settlement:SettlementResult,score:ScoreResult,selection:string|null):Promise<void> {
  const odds=Number(pick.recommended_odds)||0; let roi=settlement.roi;
  if(settlement.outcome==='won'&&odds>1)roi=odds-1;
  if(settlement.outcome==='half_win'&&odds>1)roi=(odds-1)*0.5;
  if(settlement.outcome==='half_loss')roi=-0.5;
  const status=settlement.outcome==='manual_review'?'manual_review':settlement.outcome;
  await query(`UPDATE predictions SET status=?,actual_result=?,roi=?,closing_odds=COALESCE(closing_odds,recommended_odds) WHERE id=?`,[status,settlement.actualOutcome,roi,pick.id]);
  await logResult({predictionId:pick.id,fixture:pick.fixture,market:pick.prediction_market,selection:selection||'',actualOutcome:settlement.actualOutcome,result:settlement.outcome,voidReason:settlement.voidReason||'',finalScore:`${score.homeScore}-${score.awayScore}`,roi}).catch(err=>console.error('[Settlement] Airtable log error:',err instanceof Error?err.message:String(err)));
  console.log(`[Settlement] ${pick.fixture} | ${pick.prediction_market} | ${selection||'MISSING'} -> ${settlement.outcome} | ${score.homeScore}-${score.awayScore} | ROI ${roi}`);
}

async function flagManualReview(predictionId:string,reason:string):Promise<void> { await query('UPDATE predictions SET status=? WHERE id=?',['manual_review',predictionId]); await logResult({predictionId,fixture:'',market:'',selection:'',actualOutcome:'no_score',result:'manual_review',voidReason:reason,finalScore:'',roi:0}).catch(()=>{}); console.warn(`[Settlement] ${predictionId} manual review: ${reason}`); }
