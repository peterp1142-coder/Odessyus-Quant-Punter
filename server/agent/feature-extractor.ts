/** Evidence-backed feature extraction. Missing evidence lowers completeness; it never means zero team strength. */
import { mistralPool } from './mistral-pool.js';
import type { MarketSignals, FormSignals, InjurySignals, SentimentSignals, AdvancedSignals } from './scorer.js';

export interface ExtractedFeatures { form:FormSignals; market:MarketSignals; injury:InjurySignals; sentiment:SentimentSignals; advanced:AdvancedSignals; evidenceReady:boolean; }
const clamp=(v:number,lo:number,hi:number)=>Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):(lo+hi)/2;
const finite=(v:unknown):number|undefined=>{const n=typeof v==='number'?v:parseFloat(String(v??''));return Number.isFinite(n)?n:undefined;};
const num=(v:unknown,d:number)=>finite(v) ?? d;
const present=(j:Record<string,unknown>,keys:string[])=>keys.filter(k=>j[k]!==null&&j[k]!==undefined&&finite(j[k])!==undefined).length;

export async function extractFeatures(opts:{formText:string;oddsText:string;injuryText:string;sentimentText:string;advancedText?:string;fixture:string;market:string;}):Promise<ExtractedFeatures>{
 const{formText,oddsText,injuryText,sentimentText,advancedText='',fixture,market}=opts;
 const prompt=`Extract numeric signals ONLY from supplied reports. NEVER invent values. Preserve null when the report does not support a field.
FIXTURE: ${fixture}\nTARGET MARKET: ${market}
=== FORM ===\n${formText.slice(0,4500)}\n=== ODDS ===\n${oddsText.slice(0,3800)}\n=== INJURY/LINEUP ===\n${injuryText.slice(0,3200)}\n=== CONTEXT/ADVANCED ===\n${advancedText.slice(0,5000)}
Return JSON with these exact fields: xgHome,xgAway,xgConcededHome,xgConcededAway,goalsScoredLast5Home,goalsScoredLast5Away,goalsConcededLast5Home,goalsConcededLast5Away,formPtsHome,formPtsAway,h2hWinRateHome,homeWinPctVenue,awayWinPctVenue,streakHome,streakAway,restDaysHome,restDaysAway,impliedProbHome,impliedProbDraw,impliedProbAway,selectionOdds,selectionImpliedProb,openingOddsHome,currentOddsHome,pinnacleOdds,overround,reverseLM,lineMovement,injuryIndexHome,injuryIndexAway,absentPlayerRatingHome,absentPlayerRatingAway,gtdRiskHome,gtdRiskAway,motivationHome,motivationAway,weatherImpact,refBias,crowdFactor,tacticalEdge,refereeRelevance,lineupQualityHome,lineupQualityAway,marketLiquidity,bookmakerDispersion,modelRiskScore,dataQualityScore.`;
 try{
  const r=await mistralPool.call(c=>c.chat.complete({model:'mistral-small-latest',messages:[{role:'system',content:'Parse only supplied evidence. JSON only. Preserve nulls. Do not turn missing data into zero.'},{role:'user',content:prompt}] as any,temperature:0,maxTokens:1400}));
  const raw=r.choices?.[0]?.message?.content||'';const m=typeof raw==='string'?raw.match(/\{[\s\S]+\}/):null;if(!m)throw new Error('No JSON');
  const j=JSON.parse(m[0]) as Record<string,unknown>;
  const goalsHome=finite(j.goalsScoredLast5Home);const goalsAway=finite(j.goalsScoredLast5Away);const concededHome=finite(j.goalsConcededLast5Home);const concededAway=finite(j.goalsConcededLast5Away);
  const xgHome=finite(j.xgHome) ?? (goalsHome!==undefined ? goalsHome/5 : 1.15);
  const xgAway=finite(j.xgAway) ?? (goalsAway!==undefined ? goalsAway/5 : 1.10);
  const xgcHome=finite(j.xgConcededHome) ?? (concededHome!==undefined ? concededHome/5 : 1.15);
  const xgcAway=finite(j.xgConcededAway) ?? (concededAway!==undefined ? concededAway/5 : 1.15);
  const formKeys=['xgHome','xgAway','xgConcededHome','xgConcededAway','formPtsHome','formPtsAway','h2hWinRateHome','homeWinPctVenue','awayWinPctVenue','streakHome','streakAway','restDaysHome','restDaysAway'];
  const oddsKeys=['selectionOdds','selectionImpliedProb','currentOddsHome','openingOddsHome','pinnacleOdds','overround','reverseLM','lineMovement'];
  const injuryKeys=['injuryIndexHome','injuryIndexAway','absentPlayerRatingHome','absentPlayerRatingAway','gtdRiskHome','gtdRiskAway'];
  const sentimentKeys=['motivationHome','motivationAway','weatherImpact','refBias','crowdFactor'];
  const advancedKeys=['tacticalEdge','refereeRelevance','lineupQualityHome','lineupQualityAway','marketLiquidity','bookmakerDispersion','modelRiskScore','dataQualityScore'];
  const q=(keys:string[])=>present(j,keys)/keys.length;
  // A prediction can be produced from available form/goal evidence without prices or calibration.
  const evidenceReady=(goalsHome!==undefined||finite(j.xgHome)!==undefined)&&(goalsAway!==undefined||finite(j.xgAway)!==undefined);
  return {
   form:{xgHome:clamp(xgHome,0.15,5),xgAway:clamp(xgAway,0.15,5),xgConcededHome:clamp(xgcHome,0.15,5),xgConcededAway:clamp(xgcAway,0.15,5),formPtsHome:clamp(num(j.formPtsHome,7.5),0,15),formPtsAway:clamp(num(j.formPtsAway,7.5),0,15),h2hWinRateHome:clamp(num(j.h2hWinRateHome,.5),0,1),homeWinPctVenue:clamp(num(j.homeWinPctVenue,.5),0,1),awayWinPctVenue:clamp(num(j.awayWinPctVenue,.5),0,1),streakHome:clamp(num(j.streakHome,0),-5,5),streakAway:clamp(num(j.streakAway,0),-5,5),restDaysHome:clamp(num(j.restDaysHome,7),0,21),restDaysAway:clamp(num(j.restDaysAway,7),0,21),formDataQuality:q(formKeys)},
   market:{impliedProbHome:j.impliedProbHome==null?0:clamp(num(j.impliedProbHome,.34),.01,.99),impliedProbDraw:j.impliedProbDraw==null?undefined:clamp(num(j.impliedProbDraw,.33),.01,.99),impliedProbAway:j.impliedProbAway==null?undefined:clamp(num(j.impliedProbAway,.33),.01,.99),selectionOdds:j.selectionOdds==null?undefined:clamp(num(j.selectionOdds,0),1.01,50),selectionImpliedProb:j.selectionImpliedProb==null?undefined:clamp(num(j.selectionImpliedProb,0),.01,.99),reverseLM:Boolean(j.reverseLM),lineMovement:clamp(num(j.lineMovement,0),-1,1),oddsDataQuality:q(oddsKeys),openingOddsHome:num(j.openingOddsHome,0),currentOddsHome:num(j.currentOddsHome,0),pinnacleOdds:num(j.pinnacleOdds,0),overround:j.overround==null?undefined:clamp(num(j.overround,0),0,.2)},
   injury:{injuryIndexHome:clamp(num(j.injuryIndexHome,0),0,10),injuryIndexAway:clamp(num(j.injuryIndexAway,0),0,10),absentPlayerRatingHome:clamp(num(j.absentPlayerRatingHome,0),0,10),absentPlayerRatingAway:clamp(num(j.absentPlayerRatingAway,0),0,10),gtdRiskHome:clamp(num(j.gtdRiskHome,0),0,1),gtdRiskAway:clamp(num(j.gtdRiskAway,0),0,1),injuryDataQuality:q(injuryKeys)},
   sentiment:{motivationHome:clamp(num(j.motivationHome,.5),0,1),motivationAway:clamp(num(j.motivationAway,.5),0,1),weatherImpact:clamp(num(j.weatherImpact,0),-.5,.5),refBias:clamp(num(j.refBias,0),-.3,.3),crowdFactor:clamp(num(j.crowdFactor,0),0,1),sentimentDataQuality:q(sentimentKeys)},
   advanced:{tacticalEdge:clamp(num(j.tacticalEdge,0),-.25,.25),refereeRelevance:clamp(num(j.refereeRelevance,0),0,1),lineupQualityHome:clamp(num(j.lineupQualityHome,5),0,10),lineupQualityAway:clamp(num(j.lineupQualityAway,5),0,10),marketLiquidity:clamp(num(j.marketLiquidity,0),0,1),bookmakerDispersion:clamp(num(j.bookmakerDispersion,0),0,1),modelRiskScore:clamp(num(j.modelRiskScore,1),0,1),dataQualityScore:clamp(num(j.dataQualityScore,0),0,1),dataQuality:q(advancedKeys)},
   evidenceReady
  };
 }catch{
  return {form:{xgHome:1.15,xgAway:1.10,xgConcededHome:1.15,xgConcededAway:1.15,formPtsHome:7.5,formPtsAway:7.5,h2hWinRateHome:.5,homeWinPctVenue:.5,awayWinPctVenue:.5,streakHome:0,streakAway:0,restDaysHome:7,restDaysAway:7,formDataQuality:0},market:{impliedProbHome:0,reverseLM:false,lineMovement:0,oddsDataQuality:0},injury:{injuryIndexHome:0,injuryIndexAway:0,gtdRiskHome:0,gtdRiskAway:0,injuryDataQuality:0},sentiment:{motivationHome:.5,motivationAway:.5,weatherImpact:0,refBias:0,sentimentDataQuality:0,crowdFactor:0},advanced:{tacticalEdge:0,refereeRelevance:0,lineupQualityHome:5,lineupQualityAway:5,marketLiquidity:0,bookmakerDispersion:0,modelRiskScore:1,dataQualityScore:0,dataQuality:0},evidenceReady:false};
 }
}
