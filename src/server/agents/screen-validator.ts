/* Screen-validator agent — deterministic.
 *
 * Per project_capture_validation_research memory: Layer 1 of the
 * 2-layer validation pipeline. For every (screen, screenshot) pair,
 * read the PNG + sidecar meta.json + the original DOM/console/
 * network info, run 7 cheap deterministic checks, score confidence
 * 0.0–1.0, emit a verdict.
 *
 * Layer 2 (LLM vision review for ambiguous cases) is a follow-up
 * commit. This agent ships only the deterministic tier — it
 * already catches the bulk of failure modes (blank, auth-wall,
 * skeleton, error-state, scroll-required) at zero LLM cost.
 *
 * Cadence: every 5 minutes, plus file-change-triggered runs when
 * any PNG in <repo>/<screenshotsDir>/ updates.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding, Severity } from '../types.ts';

const BLANK_BYTES = 8 * 1024;
const VIEWPORT_HEIGHT = 844;          // matches default in take-screenshots.mjs

type Sidecar = {
  url?: string;
  viewport?: { width: number; height: number };
  capturedAt?: string;
  elapsedMs?: number;
  navStrategyUsed?: string;
  fullPage?: boolean;
  sizeBytes?: number;
  consoleErrors?: string[];
  pendingNetworkAtCapture?: string[];
  domSnapshot?: string | null;
  scrollHeight?: number | null;
  imagesIncomplete?: number | null;
};

type Verdict = 'ok' | 'blank' | 'auth-wall' | 'skeleton-loading' | 'error-state' | 'network-pending' | 'scroll-required' | 'no-capture' | 'failed-nav';

type CheckResult = { name: string; passed: boolean; severity: 'block' | 'warn'; evidence: string };

function runChecks(screenName: string, png: { exists: boolean; sizeBytes: number }, side: Sidecar): { verdict: Verdict; confidence: number; failures: CheckResult[] } {
  const failures: CheckResult[] = [];

  // The capture step writes a sidecar even when nav failed; the meta's
  // navStrategyUsed prefix tells us which path we're on.
  if (side.navStrategyUsed && /^(tile-not-found|nav-error|screenshot-error)/.test(side.navStrategyUsed)) {
    return { verdict: 'failed-nav', confidence: 0, failures: [{ name: 'navStrategy', passed: false, severity: 'block', evidence: side.navStrategyUsed }] };
  }
  if (!png.exists) {
    return { verdict: 'no-capture', confidence: 0, failures: [{ name: 'pngMissing', passed: false, severity: 'block', evidence: 'no png on disk' }] };
  }

  // 1. fileSizeFloor
  if (png.sizeBytes < BLANK_BYTES) {
    failures.push({ name: 'fileSizeFloor', passed: false, severity: 'block', evidence: `${png.sizeBytes} bytes` });
  }

  const dom = (side.domSnapshot ?? '').toLowerCase();
  const isAuthScreen = /authscreen/i.test(screenName);

  // 2. authMarker (skip for AuthScreen itself — login UI is its content)
  if (!isAuthScreen && /sign in|create account|continue as demo|continue with google|password|email/i.test(dom)) {
    // The substring "email" may appear in legit screens (e.g. Settings),
    // so combine with explicit auth markers.
    const authBlock = /sign in|create account|continue as demo|continue with google/i.test(dom);
    if (authBlock) {
      failures.push({ name: 'authMarker', passed: false, severity: 'block', evidence: 'login UI markers in DOM' });
    }
  }

  // 3. skeletonMarker
  if (/aria-busy="true"|class="[^"]*\b(skeleton|shimmer)\b/i.test(dom)) {
    failures.push({ name: 'skeletonMarker', passed: false, severity: 'warn', evidence: 'skeleton/shimmer in DOM' });
  }

  // 4. errorBoundaryMarker
  if (/something went wrong|error boundary|failed to load|errorboundary/i.test(dom)) {
    failures.push({ name: 'errorBoundaryMarker', passed: false, severity: 'block', evidence: 'error-boundary text in DOM' });
  }

  // 5. pendingNetwork
  const pending = side.pendingNetworkAtCapture?.length ?? 0;
  if (pending > 3) {
    failures.push({ name: 'pendingNetwork', passed: false, severity: 'warn', evidence: `${pending} requests in flight at capture` });
  }

  // 6. consoleErrors
  const errs = side.consoleErrors?.length ?? 0;
  if (errs > 0) {
    failures.push({ name: 'consoleErrors', passed: false, severity: 'warn', evidence: `${errs} console.error(s): ${(side.consoleErrors ?? []).slice(0, 2).join(' | ').slice(0, 200)}` });
  }

  // 7. contentHeightCheck (only if not fullPage)
  if (!side.fullPage && side.scrollHeight && side.scrollHeight > VIEWPORT_HEIGHT * 1.2) {
    failures.push({ name: 'contentHeightCheck', passed: false, severity: 'warn', evidence: `scrollHeight=${side.scrollHeight} (viewport ${VIEWPORT_HEIGHT}); rec: SCREENSHOT_FULL_PAGE=1` });
  }

  // Map failures to verdicts (priority order — most severe first).
  let verdict: Verdict = 'ok';
  if (failures.some((f) => f.name === 'authMarker'))            verdict = 'auth-wall';
  else if (failures.some((f) => f.name === 'errorBoundaryMarker')) verdict = 'error-state';
  else if (failures.some((f) => f.name === 'fileSizeFloor'))    verdict = 'blank';
  else if (failures.some((f) => f.name === 'skeletonMarker'))   verdict = 'skeleton-loading';
  else if (failures.some((f) => f.name === 'pendingNetwork'))   verdict = 'network-pending';
  else if (failures.some((f) => f.name === 'contentHeightCheck')) verdict = 'scroll-required';

  // Confidence formula from the research memo:
  //   start at 1.0
  //   - 0.5 per block-severity failure
  //   - 0.2 per warn-severity failure (capped at 0.4 total)
  let confidence = 1.0;
  let warnDelta = 0;
  for (const f of failures) {
    if (f.severity === 'block') confidence -= 0.5;
    else if (f.severity === 'warn') warnDelta = Math.min(0.4, warnDelta + 0.2);
  }
  confidence -= warnDelta;
  confidence = Math.max(0, Math.min(1, confidence));

  return { verdict, confidence, failures };
}

const VERDICT_KIND: Record<Verdict, string> = {
  'ok':                'capture:ok',
  'blank':             'capture:blank',
  'auth-wall':         'capture:auth-wall',
  'skeleton-loading':  'capture:skeleton-loading',
  'error-state':       'capture:error-state',
  'network-pending':   'capture:network-pending',
  'scroll-required':   'capture:scroll-required',
  'no-capture':        'capture:no-capture',
  'failed-nav':        'capture:failed-nav',
};

const VERDICT_SEVERITY: Record<Verdict, Severity> = {
  'ok':                'info',
  'blank':             'warn',
  'auth-wall':         'warn',
  'skeleton-loading':  'info',
  'error-state':       'error',
  'network-pending':   'info',
  'scroll-required':   'info',
  'no-capture':        'info',
  'failed-nav':        'warn',
};

export const screenValidatorAgent: Agent = {
  name: 'screen-validator',
  description: "Validates each captured screenshot against deterministic checks; per-screen verdict + confidence; surfaces blanks / auth-walls / error-states.",
  routedFiles: [
    `${config.screenshotsDir}/*`,
  ],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const dir = resolve(config.targetPath, config.screenshotsDir);
    if (!existsSync(dir)) return [];
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const screens = names.filter((n) => /^[A-Z][A-Za-z0-9]*Screen\.png$/.test(n)).map((n) => n.replace(/\.png$/, ''));
    if (screens.length === 0) return [];

    const findings: Finding[] = [];
    const counts = { ok: 0, blank: 0, 'auth-wall': 0, 'skeleton-loading': 0, 'error-state': 0, 'network-pending': 0, 'scroll-required': 0, 'no-capture': 0, 'failed-nav': 0 };

    for (const screenName of screens) {
      const png = resolve(dir, `${screenName}.png`);
      const sidecar = resolve(dir, `${screenName}.meta.json`);
      let pngStat;
      try { pngStat = statSync(png); } catch { /* png missing */ }
      const pngExists = !!pngStat;
      const sizeBytes = pngStat?.size ?? 0;

      let side: Sidecar = {};
      if (existsSync(sidecar)) {
        try { side = JSON.parse(readFileSync(sidecar, 'utf8')) as Sidecar; }
        catch { /* malformed sidecar — treat as empty */ }
      }

      const r = runChecks(screenName, { exists: pngExists, sizeBytes }, side);
      counts[r.verdict]++;

      // Don't spam the rail with `capture:ok` per screen — only emit
      // problem verdicts. The summary at the end carries the totals.
      if (r.verdict === 'ok') continue;

      findings.push({
        id: newId(),
        agent: 'screen-validator',
        kind: VERDICT_KIND[r.verdict],
        at: Date.now(),
        severity: VERDICT_SEVERITY[r.verdict],
        summary: `${screenName} · ${r.verdict} · confidence ${r.confidence.toFixed(2)} · ${r.failures.map((f) => f.name).join(', ') || 'no checks'}`,
        file: `${config.screenshotsDir}/${screenName}.png`,
        payload: {
          screen: screenName,
          verdict: r.verdict,
          confidence: r.confidence,
          failures: r.failures,
          sidecar: { url: side.url, navStrategy: side.navStrategyUsed, sizeBytes },
        },
      });
    }

    findings.push({
      id: newId(),
      agent: 'screen-validator',
      kind: 'capture:summary',
      at: Date.now(),
      severity: counts['error-state'] > 0 ? 'error' : counts.blank + counts['auth-wall'] + counts['failed-nav'] > 0 ? 'warn' : 'info',
      summary: `${screens.length} captures · ${counts.ok} ok · ${counts.blank}b ${counts['auth-wall']}auth ${counts['error-state']}err ${counts['failed-nav']}nav · ${counts['scroll-required']} scroll-req`,
      payload: { total: screens.length, ...counts },
    });

    return findings;
  },
};
