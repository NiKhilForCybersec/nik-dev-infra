/* Health agent — deterministic.
 *
 * Every 60s, pings external services the Nik app depends on and
 * tracks per-target latency + reachability. Emits findings only on
 * state transitions (up→down, degraded→up, etc.) to avoid flooding
 * the feed; one summary finding per hour gives a baseline pulse.
 *
 * Targets are configurable via env vars; defaults cover the common
 * Nik stack (Anthropic, OpenAI, Supabase). Auth is NOT sent — we
 * only test reachability, so a 401/403 response counts as "up".
 */

import { newId } from '../findings.ts';
import type { Agent, Finding, Severity } from '../types.ts';

type Target = {
  name: string;
  url: string;
  /** Status codes that mean the service is reachable.
   *  Default: 2xx, 3xx, 401, 403, 404, 405 (all imply the host answered). */
  reachable?: (status: number) => boolean;
};

const DEFAULT_REACHABLE = (s: number) =>
  (s >= 200 && s < 400) || s === 401 || s === 403 || s === 404 || s === 405;

const TARGETS: Target[] = [
  { name: 'anthropic', url: process.env.ANTHROPIC_URL ?? 'https://api.anthropic.com/v1/messages' },
  { name: 'openai',    url: process.env.OPENAI_URL    ?? 'https://api.openai.com/v1/models' },
  ...(process.env.SUPABASE_URL ? [{ name: 'supabase', url: `${process.env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/` }] : []),
  ...(process.env.MCP_URL      ? [{ name: 'mcp',      url: process.env.MCP_URL }] : []),
];

const FETCH_TIMEOUT_MS = 8_000;
const LATENCY_WINDOW = 100;
const SUMMARY_EVERY_MS = 60 * 60 * 1000;
/** Latency multiplier over p95 that flips a target to "degraded". */
const DEGRADED_FACTOR = 2.5;

type Status = 'up' | 'degraded' | 'down';
type State = {
  status: Status | null;
  lastUpAt: number | null;
  lastDownAt: number | null;
  latencies: number[];          // ring of last LATENCY_WINDOW samples (ms)
  lastError?: string;
};

const state = new Map<string, State>();
for (const t of TARGETS) state.set(t.name, { status: null, lastUpAt: null, lastDownAt: null, latencies: [] });
let lastSummaryAt = 0;

async function probe(t: Target): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(t.url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    const reachable = (t.reachable ?? DEFAULT_REACHABLE)(r.status);
    return { ok: reachable, status: r.status, latencyMs: Date.now() - startedAt };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: (e as Error).message || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

function p95(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[idx]!;
}

function classify(s: State, sample: { ok: boolean; latencyMs: number }): Status {
  if (!sample.ok) return 'down';
  const window = s.latencies;
  if (window.length < 5) return 'up';                  // not enough history yet
  const p = p95(window);
  if (sample.latencyMs > p * DEGRADED_FACTOR && sample.latencyMs > 1000) return 'degraded';
  return 'up';
}

function severity(status: Status): Severity {
  return status === 'down' ? 'error' : status === 'degraded' ? 'warn' : 'info';
}

function transition(target: string, prev: Status | null, next: Status, sample: { latencyMs: number; status?: number; error?: string }): Finding {
  const summary = next === 'down'
    ? `${target} unreachable${sample.error ? ` (${sample.error})` : sample.status ? ` (HTTP ${sample.status})` : ''}`
    : next === 'degraded'
      ? `${target} degraded — ${sample.latencyMs}ms (p95 baseline ${Math.round(p95(state.get(target)!.latencies))}ms)`
      : prev === null
        ? `${target} up — ${sample.latencyMs}ms`
        : `${target} recovered — ${sample.latencyMs}ms`;
  return {
    id: newId(),
    agent: 'health',
    kind: `health:${next}`,
    at: Date.now(),
    severity: severity(next),
    summary,
    payload: { target, latencyMs: sample.latencyMs, prev, next, ...(sample.status ? { httpStatus: sample.status } : {}), ...(sample.error ? { error: sample.error } : {}) },
  };
}

export const healthAgent: Agent = {
  name: 'health',
  description: 'Pings external services every 60s; surfaces reachability + p95 latency on state transitions.',
  routedFiles: [],
  intervalMs: 60_000,
  run: async () => {
    if (TARGETS.length === 0) {
      // Nothing to probe — surface a one-time hint and stay quiet.
      return [{
        id: newId(),
        agent: 'health',
        kind: 'health:no-targets',
        at: Date.now(),
        severity: 'info',
        summary: 'health agent has no targets configured (set SUPABASE_URL / MCP_URL to enable)',
      }];
    }

    const findings: Finding[] = [];
    const now = Date.now();

    const results = await Promise.all(
      TARGETS.map(async (t) => ({ t, r: await probe(t) })),
    );

    for (const { t, r } of results) {
      const s = state.get(t.name)!;
      s.latencies.push(r.latencyMs);
      if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
      const next = classify(s, r);
      if (r.ok) s.lastUpAt = now; else s.lastDownAt = now;
      s.lastError = r.error;
      if (next !== s.status) {
        findings.push(transition(t.name, s.status, next, r));
        s.status = next;
      }
    }

    // Hourly summary so the agent has visible activity even when nothing flapped.
    if (now - lastSummaryAt >= SUMMARY_EVERY_MS) {
      lastSummaryAt = now;
      const lines = TARGETS.map((t) => {
        const s = state.get(t.name)!;
        return `${t.name}=${s.status ?? '?'} (p95 ${Math.round(p95(s.latencies))}ms)`;
      }).join(' · ');
      const anyDown = TARGETS.some((t) => state.get(t.name)!.status === 'down');
      findings.push({
        id: newId(),
        agent: 'health',
        kind: 'health:summary',
        at: now,
        severity: anyDown ? 'error' : 'info',
        summary: `hourly health: ${lines}`,
        payload: Object.fromEntries(TARGETS.map((t) => {
          const s = state.get(t.name)!;
          return [t.name, { status: s.status, p95Ms: Math.round(p95(s.latencies)), samples: s.latencies.length, lastUpAt: s.lastUpAt, lastDownAt: s.lastDownAt }];
        })),
      });
    }

    return findings;
  },
};
