import React, { useEffect, useState, useCallback } from 'react';
import type { Prediction } from '../types';
import { PredictionCard } from './PredictionCard';

type FilterStatus = 'all' | 'pending' | 'won' | 'lost' | 'void';

export const PredictionsView: React.FC = () => {
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/predictions');
      if (!res.ok) throw new Error('Failed to load predictions');
      const data = await res.json() as { predictions: Prediction[] };
      setPredictions(data.predictions);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleStatusUpdate = useCallback((id: string, status: Prediction['status']) => {
    setPredictions(prev => prev.map(p => p.id === id ? { ...p, status } : p));
  }, []);

  const filtered = filter === 'all' ? predictions : predictions.filter(p => p.status === filter);

  const counts = {
    all: predictions.length,
    pending: predictions.filter(p => p.status === 'pending').length,
    won: predictions.filter(p => p.status === 'won').length,
    lost: predictions.filter(p => p.status === 'lost').length,
    void: predictions.filter(p => p.status === 'void').length,
  };

  const FILTERS: { key: FilterStatus; label: string; color: string }[] = [
    { key: 'all', label: 'All', color: 'text-slate-300' },
    { key: 'pending', label: 'Pending', color: 'text-amber-400' },
    { key: 'won', label: 'Won', color: 'text-green-400' },
    { key: 'lost', label: 'Lost', color: 'text-red-400' },
    { key: 'void', label: 'Void', color: 'text-slate-500' },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-shrink-0 px-5 py-3.5 border-b border-slate-800/70 bg-slate-900/50">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold text-slate-100">Prediction Tracker</h2>
          <button
            onClick={load}
            className="text-xs text-slate-500 hover:text-green-400 transition-colors font-mono"
          >
            ↻ Refresh
          </button>
        </div>
        {/* Filter tabs */}
        <div className="flex gap-1 flex-wrap">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-xs px-3 py-1.5 rounded-lg font-mono transition-all ${
                filter === f.key
                  ? `bg-slate-700 ${f.color} border border-slate-600`
                  : 'text-slate-500 hover:text-slate-300 border border-transparent'
              }`}
            >
              {f.label}
              <span className="ml-1.5 text-slate-600">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollable p-4 space-y-3">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin h-6 w-6 border-2 border-green-500 border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="text-center py-8 text-red-400 text-sm">{error}</div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📊</div>
            <p className="text-slate-500 text-sm">No predictions yet.</p>
            <p className="text-slate-600 text-xs mt-1">
              Ask Odessyus for predictions in the chat to start tracking.
            </p>
          </div>
        )}

        {filtered.map(p => (
          <div key={p.id} className="animate-fade-in-up">
            <PredictionCard
              prediction={p}
              onStatusUpdate={handleStatusUpdate}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
