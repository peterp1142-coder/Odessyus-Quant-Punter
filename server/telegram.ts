import { Telegraf } from 'telegraf';
import { v4 as uuidv4 } from 'uuid';
import { runOrchestrator } from './agent/orchestrator.js';
import type { ReActStep } from './agent/react-engine.js';
import { query } from './db/index.js';
import { getCurrentSeason } from './agent/prompts.js';

let bot: Telegraf | null = null;

const SUBAGENT_STATUS: Record<string, string> = {
  '📊 ODDS':      '📊 Scanning odds & market signals...',
  '📈 FORM':      '📈 Gathering team form & H2H stats...',
  '🏥 INJURY':    '🏥 Checking injury reports & lineups...',
  '📰 SENTIMENT': '📰 Analyzing news & external factors...',
  '⚡ QUANT':     '⚡ Running Monte Carlo synthesis...',
};

function getStatusFromStep(step: ReActStep): string | null {
  if (step.type !== 'action') return null;
  for (const [prefix, label] of Object.entries(SUBAGENT_STATUS)) {
    if (step.content.includes(prefix)) return label;
  }
  return null;
}

function formatForTelegram(finalAnswer: string, meta: Record<string, unknown>): string {
  const stars = '⭐'.repeat(Number(meta.starRating) || 0);
  const ev = meta.expectedValue ? `+${(Number(meta.expectedValue) * 100).toFixed(2)}%` : '';
  const header = stars || ev ? `${stars} ${ev ? `EV: ${ev}` : ''}`.trim() + '\n\n' : '';

  return (
    header +
    finalAnswer
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim()
  );
}

