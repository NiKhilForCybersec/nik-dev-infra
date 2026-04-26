/* Self-monitor agent — deterministic.
 *
 * Per project_self_monitoring memory: watches dev-infra's own
 * runtime health using the persistent `agent_runs` table + the
 * findings index. Distinct from `memory-keeper` (memory layer
 * integrity) and `self-awareness` (structural snapshot).
 *
 * Per-agent metrics across the last 24h:
 *   - total_runs / ok_runs / error_rate_pct
 *   - p50 / p95 / p99 duration_ms
 *   - schema_rejection_rate_pct (% of findings emitted as
 *     `schema-rejected` by that agent — high = prompt is broken)
 *   - findings_per_run_avg
 *
 * Findings emitted ONLY on threshold breaches:
 *   self:agent-slow      (warn)  p95 ≥ 2× of the 7-day baseline
 *                                (or > 60s on agents that aren't
 *                                expected to be that slow)
 *   self:agent-failing   (warn)  error_rate ≥ 30% over the window
 *   self:prompt-broken   (warn)  schema_rejection_rate ≥ 25%
 *   self:agent-silent    (info)  ≥ 10 runs in 24h, 0 findings —
 *                                might be useless or just quiet,
 *                                meta-agent will judge
 *   self:metrics-summary (info)  hourly digest with the worst
 *                                offender per dimension
 *
 * Hard-path: never assume "this number is bad" without an
 * explicit threshold. All thresholds documented in the constants
 * block below.
 */

import { newId } from '../findings.ts';
import { query } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const WINDOW_MS = 24 * 60 * 60 * 1000;
const SLOW_FACTOR = 2.0;                           // p95 over baseline
const SLOW_FLOOR_MS = 60_000;                      // never flag below this
const FAILING_RATE_PCT = 30;
const PROMPT_BROKEN_RATE_PCT = 25;
const SILENT_MIN_RUNS = 10;
const SUMMARY_EVERY_MS = 60 * 60 * 1000;
let lastSummaryAt = 0;

function p(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1);
  return sorted[idx]!;
}

