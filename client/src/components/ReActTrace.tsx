import React, { useRef, useEffect, Fragment } from 'react';
import type { ReActStep } from '../types';

interface ReActTraceProps {
  steps: ReActStep[];
  isActive?: boolean;
}

const STEP_CONFIG = {
  thought:     { icon: '💭', label: 'Thought',     color: 'text-purple-400',  bg: 'bg-purple-950/40',  border: 'border-purple-800/50' },
  action:      { icon: '🔧', label: 'Action',      color: 'text-blue-400',    bg: 'bg-blue-950/40',    border: 'border-blue-800/50' },
  observation: { icon: '👁',  label: 'Observation', color: 'text-amber-400',   bg: 'bg-amber-950/30',   border: 'border-amber-800/50' },
  synthesis:   { icon: '⚡', label: 'Synthesis',   color: 'text-green-400',   bg: 'bg-green-950/40',   border: 'border-green-700/50' },
  error:       { icon: '⚠️', label: 'Error',       color: 'text-red-400',     bg: 'bg-red-950/40',     border: 'border-red-800/50' },
  status:      { icon: '⚙️', label: 'Status',      color: 'text-slate-400',   bg: 'bg-slate-900/40',   border: 'border-slate-700/50' },
};

const SUBAGENT_CONFIG: Record<string, { label: string; tag: string; dot: string; badge: string }> = {
  '📊 ODDS':      { label: 'OddsScout',      tag: 'bg-cyan-950/60 border-cyan-800/60',     dot: 'bg-cyan-400',   badge: 'text-cyan-400 bg-cyan-950 border-cyan-800' },
  '📈 FORM':      { label: 'FormScout',      tag: 'bg-indigo-950/60 border-indigo-800/60', dot: 'bg-indigo-400', badge: 'text-indigo-400 bg-indigo-950 border-indigo-800' },
  '🏥 INJURY':    { label: 'InjuryIntel',    tag: 'bg-orange-950/60 border-orange-800/60', dot: 'bg-orange-400', badge: 'text-orange-400 bg-orange-950 border-orange-800' },
  '📰 SENTIMENT': { label: 'SentimentAgent', tag: 'bg-violet-950/60 border-violet-800/60', dot: 'bg-violet-400', badge: 'text-violet-400 bg-violet-950 border-violet-800' },
  '⚡ QUANT':     { label: 'QuantSynthesis', tag: 'bg-green-950/60 border-green-800/60',   dot: 'bg-green-400',  badge: 'text-green-400 bg-green-950 border-green-800' },
  'ORCHESTRATOR': { label: 'Orchestrator',   tag: 'bg-slate-900/60 border-slate-700/60',   dot: 'bg-slate-400',  badge: 'text-slate-400 bg-slate-900 border-slate-700' },
};

function detectSubagent(content: string): { prefix: string; body: string } | null {
  // Match "[📊 ODDS] actual content"
  const m = content.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
  if (!m) return null;
  const prefix = m[1].trim();
  const body = m[2].trim();
  if (SUBAGENT_CONFIG[prefix]) return { prefix, body };
  return null;
}

