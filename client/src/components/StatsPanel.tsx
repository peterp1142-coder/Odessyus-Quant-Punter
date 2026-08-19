import React, { useEffect, useState } from 'react';
import type { StatsResponse } from '../types';

function StatCard({ label, value, sub, color = 'text-white' }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
      <div className="text-xs text-slate-500 font-mono uppercase tracking-wider mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono ${color}`}>{value}</div>
      {sub && <div className="text-xs text-slate-600 mt-0.5">{sub}</div>}
    </div>
  );
}

export const StatsPanel: React.FC = () => {
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) throw new Error('Failed to load stats');
        const json = await res.json() as StatsResponse;
        setData(json);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <div className="animate-spin h-8 w-8 border-2 border-green-500 border-t-transparent rounded-full mx-auto" />
        <p className="text-sm text-slate-500">Loading stats...</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="p-6 text-center text-red-400 text-sm">{error}</div>
  );

  const s = data?.overall;
  const winRate = s?.win_rate_pct ?? null;

  return (
    <div className="p-5 space-y-6 overflow-y-auto scrollable h-full">
      <div>
        <h2 className="text-base font-bold text-white mb-1">Performance Overview</h2>
        <p className="text-xs text-slate-500">All-time prediction tracking</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Total Picks" value={s?.total ?? 0} sub="All time" />
        <StatCard
          label="Win Rate"
          value={winRate !== null ? `${winRate}%` : '—'}
          sub={`${s?.won ?? 0}W / ${s?.lost ?? 0}L`}
          color={winRate !== null ? (winRate >= 55 ? 'text-green-400' : winRate >= 45 ? 'text-amber-400' : 'text-red-400') : 'text-slate-400'}
        />
        <StatCard label="Won" value={s?.won ?? 0} color="text-green-400" />
        <StatCard label="Lost" value={s?.lost ?? 0} color="text-red-400" />
        <StatCard label="Pending" value={s?.pending ?? 0} color="text-amber-400" />
        <StatCard
          label="Avg Confidence"
          value={s?.avg_confidence ? `${Math.round(Number(s.avg_confidence))}%` : '—'}
          color="text-blue-400"
        />
      </div>

      {/* Win rate visual bar */}
      {winRate !== null && (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
          <div className="flex justify-between text-xs text-slate-400 mb-2 font-mono">
            <span>Win Rate Progress</span>
            <span>{winRate}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-1000"
              style={{
                width: `${winRate}%`,
                background: winRate >= 55
                  ? 'linear-gradient(90deg, #059669, #10b981)'
                  : winRate >= 45
                    ? 'linear-gradient(90deg, #d97706, #f59e0b)'
                    : 'linear-gradient(90deg, #dc2626, #ef4444)',
              }}
            />
          </div>
          <div className="flex justify-between text-xs text-slate-600 mt-1 font-mono">
            <span>0%</span><span>50%</span><span>100%</span>
          </div>
        </div>
      )}

      {/* Recent predictions */}
      {data?.recent && data.recent.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Recent Picks</h3>
          <div className="space-y-2">
            {data.recent.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 bg-slate-900/40 border border-slate-800 rounded-lg px-3 py-2.5"
              >
                <span className={`text-xs font-bold w-12 text-center py-0.5 rounded-md font-mono ${
                  p.status === 'won' ? 'bg-green-950 text-green-400' :
                  p.status === 'lost' ? 'bg-red-950 text-red-400' :
                  'bg-amber-950 text-amber-400'
                }`}>
                  {p.status === 'won' ? 'WON' : p.status === 'lost' ? 'LOST' : 'PEND'}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-semibold text-slate-200 truncate">{p.fixture}</div>
                  <div className="text-xs text-slate-500 truncate">{p.prediction_market}</div>
                </div>
                {p.probability && (
                  <span className="text-xs font-mono text-slate-500 flex-shrink-0">
                    {Math.round(p.probability)}%
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily breakdown */}
      {data?.daily && data.daily.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Last 30 Days</h3>
          <div className="space-y-1.5">
            {data.daily.slice(0, 14).map((d) => {
              const total = Number(d.total);
              const won = Number(d.won);
              const rate = total > 0 ? Math.round((won / total) * 100) : 0;
              return (
                <div key={d.date} className="flex items-center gap-3">
                  <span className="text-xs text-slate-500 font-mono w-20 flex-shrink-0">
                    {new Date(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </span>
                  <div className="flex-1 bg-slate-800 rounded-full h-2 overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${rate}%`,
                        background: rate >= 55 ? '#10b981' : rate >= 45 ? '#f59e0b' : '#ef4444',
                      }}
                    />
                  </div>
                  <span className="text-xs text-slate-500 font-mono w-16 text-right flex-shrink-0">
                    {won}/{total} ({rate}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
