import React, { useState } from 'react';

interface AccessGateProps {
  onAuthenticated: () => void;
}

export const AccessGate: React.FC<AccessGateProps> = ({ onAuthenticated }) => {
  const [key, setKey]         = useState('');
  const [error, setError]     = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim() || loading) return;

    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: key.trim() }),
      });
      if (res.ok) {
        onAuthenticated();
      } else {
        setError('Invalid access key. Please try again.');
        setKey('');
      }
    } catch {
      setError('Could not reach server. Please try again.');
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 bg-[#0d0d0d] flex items-center justify-center z-50">
      <div className="w-full max-w-sm px-6">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-3xl mb-4 shadow-2xl shadow-emerald-900/40">
            ⚡
          </div>
          <h1 className="text-xl font-bold text-white tracking-wide">Odessyus</h1>
          <p className="text-sm text-neutral-500 mt-1 font-mono">Autonomous Sports Forecasting</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs text-neutral-500 font-mono mb-2 uppercase tracking-wider">
              Access Key
            </label>
            <input
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="Enter your access key…"
              autoFocus
              className="w-full bg-white/[0.05] border border-white/[0.1] focus:border-emerald-500/60 rounded-xl px-4 py-3 text-sm text-neutral-100 placeholder-neutral-600 outline-none transition-all"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 font-mono bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={!key.trim() || loading}
            className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-900/30"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Verifying…
              </>
            ) : (
              'Enter'
            )}
          </button>
        </form>

        <p className="text-center text-xs text-neutral-700 font-mono mt-6">
          Session lasts 8 hours
        </p>
      </div>
    </div>
  );
};
