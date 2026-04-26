/* Prober agent — deterministic.
 *
 * Layer 1 of runtime verification (per project_runtime_verification
 * memory): for every endpoint URN in the register, probe the URL
 * and surface reachability + latency. This is the runtime
 * companion to the static graph: when the graph says a screen
 * `calls` an endpoint, the prober tells you whether the endpoint
 * is actually answering right now.
 *
 * Distinct from the `health` agent — `health` probes a configured
 * list of EXTERNAL services (Anthropic / OpenAI / Supabase / MCP).
 * The prober walks endpoints DISCOVERED IN THE USER'S CODE.
 *
 * Probe strategy:
 *   - URN starts with `endpoint:supabase/functions/<fn>` →
 *     resolve to `${SUPABASE_URL}/functions/v1/<fn>` if SUPABASE_URL
 *     is configured; otherwise skip.
 *   - URN starts with `endpoint:GET ` / `endpoint:POST ` etc. (an
 *     Express-style verb declaration) → resolve to <DEV_URL><path>
 *     if DEV_URL configured; otherwise skip.
 *   - URN starts with `endpoint:/api/...` (Next.js style) → same.
 *   - URN starts with `endpoint:/v1/messages` etc. (LLM API path) →
 *     skip (covered by the health agent's authoritative checks).
 *
 * Hard-path: skip rather than guess when we can't resolve a URN to
 * a real URL. Emit `prober:skipped` listing what we skipped + why.
 *
 * State transitions (up → down, down → up, etc.) emit findings;
 * steady-state up/down emits nothing per probe (just a periodic
 * summary every hour).
 */

import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { entities } from '../memory.ts';
import type { Agent, Finding, Severity } from '../types.ts';

const FETCH_TIMEOUT_MS = 6_000;
const SUMMARY_EVERY_MS = 60 * 60 * 1000;
const LATENCY_WINDOW = 50;

type Status = 'up' | 'down';
type State = { status: Status | null; latencies: number[]; lastError?: string; lastChangeAt: number };
const state = new Map<string, State>();
let lastSummaryAt = 0;

function urnToUrl(urn: string): string | null {
  // urn = 'endpoint:<rest>'
  const rest = urn.slice('endpoint:'.length);

  // Supabase Edge function: 'supabase/functions/<fn>'
  const supaMatch = /^supabase\/functions\/(.+)$/.exec(rest);
  if (supaMatch) {
    const supaUrl = process.env.SUPABASE_URL;
    if (!supaUrl) return null;
    return `${supaUrl.replace(/\/$/, '')}/functions/v1/${supaMatch[1]}`;
  }
  // Express/Hono verb declaration: 'GET /path' / 'POST /path'
  const verbMatch = /^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/.*)$/.exec(rest);
  if (verbMatch) {
    const dev = process.env.DEV_URL;
    if (!dev) return null;
    return `${dev.replace(/\/$/, '')}${verbMatch[2]}`;
  }
  // Next.js / generic path: '/api/x' or '/something'
  if (rest.startsWith('/')) {
    // LLM API paths are health's concern — skip here
    if (rest.startsWith('/v1/messages') || rest.startsWith('/v1/chat/completions')) return null;
    const dev = process.env.DEV_URL;
    if (!dev) return null;
    return `${dev.replace(/\/$/, '')}${rest}`;
  }
  return null;
}

async function probe(url: string): Promise<{ ok: boolean; status?: number; latencyMs: number; error?: string }> {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'GET', signal: ctrl.signal, redirect: 'manual' });
    // Reachable = the server answered. 401 / 403 / 404 / 405 still mean "alive".
    const reachable = (r.status >= 200 && r.status < 400) || [401, 403, 404, 405].includes(r.status);
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

function severity(s: Status): Severity {
  return s === 'down' ? 'error' : 'info';
}

export const proberAgent: Agent = {
  name: 'prober',
  description: 'Probes every endpoint discovered in the register; surfaces up/down transitions + latency.',
  routedFiles: [],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const findings: Finding[] = [];
    const now = Date.now();
    const endpoints = entities({ kind: 'endpoint' });

    if (endpoints.length === 0) {
      return [{
        id: newId(),
        agent: 'prober',
        kind: 'prober:no-endpoints',
        at: now,
        severity: 'info',
        summary: 'no endpoints in register — graph agent has not run yet, or repo has no detectable endpoints',
      }];
    }

    let probed = 0;
    let skipped = 0;
    const skippedSamples: string[] = [];

    const tasks = endpoints.map(async (e) => {
      const url = urnToUrl(e.urn);
      if (!url) {
        skipped++;
        if (skippedSamples.length < 5) skippedSamples.push(e.urn);
        return;
      }
      probed++;
      const r = await probe(url);
      const s = state.get(e.urn) ?? { status: null, latencies: [], lastChangeAt: 0 };
      s.latencies.push(r.latencyMs);
      if (s.latencies.length > LATENCY_WINDOW) s.latencies.shift();
      const next: Status = r.ok ? 'up' : 'down';
      s.lastError = r.error;
      if (next !== s.status) {
        s.lastChangeAt = now;
        findings.push({
          id: newId(),
          agent: 'prober',
          kind: r.ok ? 'prober:up' : 'prober:down',
          at: now,
          severity: severity(next),
          summary: r.ok
            ? `${e.urn} up — ${r.latencyMs}ms${s.status === 'down' ? ' (recovered)' : ''}`
            : `${e.urn} unreachable — ${r.error ?? `HTTP ${r.status ?? '?'}`}`,
          payload: { urn: e.urn, url, latencyMs: r.latencyMs, prev: s.status, next, ...(r.status ? { httpStatus: r.status } : {}), ...(r.error ? { error: r.error } : {}) },
        });
        s.status = next;
      }
      state.set(e.urn, s);
    });
    await Promise.all(tasks);

    if (skipped > 0 && now - lastSummaryAt >= SUMMARY_EVERY_MS) {
      findings.push({
        id: newId(),
        agent: 'prober',
        kind: 'prober:skipped',
        at: now,
        severity: 'info',
        summary: `skipped ${skipped} endpoint${skipped === 1 ? '' : 's'} (no resolvable URL — set SUPABASE_URL / DEV_URL)${skippedSamples.length ? `; e.g. ${skippedSamples.slice(0, 3).join(', ')}` : ''}`,
        payload: { skipped, sample: skippedSamples },
      });
    }

    if (now - lastSummaryAt >= SUMMARY_EVERY_MS) {
      lastSummaryAt = now;
      let upCount = 0, downCount = 0;
      let p95Worst = 0, p95WorstUrn = '';
      for (const [urn, s] of state) {
        if (s.status === 'up') upCount++;
        else if (s.status === 'down') downCount++;
        const p = p95(s.latencies);
        if (p > p95Worst) { p95Worst = p; p95WorstUrn = urn; }
      }
      findings.push({
        id: newId(),
        agent: 'prober',
        kind: 'prober:summary',
        at: now,
        severity: downCount > 0 ? 'warn' : 'info',
        summary: `prober · ${probed} probed · ${skipped} skipped · ${upCount} up · ${downCount} down${p95WorstUrn ? ` · slowest p95: ${p95WorstUrn} ${p95Worst}ms` : ''}`,
        payload: { probed, skipped, up: upCount, down: downCount, p95Worst, p95WorstUrn, supaConfigured: !!process.env.SUPABASE_URL, devConfigured: !!process.env.DEV_URL },
      });
    }

    return findings;
  },
};
