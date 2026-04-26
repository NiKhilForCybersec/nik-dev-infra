/* Schedules + dispatches agents. Runs each on:
 *   1. Boot (everything once)
 *   2. File change matching the agent's routedFiles globs (debounced)
 *   3. Interval if intervalMs > 0
 *
 * Per-agent in-flight gate: only one run of agent X at a time. New
 * triggers while a run is in-flight queue exactly one re-run. The
 * orchestrator catches errors per agent so one bad agent doesn't
 * tear down the daemon.
 */

import { minimatch } from 'minimatch';
import { AGENTS } from './agents/index.ts';
import { emit, emitRun } from './findings.ts';
import { startWatcher } from './watcher.ts';
import type { Agent } from './types.ts';

type AgentState = {
  inFlight: boolean;
  pending: boolean;          // a re-run was requested while in-flight
  lastRunAt: number;
  intervalId?: NodeJS.Timeout;
};

const state = new Map<string, AgentState>();
for (const a of AGENTS) state.set(a.name, { inFlight: false, pending: false, lastRunAt: 0 });

async function runAgent(agent: Agent): Promise<void> {
  const s = state.get(agent.name)!;
  if (s.inFlight) {
    s.pending = true;
    return;
  }
  s.inFlight = true;
  const startedAt = Date.now();
  try {
    const findings = await agent.run();
    for (const f of findings) emit(f);
    emitRun({
      agent: agent.name,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: true,
      findingCount: findings.length,
    });
    s.lastRunAt = Date.now();
  } catch (e) {
    emitRun({
      agent: agent.name,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: false,
      findingCount: 0,
      error: (e as Error).message,
    });
    console.error(`[orchestrator] agent ${agent.name} failed:`, (e as Error).message);
  } finally {
    s.inFlight = false;
    if (s.pending) {
      s.pending = false;
      // Drain queued trigger.
      void runAgent(agent);
    }
  }
}

function matchesAny(globs: string[], rel: string): boolean {
  return globs.some((g) => minimatch(rel, g));
}

// Debounce file events per agent so a flurry of saves coalesces.
const debounceTimers = new Map<string, NodeJS.Timeout>();
function scheduleAgent(agent: Agent, debounceMs = 800) {
  const existing = debounceTimers.get(agent.name);
  if (existing) clearTimeout(existing);
  debounceTimers.set(agent.name, setTimeout(() => {
    debounceTimers.delete(agent.name);
    void runAgent(agent);
  }, debounceMs));
}

export function startOrchestrator(): void {
  // 1. Initial run of every agent on boot (so the UI has data immediately).
  for (const a of AGENTS) void runAgent(a);

  // 2. Interval-based runs.
  for (const a of AGENTS) {
    if (a.intervalMs > 0) {
      const s = state.get(a.name)!;
      s.intervalId = setInterval(() => void runAgent(a), a.intervalMs);
    }
  }

  // 3. File-change-driven runs.
  startWatcher((e) => {
    for (const a of AGENTS) {
      if (a.routedFiles.length === 0) continue;
      if (matchesAny(a.routedFiles, e.rel)) scheduleAgent(a);
    }
  });

  console.log(`[orchestrator] started — ${AGENTS.length} agents (${AGENTS.map((a) => a.name).join(', ')})`);
}