function SubagentBadge({ prefix }: { prefix: string }) {
  const cfg = SUBAGENT_CONFIG[prefix];
  if (!cfg) return null;
  return (
    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-full border ${cfg.badge}`}>
      {prefix} {cfg.label}
    </span>
  );
}

// Track which subagents have had their first step — for lane dividers
function buildStepGroups(steps: ReActStep[]): Array<{ step: ReActStep; prefix: string | null; isNewAgent: boolean }> {
  const seen = new Set<string>();
  return steps.map((step) => {
    const detected = detectSubagent(step.content);
    const prefix = detected?.prefix || null;
    const key = prefix || 'ORCHESTRATOR';
    const isNewAgent = !seen.has(key) && !!prefix;
    seen.add(key);
    return { step, prefix, isNewAgent };
  });
}

export const ReActTrace: React.FC<ReActTraceProps> = ({ steps, isActive }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [steps.length]);

  const visibleSteps = steps.filter(s => s.type !== 'status' && s.type !== 'synthesis');
  const statusSteps  = steps.filter(s => s.type === 'status');
  const lastStatus   = statusSteps[statusSteps.length - 1];

  if (visibleSteps.length === 0 && !isActive) return null;

  const uniqueAgents = [...new Set(
    visibleSteps
      .map(s => detectSubagent(s.content)?.prefix)
      .filter(Boolean)
  )];
  const activeAgentCount = uniqueAgents.length;

  const groups = buildStepGroups(visibleSteps);

  return (
    <div className="mt-3 rounded-xl overflow-hidden border border-slate-700/50 bg-slate-900/50">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-700/50 bg-slate-800/50">
        <div className="flex items-center gap-1.5">
          {isActive && (
            <span className="flex h-2 w-2 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
            </span>
          )}
          <span className="text-xs font-semibold text-slate-300 font-mono uppercase tracking-wider">
            Agent Trace
          </span>
        </div>

        {/* Active subagent pills */}
        {uniqueAgents.length > 0 && (
          <div className="flex items-center gap-1 ml-1 flex-wrap">
            {uniqueAgents.map(prefix => {
              const cfg = SUBAGENT_CONFIG[prefix!];
              return (
                <span key={prefix} className="flex items-center gap-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${cfg?.dot}`} />
                </span>
              );
            })}
            <span className="text-xs text-slate-500 font-mono">{activeAgentCount} agents</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-slate-500 font-mono">
          <span>{visibleSteps.length} steps</span>
        </div>
      </div>

      {/* Live status bar */}
      {isActive && lastStatus && (
        <div className="px-4 py-2 border-b border-slate-800/60 bg-slate-900/70 flex items-center gap-2">
          <div className="animate-spin h-3 w-3 border border-green-500 border-t-transparent rounded-full flex-shrink-0" />
          <span className="text-xs text-slate-400 font-mono truncate">{lastStatus.content}</span>
        </div>
      )}

      {/* Steps */}
      <div className="max-h-96 overflow-y-auto p-3 space-y-2 scrollable">
        {groups.map(({ step, prefix, isNewAgent }, i) => {
          const cfg = STEP_CONFIG[step.type] || STEP_CONFIG.status;
          const agentCfg = prefix ? SUBAGENT_CONFIG[prefix] : null;
          const isLast = i === groups.length - 1;

          // Detect content body (strip prefix)
          const detected = detectSubagent(step.content);
          const displayContent = detected?.body || step.content;

          return (
            <React.Fragment key={i}>
              {/* Subagent lane divider — shown when a new agent appears */}
              {isNewAgent && prefix && agentCfg && (
                <div className={`flex items-center gap-2 px-2 py-1 rounded-lg border text-[10px] font-mono font-semibold ${agentCfg.tag}`}>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${agentCfg.dot}`} />
                  <span className="text-slate-300 uppercase tracking-wider">{prefix} · {agentCfg.label} starting</span>
                </div>
              )}

              <div
                className={`rounded-lg border px-3 py-2.5 ${cfg.bg} ${cfg.border} animate-stream-in`}
                style={{ animationDelay: `${Math.min(i * 20, 150)}ms` }}
              >
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-sm leading-none">{cfg.icon}</span>
                  <span className={`text-xs font-semibold font-mono uppercase tracking-wide ${cfg.color}`}>
                    {cfg.label}
                  </span>
                  {step.iteration && (
                    <span className="text-xs text-slate-600 font-mono">#{step.iteration}</span>
                  )}
                  {prefix && <SubagentBadge prefix={prefix} />}
                  {step.toolName && !prefix && (
                    <span className="ml-auto text-xs font-mono bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full border border-slate-700">
                      {step.toolName}
                    </span>
                  )}
                  {step.toolName && prefix && (
                    <span className="text-xs font-mono bg-slate-800 text-slate-500 px-1.5 py-0.5 rounded-full border border-slate-700">
                      {step.toolName}
                    </span>
                  )}
                  {isLast && isActive && (
                    <span className="ml-auto flex gap-1">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-300 leading-relaxed font-mono break-words whitespace-pre-wrap line-clamp-4">
                  {step.type === 'observation'
                    ? displayContent.substring(0, 400) + (displayContent.length > 400 ? '...' : '')
                    : displayContent}
                </p>
                {step.toolInput && Object.keys(step.toolInput).length > 0 && (
                  <div className="mt-1.5 text-xs font-mono text-slate-500 truncate">
                    {JSON.stringify(step.toolInput).substring(0, 120)}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}

        {isActive && visibleSteps.length === 0 && (
          <div className="flex items-center gap-3 py-3 px-2">
            <div className="animate-spin h-4 w-4 border-2 border-green-500 border-t-transparent rounded-full" />
            <span className="text-xs text-slate-400 font-mono">Initializing multi-agent orchestrator...</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};
