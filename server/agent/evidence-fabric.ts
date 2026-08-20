import { createHash } from 'node:crypto';

export interface EvidenceItem {
  fixture: string;
  agent: string;
  field: string;
  value: unknown;
  sourceUrl?: string;
  sourceType?: string;
  observedAt: string;
  eventDate?: string;
  freshness: number;
  confidence: number;
  provenanceHash: string;
  contradictionGroup?: string;
}

const clamp = (x: number) => Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;

export function makeEvidence(item: Omit<EvidenceItem, 'observedAt' | 'freshness' | 'provenanceHash'> & { observedAt?: string; freshness?: number }): EvidenceItem {
  const observedAt = item.observedAt || new Date().toISOString();
  const canonical = JSON.stringify({ fixture: item.fixture, agent: item.agent, field: item.field, value: item.value, sourceUrl: item.sourceUrl || '', eventDate: item.eventDate || '' });
  return { ...item, observedAt, freshness: clamp(item.freshness ?? 0.8), confidence: clamp(item.confidence), provenanceHash: createHash('sha256').update(canonical).digest('hex') };
}

export function mergeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of items) {
    const key = `${item.fixture}|${item.field}|${item.provenanceHash}`;
    const prev = byKey.get(key);
    if (!prev || (item.confidence * item.freshness) > (prev.confidence * prev.freshness)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

export function consensus(items: EvidenceItem[], field: string): { value: unknown; confidence: number; dispersion: number; sources: number } | null {
  const rows = items.filter(x => x.field === field && typeof x.value === 'number');
  if (!rows.length) return null;
  const vals = rows.map(x => Number(x.value));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const dispersion = vals.length > 1 ? Math.sqrt(vals.reduce((a, x) => a + (x - mean) ** 2, 0) / vals.length) : 0;
  const confidence = Math.max(0, Math.min(1, rows.reduce((s, x) => s + x.confidence * x.freshness, 0) / rows.length * (1 / (1 + dispersion))));
  return { value: mean, confidence, dispersion, sources: new Set(rows.map(x => x.sourceUrl || x.provenanceHash)).size };
}
