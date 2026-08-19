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

function cleanTeam(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[|•·]+$/g, '').trim().replace(/^[-–—:]+|[-–—:]+$/g, '').trim();
}

function addCandidate(out: FixtureCandidate[], seen: Set<string>, fixture: string, kickoff: string, source: string, competition?: string) {
  const [home, away] = fixture.split(/\s+vs\s+/i).map(cleanTeam);
  if (!home || !away || home.length < 2 || away.length < 2 || home.length > 90 || away.length > 90) return;
  if (/^(home|away|team\s*[ab]|score|odds|fixtures?|matches?)$/i.test(home)) return;
  const normalized = `${home.toLowerCase()} vs ${away.toLowerCase()}|${kickoff}`;
  if (seen.has(normalized)) return;
  seen.add(normalized);
  out.push({ fixture: `${home} vs ${away}`, kickoff, status: 'scheduled', competition, source });
}

export function extractFixtureCandidates(text: string, matchDate: string, timeZone: string, source = 'schedule'): FixtureCandidate[] {
  const out: FixtureCandidate[] = [];
  const seen = new Set<string>();
  const input = text.replace(/\r/g, '\n');

  const allSports = new RegExp(`${escapeRegExp(matchDate)}\\s+(\\d{1,2}:\\d{2}(?::\\d{2})?)\\s*\\|\\s*([^|\\n]+?)\\s+vs\\s+([^|\\n]+?)\\s*\\|\\s*([^\\n(]+)`, 'gi');
  for (const m of input.matchAll(allSports)) {
    const kickoff = isoForMarketDate(matchDate, m[1], timeZone);
    if (kickoff) addCandidate(out, seen, `${m[2]} vs ${m[3]}`, kickoff, source, cleanTeam(m[4]));
  }

  const explicitVs = new RegExp(`([^\\n|]{2,80}?)\\s+(?:vs\\.?|v\\.?)\\s+([^\\n|]{2,80}?)\\s+(?:[-|•·]?\\s*)?(\\d{1,2}:\\d{2})\\b`, 'gi');
  for (const m of input.matchAll(explicitVs)) {
    const kickoff = isoForMarketDate(matchDate, m[3], timeZone);
    if (kickoff) addCandidate(out, seen, `${m[1]} vs ${m[2]}`, kickoff, source);
  }

  const timeFirst = new RegExp(`\\b(\\d{1,2}:\\d{2})\\b\\s+([^\\n|]{2,80}?)\\s+(?:vs\\.?|v\\.?)\\s+([^\\n|]{2,80})`, 'gi');
  for (const m of input.matchAll(timeFirst)) {
    const kickoff = isoForMarketDate(matchDate, m[1], timeZone);
    if (kickoff) addCandidate(out, seen, `${m[2]} vs ${m[3]}`, kickoff, source);
  }

  const dashLayout = new RegExp(`([^\\n|]{2,70}?)\\s+(?:-|–|—)\\s+([^\\n|]{2,70}?)\\s+.*?\\b(\\d{1,2}:\\d{2})\\b`, 'gi');
  for (const m of input.matchAll(dashLayout)) {
    const kickoff = isoForMarketDate(matchDate, m[3], timeZone);
    if (kickoff) addCandidate(out, seen, `${m[1]} vs ${m[2]}`, kickoff, source);
  }

  return out.slice(0, 100);
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
