export interface SemanticFixtureInput { fixture: string; home?: string; away?: string; }
export interface SemanticFixtureDecision { accepted: boolean; reason: string; confidence: number; canonical?: string; }

const BAD_SIDE_PATTERNS = [
  /\b(?:EDT|EST|CST|PST|UTC|GMT|BST)\b/i,
  /\b(?:\d{1,2}:\d{2}(?:\s*(?:EDT|EST|CST|PST|UTC|GMT|BST))?|\d{4}-\d{2}-\d{2})\b/i,
  /\b(?:today|tomorrow|yesterday)\b/i,
  /\b(?:the guardian|bbc|sky sports|espn|sofascore|flashscore|goal\.com|skysports)\b/i,
  /(?:^|\s)(?:football|fixtures?|matches?|schedule|kick.?off|live score|odds)(?:\s|$)/i,
  /\b(?:premier league|championship|league one|league two|serie a|serie b|la liga|bundesliga|ligue 1|eredivisie|primeira liga|uefa|fifa)\b/i,
];
const CONTAMINATION_SHAPE = /(?:\b(?:EDT|EST|CST|PST|UTC|GMT|BST)\b|\b\d{1,2}:\d{2}\b|[·|].*(?:vs\.?|v\.?))/i;

function splitFixture(fixture:string): [string,string] { const m=fixture.match(/^(.{2,100}?)\s+(?:vs\.?|v\.?)\s+(.{2,100}?)$/i); return [m?.[1]?.trim()||'',m?.[2]?.trim()||'']; }
function norm(v:string):string { return v.toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]+/g,' ').trim(); }

export function semanticFixtureIdentity(input: SemanticFixtureInput): SemanticFixtureDecision {
  const raw=String(input.fixture||'').replace(/\s+/g,' ').trim();
  const [home,away]=input.home&&input.away?[input.home.trim(),input.away.trim()]:splitFixture(raw);
  if(!home||!away) return {accepted:false,reason:'fixture_not_two_sides',confidence:1};
  if(home.length>70||away.length>70) return {accepted:false,reason:'side_too_long_or_contaminated',confidence:.99};
  if(norm(home)===norm(away)) return {accepted:false,reason:'identical_sides',confidence:1};
  if(BAD_SIDE_PATTERNS.some(r=>r.test(home))||BAD_SIDE_PATTERNS.some(r=>r.test(away))) return {accepted:false,reason:'non_team_or_source_text_side',confidence:.99};
  if(CONTAMINATION_SHAPE.test(raw)) return {accepted:false,reason:'search_result_metadata_contamination',confidence:.98};
  return {accepted:true,reason:'two plausible named football sides',confidence:.75,canonical:`${home} vs ${away}`};
}
