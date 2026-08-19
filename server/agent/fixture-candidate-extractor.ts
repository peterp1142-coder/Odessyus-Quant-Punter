/**
 * Deterministic fixture extraction used as a safety net before the LLM discovery gate.
 * It never invents a fixture: every candidate must contain both team names and a
 * concrete date/time token present in the supplied source text.
 */

export interface FixtureCandidate {
  fixture: string;
  kickoff: string;
  status: string;
  competition?: string;
  source: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isoForMarketDate(date: string, time: string, timeZone: string): string | null {
  const m = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Interpret a bare kickoff time as being in the requested market timezone.
  // This is important for schedule pages/APIs that return `18:00` without a TZ.
  const probe = new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}Z`);
  if (Number.isNaN(probe.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(probe);
  const get = (type: string) => parts.find(p => p.type === type)?.value;
  const asLocal = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}Z`;
  const localAtProbe = new Date(asLocal).getTime();
  const desiredLocal = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), hour, minute, second);
  const offsetMs = localAtProbe - probe.getTime();
  return new Date(desiredLocal - offsetMs).toISOString();
}

function isoFromExplicitDateTime(value: string, matchDate: string, timeZone: string): string | null {
  const raw = value.trim().replace(/\s+/g, ' ');
  const dateMatch = raw.match(/(\d{4}-\d{2}-\d{2})/);
  const timeMatch = raw.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/);
  if (!timeMatch) return null;
  const date = dateMatch?.[1] || matchDate;
  if (date !== matchDate) return null;
  const tz = raw.match(/(?:Z|UTC|GMT|[+-]\d{2}:?\d{2})\b/i)?.[0];
  if (tz && !/^UTC$|^GMT$/i.test(tz)) {
    const iso = `${date}T${timeMatch[1]}${tz.toUpperCase() === 'Z' ? 'Z' : tz}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return isoForMarketDate(date, timeMatch[1], timeZone);
}

function cleanTeam(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[|•·]+$/g, '')
    .replace(/^[-–—:]+|[-–—:]+$/g, '')
    .replace(/\s+(?:\([^)]*\)|\[[^\]]*\])\s*$/g, '')
    .trim();
}

function addCandidate(out: FixtureCandidate[], seen: Set<string>, fixture: string, kickoff: string, source: string, competition?: string) {
  const [home, away] = fixture.split(/\s+vs\s+/i).map(cleanTeam);
  if (!home || !away || home.length < 2 || away.length < 2 || home.length > 90 || away.length > 90) return;
  if (/^(home|away|team\s*[ab]|score|odds|fixtures?|matches?|kickoff|today)$/i.test(home)) return;
  if (/^(home|away|team\s*[ab]|score|odds|fixtures?|matches?|kickoff|today)$/i.test(away)) return;
  if (/\b(?:odds|prediction|tip|result|score)\b/i.test(home) && home.length < 35) return;
  const normalized = `${home.toLowerCase()} vs ${away.toLowerCase()}|${kickoff}`;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  out.push({ fixture: `${home} vs ${away}`, kickoff, status: 'scheduled', competition, source });
}

export function extractFixtureCandidates(text: string, matchDate: string, timeZone: string, source = 'schedule'): FixtureCandidate[] {
  const out: FixtureCandidate[] = [];
  const seen = new Set<string>();
  const input = text.replace(/\r/g, '\n');

  // AllSports/API format: 2026-08-19 18:00:00 | Home vs Away | League | status
  const allSports = new RegExp(`${escapeRegExp(matchDate)}\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)(?:\\s*(?:UTC|GMT|Z))?\\s*\\|\\s*([^|\\n]+?)\\s+vs\\s+([^|\\n]+?)\\s*\\|\\s*([^\\n(]+)`, 'gi');
  for (const m of input.matchAll(allSports)) {
    const kickoff = isoFromExplicitDateTime(`${matchDate} ${m[1]}`, matchDate, timeZone);
    if (kickoff) addCandidate(out, seen, `${m[2]} vs ${m[3]}`, kickoff, source, cleanTeam(m[4]));
  }

  // Generic ISO/date-time layouts, including `2026-08-19T18:00Z` and
  // `2026-08-19 18:00 UTC`, with the fixture on the same line.
  const datedVs = new RegExp(`([^\\n|]{2,90}?)\\s+(?:vs\\.?|v\\.?)\\s+([^\\n|]{2,90}?)\\s+[^\\n|]{0,30}?(\\d{4}-\\d{2}-\\d{2}[^\\n|]{0,20}?(?:\\d{1,2}:\\d{2})(?:\\s*(?:UTC|GMT|Z|[+-]\\d{2}:?\\d{2}))?)`, 'gi');
  for (const m of input.matchAll(datedVs)) {
    const kickoff = isoFromExplicitDateTime(m[3], matchDate, timeZone);
    if (kickoff) addCandidate(out, seen, `${m[1]} vs ${m[2]}`, kickoff, source);
  }

  // Fixture first, time last: `Celtic vs LASK 18:00`, optionally with UTC.
  const explicitVs = new RegExp(`([^\\n|]{2,90}?)\\s+(?:vs\\.?|v\\.?)\\s+([^\\n|]{2,90}?)\\s+(?:[-|•·]?\\s*)?(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(?:UTC|GMT|Z|[+-]\\d{2}:?\\d{2})?\\b`, 'gi');
  for (const m of input.matchAll(explicitVs)) {
    const kickoff = isoFromExplicitDateTime(`${matchDate} ${m[3]}`, matchDate, timeZone);
    if (kickoff) addCandidate(out, seen, `${m[1]} vs ${m[2]}`, kickoff, source);
  }

  // Time first: `18:00 Celtic vs LASK`.
  const timeFirst = new RegExp(`\\b(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*(?:UTC|GMT|Z|[+-]\\d{2}:?\\d{2})?\\s+([^\\n|]{2,90}?)\\s+(?:vs\\.?|v\\.?)\\s+([^\\n|]{2,90})`, 'gi');
  for (const m of input.matchAll(timeFirst)) {
    const kickoff = isoFromExplicitDateTime(`${matchDate} ${m[1]}`, matchDate, timeZone);
    if (kickoff) addCandidate(out, seen, `${m[2]} vs ${m[3]}`, kickoff, source);
  }

  // Dash layouts commonly emitted by score/fixture pages: `Home - Away 18:00`.
  const dashLayout = new RegExp(`([^\\n|]{2,80}?)\\s+(?:-|–|—)\\s+([^\\n|]{2,80}?)\\s+.*?\\b(\\d{1,2}:\\d{2}(?::\\d{2})?)\\b`, 'gi');
  for (const m of input.matchAll(dashLayout)) {
    const kickoff = isoFromExplicitDateTime(`${matchDate} ${m[3]}`, matchDate, timeZone);
    if (kickoff) addCandidate(out, seen, `${m[1]} vs ${m[2]}`, kickoff, source);
  }

  return out.slice(0, 150);
}

export function serializeFixtureCandidates(candidates: FixtureCandidate[]): string {
  return JSON.stringify({
    fixtures: candidates.map(({ fixture, kickoff, status, competition }) => {
      const [home, away] = fixture.split(/\s+vs\s+/i);
      return {
        fixture,
        homeTeam: { name: home },
        awayTeam: { name: away },
        kickoff,
        status,
        competition: competition ? { name: competition } : undefined,
      };
    }),
  });
}