export function initTelegram(): Telegraf | null {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN;
  if (!token) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN/TELEGRAM_TOKEN — bot disabled');
    return null;
  }

  bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply(
    'Welcome to Odessyus v2.0 — Multi-Subagent Sports Intelligence\n\n' +
    'I run 4 specialized subagents in parallel:\n' +
    '📊 OddsScout — Market & sharp money signals\n' +
    '📈 FormScout — Team form, H2H & xG stats\n' +
    '🏥 InjuryIntel — Injuries, lineups & GTD players\n' +
    '📰 SentimentAgent — News, weather & external factors\n' +
    '⚡ QuantSynthesis — Monte Carlo, EV & star rating\n\n' +
    'Commands:\n/stats — Performance report\n/help — This message\n\n' +
    'Or just send any match prediction request.'
  ));

  bot.help((ctx) => ctx.reply(
    'Odessyus v2.0 — 80-Feature Multi-Subagent Engine\n\n' +
    'Send any sports question:\n' +
    '- "Analyse [Team A] vs [Team B] tonight"\n' +
    '- "Best over/under picks today"\n' +
    '- "Top value bets this weekend"\n' +
    '- "Best bets today" (fetches live fixtures automatically)'
  ));

  bot.command('stats', async (ctx) => {
    try {
      const rows = await query<Record<string, unknown>[]>(`
        SELECT COUNT(*) AS total, SUM(status='won') AS won, SUM(status='lost') AS lost,
               SUM(status='pending') AS pending,
               ROUND(100*SUM(status='won')/NULLIF(SUM(status IN ('won','lost')),0),1) AS win_rate,
               ROUND(AVG(expected_value)*100,2) AS avg_ev,
               ROUND(AVG(star_rating),1) AS avg_stars
        FROM predictions
      `);
      const s = rows[0] || {};
      await ctx.reply(
        `Daily Efficiency Report\n\n` +
        `Total picks: ${s.total ?? 0}\n` +
        `Won: ${s.won ?? 0} | Lost: ${s.lost ?? 0} | Pending: ${s.pending ?? 0}\n` +
        `Win rate: ${s.win_rate ?? 0}%\n` +
        `Avg EV: +${s.avg_ev ?? 0}%\n` +
        `Avg Star Rating: ${s.avg_stars ?? 0}/5`
      );
    } catch { await ctx.reply('Unable to load stats. Please try again.'); }
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    const chatId = String(ctx.message.chat.id);
    if (text.startsWith('/')) return;

    const sessionId = `tg_${chatId}`;
    await ctx.reply('Dispatching 4 parallel subagents... This takes 30–90s.');

    let lastUpdate = Date.now();
    const sentUpdates = new Set<string>();

    try {
      await query(
        'INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), sessionId, 'telegram', 'user', text]
      ).catch(() => {});

      const result = await runOrchestrator(
        text, sessionId,
        async (step: ReActStep) => {
          const statusMsg = getStatusFromStep(step);
          const now = Date.now();
          if (statusMsg && !sentUpdates.has(statusMsg) && now - lastUpdate > 5000) {
            sentUpdates.add(statusMsg);
            lastUpdate = now;
            await ctx.telegram.sendMessage(chatId, statusMsg).catch(() => {});
          }
        }
      );

      if (result.success && result.finalAnswer) {
        const m = result.metadata;
        const formatted = formatForTelegram(result.finalAnswer, m as Record<string, unknown>);
        const MAX = 4000;

        if (formatted.length <= MAX) {
          await ctx.reply(formatted);
        } else {
          for (let i = 0; i < formatted.length; i += MAX) {
            await ctx.reply(formatted.substring(i, i + MAX));
            await new Promise(r => setTimeout(r, 400));
          }
        }

        // Save prediction — truncate free-text fields to column limits
        const predId        = uuidv4();
        const fixtureStr    = String(m.fixture        || '').slice(0, 490);
        const leagueStr     = String(m.sport          || '').slice(0, 190);
        const marketStr     = String(m.market         || '').slice(0, 190);
        const goalStr       = String(m.goalStatement  || '').slice(0, 490);
        const recommendedOdds = m.recommendedOdds > 1
          ? m.recommendedOdds
          : (m.impliedProb > 0 ? parseFloat((1 / m.impliedProb).toFixed(3)) : null);

        await query(
          `INSERT INTO predictions
            (id, session_id, fixture, league, prediction_market, goal_statement,
             probability, confidence_score, star_rating, recommended_odds,
             expected_value, data_completeness_score, status,
             raw_analysis, react_trace, feature_snapshot, model_weights, monte_carlo_variance)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [
            predId, sessionId, fixtureStr, leagueStr, marketStr, goalStr,
            m.probability, m.confidence, m.starRating,
            recommendedOdds,
            m.expectedValue, m.dataCompletenessScore ?? null,
            result.finalAnswer,
            JSON.stringify(result.steps),
            JSON.stringify(result.metadata),
            JSON.stringify({ agentsRun: m.agentsRun, subagentResults: m.subagentResults }),
            m.monteCarlo.stdDev,
          ]
        ).catch(e => console.error('[Telegram] Save prediction:', e));

        // Persist Monte Carlo + market edge into feature_vectors
        try {
          const impliedProbHome = m.impliedProb ?? null;
          const trueProb        = m.trueProb   ?? null;
          const valueEdge       = (trueProb != null && impliedProbHome != null)
            ? parseFloat((trueProb - impliedProbHome).toFixed(4)) : null;
          await query(
            `INSERT INTO feature_vectors
              (id, prediction_id,
               monte_carlo_home_win, monte_carlo_draw, monte_carlo_away_win, monte_carlo_std_dev,
               implied_prob_home, true_prob_home, value_edge_home, confidence_tier)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              uuidv4(), predId,
              m.monteCarlo.home   ?? null,
              m.monteCarlo.draw   ?? null,
              m.monteCarlo.away   ?? null,
              m.monteCarlo.stdDev ?? null,
              impliedProbHome, trueProb, valueEdge,
              m.starRating ?? null,
            ]
          );
        } catch (fvErr) { console.error('[Telegram] Save feature_vectors:', fvErr); }

        await query(
          'INSERT INTO conversations (id, session_id, channel, role, content) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), sessionId, 'telegram', 'assistant', result.finalAnswer]
        ).catch(() => {});
      } else {
        await ctx.reply('Sorry, I hit an error analyzing this. Please try again.');
      }
    } catch (err) {
      const isRate = String(err).includes('429');
      await ctx.reply(
        isRate
          ? 'AI model is rate-limited. Please wait ~1 minute and try again.'
          : 'Temporary error. Please try again in a moment.'
      ).catch(() => {});
    }
  });

  const launchBot = (retryCount = 0) => {
    bot!.launch({ dropPendingUpdates: true })
      .then(() => console.log('[Telegram] Bot started'))
      .catch(err => {
        const msg = String(err);
        if (msg.includes('409') && retryCount < 3) {
          const delay = 15000 * (retryCount + 1);
          console.warn(`[Telegram] 409 conflict — another instance running. Retry ${retryCount + 1}/3 in ${delay / 1000}s`);
          setTimeout(() => launchBot(retryCount + 1), delay);
        } else {
          console.error('[Telegram] Launch error (non-retryable):', err);
        }
      });
  };
  launchBot();
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
  return bot;
}

export { bot };
