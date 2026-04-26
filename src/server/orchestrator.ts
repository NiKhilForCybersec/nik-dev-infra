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
import { AGENTS, RISK_CLASS_BY_AGENT } from './agents/index.ts';
import { config } from './config.ts';
import { emit, emitRun, newId, onFinding } from './findings.ts';
import { addHook, entities, firingHooks, lookup } from './memory.ts';
import { startWatcher } from './watcher.ts';
import type { Agent, Finding } from './types.ts';

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

  // Risk gate (12-patterns #10). Block before incurring any cost.
  const riskClass = RISK_CLASS_BY_AGENT[agent.name];
  if (riskClass === 'write-prompt' && !config.riskGate.allowWritePrompt) {
    emit({
      id: newId(),
      agent: 'orchestrator',
      kind: 'risk:gated',
      at: Date.now(),
      severity: 'info',
      summary: `${agent.name} blocked · riskClass=write-prompt requires riskGate.allowWritePrompt=true`,
      payload: { agent: agent.name, riskClass },
    } as Finding);
    return;
  }
  if (riskClass === 'write-user-repo' && !(config.riskGate.allowWriteUserRepo && config.writeback.enabled)) {
    // Curator runs but its in-agent gate produces curator:write-disabled
    // findings; the risk gate here only fires when both flags would
    // otherwise prevent any safe operation. We still let the agent run
    // because its read-only audit pass is valuable, but emit a once-per-
    // run gate notice so the policy is visible in the rail.
    emit({
      id: newId(),
      agent: 'orchestrator',
      kind: 'risk:gated',
      at: Date.now(),
      severity: 'info',
      summary: `${agent.name} running in read-only mode · riskClass=write-user-repo requires riskGate.allowWriteUserRepo + writeback.enabled both true`,
      payload: { agent: agent.name, riskClass, allowWriteUserRepo: config.riskGate.allowWriteUserRepo, writebackEnabled: config.writeback.enabled },
    } as Finding);
    // Do NOT return — the curator's audit + promote findings are still
    // useful read-only signals. The agent itself enforces no-write.
  }

  s.inFlight = true;
  const startedAt = Date.now();

  // 12-patterns #12 — lifecycle hooks: pre_run / post_run / error /
  // timeout. Each fires into the L6 hook bus on segment `agent/<name>`
  // AND emits a top-level `lifecycle:*` finding for dashboard visibility.
  const segment = `agent/${agent.name}`;
  emit({
    id: newId(), agent: 'orchestrator', kind: 'lifecycle:pre',
    at: startedAt, severity: 'info',
    summary: `${agent.name} pre_run · riskClass=${riskClass}`,
    payload: { agent: agent.name, riskClass, segment, event: 'pre_run' },
  } as Finding);
  fireEvent(segment, 'pre_run', { agent: agent.name, riskClass });

  // Hard wall-clock timeout — most LLM agents have a 90-180s timeout
  // inside runClaude; this fallback catches deterministic agents that
  // hang on a slow file read or external probe.
  const HARD_TIMEOUT_MS = 5 * 60 * 1000;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new Error(`agent timed out after ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
  });

  try {
    const findings = await Promise.race([agent.run(), timeoutPromise]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    for (const f of findings) emit(f);
    const durationMs = Date.now() - startedAt;
    emitRun({
      agent: agent.name, startedAt, durationMs, ok: true,
      findingCount: findings.length,
    });
    s.lastRunAt = Date.now();
    emit({
      id: newId(), agent: 'orchestrator', kind: 'lifecycle:post',
      at: Date.now(), severity: 'info',
      summary: `${agent.name} post_run · ${findings.length} finding${findings.length === 1 ? '' : 's'} · ${durationMs}ms`,
      payload: { agent: agent.name, durationMs, findingCount: findings.length, segment, event: 'post_run' },
    } as Finding);
    fireEvent(segment, 'post_run', { agent: agent.name, durationMs, findingCount: findings.length });
  } catch (e) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const durationMs = Date.now() - startedAt;
    emitRun({
      agent: agent.name, startedAt, durationMs, ok: false,
      findingCount: 0, error: (e as Error).message,
    });
    console.error(`[orchestrator] agent ${agent.name} failed:`, (e as Error).message);
    if (timedOut) {
      emit({
        id: newId(), agent: 'orchestrator', kind: 'lifecycle:timeout',
        at: Date.now(), severity: 'error',
        summary: `${agent.name} timed out after ${HARD_TIMEOUT_MS / 1000}s`,
        payload: { agent: agent.name, timeoutMs: HARD_TIMEOUT_MS, durationMs, segment, event: 'timeout' },
      } as Finding);
      fireEvent(segment, 'timeout', { agent: agent.name, timeoutMs: HARD_TIMEOUT_MS });
    } else {
      emit({
        id: newId(), agent: 'orchestrator', kind: 'lifecycle:error',
        at: Date.now(), severity: 'error',
        summary: `${agent.name} error · ${(e as Error).message}`,
        payload: { agent: agent.name, error: (e as Error).message, durationMs, segment, event: 'error' },
      } as Finding);
      fireEvent(segment, 'error', { agent: agent.name, error: (e as Error).message });
    }
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

/** Manually trigger a single agent by name. Returns ok=false if the
 *  name is unknown. Useful for manual one-shots like the bootstrap pass
 *  or any agent the user wants to re-run from the dashboard. */
export function triggerAgent(name: string): { ok: boolean; reason?: string } {
  const a = AGENTS.find((x) => x.name === name);
  if (!a) return { ok: false, reason: `unknown agent: ${name}` };
  void runAgent(a);
  return { ok: true };
}

/** Look up the segment that owns the given file, by walking the register
 *  for an entity whose `file` matches. Returns null if no entity claims
 *  it — caller should fall back to the wildcard segment '*'. */
function segmentForFile(file: string | undefined): string | null {
  if (!file) return null;
  for (const e of entities()) {
    if (e.file === file && e.segment) return e.segment;
  }
  return null;
}

/** Fire an event into the hooks table. Every active hook on (segment, event)
 *  — plus wildcard '*' on either dimension — gets its target agent
 *  scheduled. Emits a `hooks:fired` finding so dispatch is visible. */
function fireEvent(segment: string, event: string, payload?: Record<string, unknown>): void {
  const hooks = firingHooks(segment, event);
  if (hooks.length === 0) return;
  // De-dupe target agents in this dispatch — a hook firing once per event
  // is enough (multiple subscriptions for the same agent collapse).
  const targets = new Set<string>();
  for (const h of hooks) targets.add(h.agent);
  for (const target of targets) {
    const r = triggerAgent(target);
    if (!r.ok) continue;
  }
  emit({
    id: newId(),
    agent: 'orchestrator',
    kind: 'hooks:fired',
    at: Date.now(),
    severity: 'info',
    summary: `${hooks.length} hook${hooks.length === 1 ? '' : 's'} fired (${segment}/${event}) → ${[...targets].join(', ')}`,
    payload: { segment, event, targets: [...targets], hookCount: hooks.length, ...(payload ?? {}) },
  } as Finding);
}

/** Default L6 hook subscriptions (closes the "lifecycle hooks have no
 *  subscribers" self-concern). Idempotent — addHook upserts on
 *  (segment, event, agent), so calling on every boot is a no-op when
 *  the rows already exist. The orchestrator's fireEvent() routes
 *  triggers through these.
 *
 *  Note: segment='*' is the wildcard. Lifecycle events like 'timeout'
 *  fire on segment='agent/<name>'; the '*' subscription matches
 *  because firingHooks() OR's with the literal '*' value. */
function setupDefaultHooks(): void {
  // When ANY agent times out → trigger self-monitor for real-time
  // visibility (don't wait for the 15-min interval to surface the
  // p95 / failure-rate anomaly).
  addHook({
    segment: '*',
    event: 'timeout',
    agent: 'self-monitor',
    promptFragment: 'A peer agent just timed out — sweep the runs table for the offender.',
  });
  // When ANY agent errors → trigger memory-keeper for an integrity
  // sweep (something might have written half a fact / orphan the
  // register).
  addHook({
    segment: '*',
    event: 'error',
    agent: 'memory-keeper',
    promptFragment: 'An agent just errored — re-run integrity checks in case state was left half-written.',
  });
}

export function startOrchestrator(): void {
  setupDefaultHooks();
  // 1. Initial run of every agent on boot (so the UI has data immediately).
  for (const a of AGENTS) void runAgent(a);

  // 2. Interval-based runs.
  for (const a of AGENTS) {
    if (a.intervalMs > 0) {
      const s = state.get(a.name)!;
      s.intervalId = setInterval(() => void runAgent(a), a.intervalMs);
    }
  }

  // 3. File-change-driven runs + file_changed hooks.
  startWatcher((e) => {
    for (const a of AGENTS) {
      if (a.routedFiles.length === 0) continue;
      if (matchesAny(a.routedFiles, e.rel)) scheduleAgent(a);
    }
    // Also fire a file_changed event into the hooks bus, scoped to the
    // segment that owns the file (or '*' if the file isn't claimed by
    // any registered entity yet).
    const segment = segmentForFile(e.rel) ?? '*';
    fireEvent(segment, 'file_changed', { file: e.rel, kind: e.kind });
  });

  // 4. Hook firing on finding emit. We avoid recursion by ignoring
  // findings emitted by the orchestrator itself (kind: 'hooks:fired',
  // 'risk:gated', 'lifecycle:*') and by skipping if the segment can't
  // be derived AND no '*' hooks exist (avoids constant log noise).
  onFinding((f) => {
    if (f.agent === 'orchestrator') return;
    const segment = segmentForFile(f.file) ?? '*';
    fireEvent(segment, 'finding_emitted', { findingId: f.id, kind: f.kind, severity: f.severity });
  });

  console.log(`[orchestrator] started — ${AGENTS.length} agents (${AGENTS.map((a) => a.name).join(', ')})`);
}
