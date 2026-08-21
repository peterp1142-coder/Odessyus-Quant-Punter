import { serpSearch, taloredataSearch, webSearch } from './tools.js';

export interface ManagerIntel {
  player: string;
  club: string;
  sentiment: 'strong_positive' | 'positive' | 'neutral' | 'uncertain' | 'negative' | 'strong_negative';
  roleSecurity: number;
  minutesRisk: number;
  tacticalUpside: number;
  quoteSignals: string[];
  latestEvidence: string[];
  freshnessDays: number | null;
  confidence: number;
}

const positive = ['will start','will play','first choice','back in contention','ready to play','our starting','important player','key player','can play in two positions','higher up the pitch','more advanced','penalties','set pieces','corner','free-kick'];
const negative = ['not ready','not available','will not play','won’t play','out','ruled out','needs more time','manage his minutes','minutes restriction','rotation','competition for his place','doubtful'];

function classify(text: string) {
  const t = text.toLowerCase();
  const pos = positive.filter(x => t.includes(x));
  const neg = negative.filter(x => t.includes(x));
  let sentiment: ManagerIntel['sentiment'] = 'neutral';
  if (neg.length >= 2 && pos.length === 0) sentiment = 'strong_negative';
  else if (neg.length > pos.length) sentiment = 'negative';
  else if (pos.length >= 2 && neg.length === 0) sentiment = 'strong_positive';
  else if (pos.length > neg.length) sentiment = 'positive';
  else if (neg.length === 1 || pos.length === 1) sentiment = 'uncertain';
  const roleSecurity = Math.max(0, Math.min(1, 0.5 + pos.length * 0.10 - neg.length * 0.14));
  const minutesRisk = Math.max(0, Math.min(1, neg.length * 0.16 - pos.length * 0.06));
  const tacticalUpside = Math.max(0, Math.min(1,
    0.25 +
      (t.includes('higher up') || t.includes('more advanced') || t.includes('second striker') || t.includes('set pieces') || t.includes('penalt') ? 0.35 : 0) +
      (t.includes('two positions') || t.includes('multiple positions') ? 0.15 : 0)
  ));
  return {
    sentiment,
    roleSecurity,
    minutesRisk,
    tacticalUpside,
    quoteSignals: [...pos.map(x => `positive:${x}`), ...neg.map(x => `negative:${x}`)]
  };
}

async function search(query: string) {
  const results = await Promise.allSettled([serpSearch(query), taloredataSearch(query), webSearch(query)]);
  return results
    .filter(r => r.status === 'fulfilled' && r.value.success)
    .map(r => (r as PromiseFulfilledResult<any>).value.data)
    .join('\n--- INDEPENDENT SOURCE ---\n')
    .slice(0, 9000);
}

export async function analyzeFplManagerIntel(
  players: Array<{ player: string; club: string }>
): Promise<{ success: boolean; data: ManagerIntel[]; source: string; error?: string }> {
  const out: ManagerIntel[] = [];
  for (const item of players.slice(0, 20)) {
    try {
      const q = `${item.player} ${item.club} manager press conference 2026/27 FPL start role minutes rotation injury set pieces site:premierleague.com OR site:${item.club.toLowerCase().replace(/\s+/g, '')}.com`;
      const evidence = await search(q);
      const c = classify(evidence);
      const daysMatch = evidence.match(/(\d+)\s+days?\s+ago/i);
      const freshnessDays = daysMatch ? Number(daysMatch[1]) : null;
      const confidence = Math.max(
        0.2,
        Math.min(0.95, (evidence.length > 1200 ? 0.82 : 0.55) - (freshnessDays !== null && freshnessDays > 7 ? 0.2 : 0))
      );
      out.push({
        ...item,
        ...c,
        latestEvidence: evidence.split('\n--- INDEPENDENT SOURCE ---\n').filter(Boolean).slice(0, 3),
        freshnessDays,
        confidence
      });
    } catch {
      out.push({
        player: item.player,
        club: item.club,
        sentiment: 'uncertain',
        roleSecurity: 0.5,
        minutesRisk: 0.3,
        tacticalUpside: 0.25,
        quoteSignals: [],
        latestEvidence: [],
        freshnessDays: null,
        confidence: 0.2
      });
    }
  }
  return { success: true, data: out, source: 'FPLManagerIntel' };
}
