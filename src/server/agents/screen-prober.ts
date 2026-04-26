/* Screen-prober agent — deterministic.
 *
 * The active capturer. While the `screenshots` agent watches the folder
 * and `screen-validator` scores each PNG, this agent is what actually
 * makes the captures happen — it spawns scripts/take-screenshots.mjs
 * as a child process, waits for completion, and emits run findings.
 *
 * Cadence:
 *   - intervalMs: 30 minutes (captures take ~2 min; 5% duty cycle)
 *   - routedFiles: any *Screen.tsx in the user repo (re-capture when a
 *     screen file changes)
 *
 * Pre-flight (skip with a benign info finding rather than failing):
 *   - take-screenshots.mjs exists in this repo
 *   - dev server is reachable at DEV_URL
 * (The script tolerates a missing playwright-auth.json — it falls back
 * to the bypassAuthIfPresent click-through path.)
 *
 * Risk class: `external-call`. The script writes PNGs into the user's
 * `docs/screenshots/` folder, but those are generated artifacts (a
 * cache) — not source edits. We treat the dominant cost as outbound
 * HTTP to the dev server, so the orchestrator doesn't block on
 * write-user-repo consent. The user opts in by leaving screen-prober
 * in `agentsToEnable` (or null = all agents).
 *
 * Debounce: a 5-min floor prevents file-change cascades (saving 60
 * Screen.tsx files in a row should not run the capture 60 times).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { query } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/take-screenshots.mjs');
const DEV_URL = process.env.DEV_URL ?? 'http://localhost:5173/';

const RUN_TIMEOUT_MS = 4 * 60 * 1000;        // < orchestrator's 5-min wall
const QUIET_RUN_GAP_MS = 5 * 60 * 1000;      // re-trigger floor

let lastRunStartedAt = 0;

type RunResult = {
  ok: boolean;
  captured: number;
  skipped: number;
  durationMs: number;
  exitCode: number | null;
  stderrTail: string;
  stdoutTail: string;
};

function runScript(): Promise<RunResult> {
  return new Promise((resolveProm) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const child = spawn('node', [SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, DEV_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (ok: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // Match the script's terminal line: "[shots] done · X captured · Y skipped · ..."
      const m = stdout.match(/(\d+) captured\s*·\s*(\d+) skipped/);
      resolveProm({
        ok,
        captured: m ? parseInt(m[1]!, 10) : 0,
        skipped: m ? parseInt(m[2]!, 10) : 0,
        durationMs: Date.now() - startedAt,
        exitCode,
        stderrTail: stderr.slice(-600),
        stdoutTail: stdout.slice(-600),
      });
    };

    timeoutHandle = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* */ }
      finish(false, null);
    }, RUN_TIMEOUT_MS);

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('exit', (code) => finish(code === 0, code));
    child.on('error', () => finish(false, null));
  });
}

async function probeOnce(timeoutMs: number): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(DEV_URL, { signal: ctrl.signal });
    return r.status >= 200 && r.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function devServerUp(): Promise<boolean> {
  // Vite's first response on a cold compile can be slow — give it 5s
  // initially, retry once with another 5s before declaring it down.
  if (await probeOnce(5_000)) return true;
  await new Promise((r) => setTimeout(r, 1_000));
  return probeOnce(5_000);
}

export const screenProberAgent: Agent = {
  name: 'screen-prober',
  description: 'Spawns the Playwright capture script for every screen; pre-flights dev server + auth; emits run-complete / run-failed.',
  routedFiles: config.screensGlob ? [config.screensGlob] : [],
  intervalMs: 30 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    if (!config.screensGlob) {
      return [{
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:not-applicable',
        at: now,
        severity: 'info',
        summary: 'no screensGlob configured for this repo — no screens to capture',
      }];
    }

    // In-process check first; falls back to DB for the cross-restart case
    // (tsx watch kills the daemon on every save during active dev).
    let effectiveLast = lastRunStartedAt;
    if (effectiveLast === 0) {
      const r = query<{ at: number }>(
        `SELECT at FROM findings WHERE agent = 'screen-prober'
           AND kind IN ('screen-prober:run-complete', 'screen-prober:run-failed')
         ORDER BY at DESC LIMIT 1`,
      )[0];
      if (r) effectiveLast = r.at;
    }
    if (now - effectiveLast < QUIET_RUN_GAP_MS) {
      return [{
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:debounced',
        at: now,
        severity: 'info',
        summary: `last capture only ${Math.round((now - effectiveLast) / 1000)}s ago — debounced (5-min floor)`,
        payload: { lastRunAt: effectiveLast, gapMs: now - effectiveLast },
      }];
    }

    if (!existsSync(SCRIPT)) {
      return [{
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:precondition-failed',
        at: now,
        severity: 'warn',
        summary: `take-screenshots.mjs not found at ${SCRIPT}`,
        payload: { script: SCRIPT },
      }];
    }
    if (!(await devServerUp())) {
      return [{
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:dev-server-down',
        at: now,
        severity: 'info',
        summary: `dev server at ${DEV_URL} not reachable — start the user's app first, then this agent will retry`,
        payload: { devUrl: DEV_URL },
      }];
    }

    lastRunStartedAt = now;
    const r = await runScript();
    const finishedAt = Date.now();

    if (r.ok) {
      out.push({
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:run-complete',
        at: finishedAt,
        severity: 'info',
        summary: `${r.captured} captured · ${r.skipped} skipped · ${Math.round(r.durationMs / 1000)}s`,
        payload: { captured: r.captured, skipped: r.skipped, durationMs: r.durationMs, exitCode: r.exitCode },
      });
    } else {
      const tail = r.stderrTail.trim().split('\n').filter(Boolean).pop() ?? r.stdoutTail.trim().split('\n').filter(Boolean).pop() ?? 'no output';
      out.push({
        id: newId(),
        agent: 'screen-prober',
        kind: 'screen-prober:run-failed',
        at: finishedAt,
        severity: 'warn',
        summary: `capture run failed (exit ${r.exitCode ?? 'killed'}) after ${Math.round(r.durationMs / 1000)}s — ${tail.slice(0, 200)}`,
        payload: {
          durationMs: r.durationMs,
          exitCode: r.exitCode,
          captured: r.captured,
          skipped: r.skipped,
          stderrTail: r.stderrTail,
          stdoutTail: r.stdoutTail,
        },
      });
    }

    return out;
  },
};
