import { request } from 'node:https';

export interface FinalScoreResult {
  success: boolean;
  data: string;
  source?: string;
  error?: string;
}

const ALLSPORTS_URL = 'https://apiv2.allsportsapi.com/football/';
const TIMEOUT_MS = 12_000;

function keys(): string[] {
  const raw = process.env.ALL_SPORTS_APIs || process.env.ALL_SPORTS_API_KEYS || process.env.ALLSPORTS_API_KEYS || process.env.ALL_SPORTS_API_KEY || '';
  return raw.split(',').map(v => v.trim()).filter(Boolean);
}

async function getJson(url: string): Promise<any> {
  return await new Promise((resolve, reject) => {
    const req = request(url, { headers: { Accept: 'application/json', 'User-Agent': 'Odessyus/1.0' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('finished-score request timeout')));
    req.on('error', reject);
    req.end();
  });
}

export async function fetchFinishedScores(dateFrom: string, dateTo = dateFrom): Promise<FinalScoreResult> {
  const apiKeys = keys();
  if (!apiKeys.length) return { success: false, data: '', source: 'allsports-final', error: 'No ALL_SPORTS API key configured' };

  for (const key of apiKeys) {
    try {
      const url = new URL(ALLSPORTS_URL);
      url.searchParams.set('met', 'Fixtures');
      url.searchParams.set('APIkey', key);
      url.searchParams.set('from', dateFrom);
      url.searchParams.set('to', dateTo);
      const payload = await getJson(url.toString());
      if (!payload?.success || !Array.isArray(payload.result)) continue;
      const lines = payload.result.map((event: any) => {
        const homeScore = event.event_home_final_score ?? event.event_home_team_score ?? event.event_home_team_ft_score;
        const awayScore = event.event_away_final_score ?? event.event_away_team_score ?? event.event_away_team_ft_score;
        return [
          event.event_date,
          event.event_time || '',
          event.event_home_team || '',
          event.event_away_team || '',
          homeScore ?? '',
          awayScore ?? '',
          event.event_status || '',
          event.event_league_name || event.league_name || '',
        ].join(' | ');
      });
      return { success: true, data: lines.join('\n'), source: 'allsports-final' };
    } catch {
      // Rotate to the next configured key.
    }
  }

  return { success: false, data: '', source: 'allsports-final', error: 'All finished-score API requests failed' };
}