export const selfMonitorAgent: Agent = {
  name: 'self-monitor',
  description: "Per-agent latency / error / schema-rejection metrics across 24h. Surfaces threshold breaches as self:* findings.",
  routedFiles: [],
  intervalMs: 15 * 60 * 1000,
  run: async () => {
    const findings: Finding[] = [];
    const now = Date.now();

    // All distinct agent names with runs in the last 24h.
    const agents = query<{ agent: string }>(
      `SELECT DISTINCT agent FROM agent_runs WHERE started_at >= ?`,
      [now - WINDOW_MS],
    ).map((r) => r.agent);

    type Stat = { agent: string; total: number; ok: number; errorPct: number; p50: number; p95: number; p99: number; rejPct: number; findingsAvg: number; baselineP95: number; durations: number[] };
    const stats: Stat[] = [];

    for (const agent of agents) {
      const rows = query<{ duration_ms: number; ok: number; finding_count: number }>(
        `SELECT duration_ms, ok, finding_count FROM agent_runs WHERE agent = ? AND started_at >= ?`,
        [agent, now - WINDOW_MS],
      );
      if (rows.length === 0) continue;
      const durations = rows.map((r) => r.duration_ms);
      const total = rows.length;
      const ok = rows.filter((r) => r.ok === 1).length;
      const errorPct = ((total - ok) / total) * 100;
      const findingsTotal = rows.reduce((a, r) => a + r.finding_count, 0);
      const findingsAvg = findingsTotal / total;

      // Schema-rejection rate from the findings table over the same window.
      const findingsTotalForAgent = query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM findings WHERE agent = ? AND at >= ?`,
        [agent, now - WINDOW_MS],
      )[0]?.n ?? 0;
      const rejected = query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM findings WHERE agent = ? AND kind = 'schema-rejected' AND at >= ?`,
        [agent, now - WINDOW_MS],
      )[0]?.n ?? 0;
      const rejPct = findingsTotalForAgent > 0 ? (rejected / findingsTotalForAgent) * 100 : 0;

      // 7-day baseline p95 (excludes the active window for "slow vs baseline" comparison).
      const baselineRows = query<{ duration_ms: number }>(
        `SELECT duration_ms FROM agent_runs WHERE agent = ? AND started_at >= ? AND started_at < ?`,
        [agent, now - 7 * WINDOW_MS, now - WINDOW_MS],
      ).map((r) => r.duration_ms);
      const baselineP95 = baselineRows.length >= 5 ? p(baselineRows, 0.95) : 0;

      const stat: Stat = {
        agent, total, ok, errorPct,
        p50: p(durations, 0.50),
        p95: p(durations, 0.95),
        p99: p(durations, 0.99),
        rejPct,
        findingsAvg,
        baselineP95,
        durations,
      };
      stats.push(stat);

      // Per-stat threshold breaches.
      if (stat.errorPct >= FAILING_RATE_PCT) {
        findings.push({
          id: newId(),
          agent: 'self-monitor',
          kind: 'self:agent-failing',
          at: now,
          severity: 'warn',
          summary: `${agent} error rate ${stat.errorPct.toFixed(0)}% over last 24h (${total - ok}/${total} runs failed)`,
          payload: { agent, errorPct: stat.errorPct, total, failed: total - ok },
        });
      }
      if (stat.rejPct >= PROMPT_BROKEN_RATE_PCT && findingsTotalForAgent >= 5) {
        findings.push({
          id: newId(),
          agent: 'self-monitor',
          kind: 'self:prompt-broken',
          at: now,
          severity: 'warn',
          summary: `${agent} schema-rejection rate ${stat.rejPct.toFixed(0)}% — prompt likely producing malformed output`,
          payload: { agent, rejPct: stat.rejPct, rejected, totalFindings: findingsTotalForAgent },
        });
      }
      const slowThreshold = stat.baselineP95 > 0 ? stat.baselineP95 * SLOW_FACTOR : SLOW_FLOOR_MS;
      if (stat.p95 > SLOW_FLOOR_MS && stat.p95 > slowThreshold) {
        findings.push({
          id: newId(),
          agent: 'self-monitor',
          kind: 'self:agent-slow',
          at: now,
          severity: 'warn',
          summary: `${agent} p95 ${stat.p95}ms — ${stat.baselineP95 > 0 ? `${(stat.p95 / stat.baselineP95).toFixed(1)}× baseline` : 'no baseline'}`,
          payload: { agent, p95: stat.p95, baseline: stat.baselineP95 },
        });
      }
      if (total >= SILENT_MIN_RUNS && findingsTotalForAgent === 0) {
        findings.push({
          id: newId(),
          agent: 'self-monitor',
          kind: 'self:agent-silent',
          at: now,
          severity: 'info',
          summary: `${agent} ran ${total} times in 24h with 0 findings — quiet or useless?`,
          payload: { agent, runs: total },
        });
      }
    }

    // Hourly digest.
    if (now - lastSummaryAt >= SUMMARY_EVERY_MS) {
      lastSummaryAt = now;
      const slowest = [...stats].sort((a, b) => b.p95 - a.p95)[0];
      const failingest = [...stats].sort((a, b) => b.errorPct - a.errorPct)[0];
      findings.push({
        id: newId(),
        agent: 'self-monitor',
        kind: 'self:metrics-summary',
        at: now,
        severity: 'info',
        summary: `metrics · ${stats.length} agents tracked${slowest ? ` · slowest p95: ${slowest.agent} ${slowest.p95}ms` : ''}${failingest && failingest.errorPct > 0 ? ` · most failing: ${failingest.agent} ${failingest.errorPct.toFixed(0)}%` : ''}`,
        payload: { byAgent: Object.fromEntries(stats.map((s) => [s.agent, { total: s.total, errorPct: s.errorPct, p95: s.p95, rejPct: s.rejPct, findingsAvg: s.findingsAvg }])) },
      });
    }

    return findings;
  },
};
