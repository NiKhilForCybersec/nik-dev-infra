/* Auto-fix driver agent — deterministic selector + claude -p dispatcher.
 *
 * Continuous-development loop (per project_continuous_dev_loop memory).
 * Each cycle:
 *   1. Read <repo>/<concernsFile> + <repo>/<resolutionsFile>.
 *   2. Compute the GAP SET = concerns whose claimed resolution is missing
 *      OR was flagged by the curator as cosmetic / regressed /
 *      unverifiable / easy-pathed / still-open / unaddressed.
 *   3. Skip concerns already attempted ≥ 2 times (auto-fix:dispatched
 *      findings keyed by concern fingerprint) — they need human review.
 *   4. Pick the top-1 by severity → recency.
 *   5. If dryRun: emit `auto-fix:dry-run-plan` with the prompt that WOULD
 *      have been dispatched, and stop.
 *   6. Else: invoke runClaude with cwd=userRepo + Edit/Write tools.
 *      Emit `auto-fix:dispatched` (before) + `auto-fix:cycle-complete` or
 *      `auto-fix:cycle-failed` (after).
 *
 * Hard guards (any one fails → cycle aborts with an info finding):
 *   - autoFixLoop.enabled === true (config + riskGate.allowWriteUserRepo)
 *   - <repo>/<killSwitchFile> not present
 *   - <repo>/<concernsFile> exists
 *   - cycles in trailing 24h < maxCyclesPerDay
 *   - last N cycles weren't all failures (maxConsecutiveFailures)
 *   - working tree is clean (no uncommitted user edits to clobber)
 *   - at least one gap exists
 *
 * Risk class: write-user-repo. Gated by both writeback.enabled AND
 * riskGate.allowWriteUserRepo (the orchestrator's standard write gate)
 * AND autoFixLoop.enabled (this agent's own gate inside run()). All three
 * required.
 */

import { execa } from 'execa';
import { minimatch } from 'minimatch';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { query } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

type Severity = 'info' | 'warn' | 'error';

type Concern = {
  fingerprint: string;       // stable hash of normalized text
  text: string;              // original bullet, trimmed
  severity: Severity;        // best guess from "**ERROR**" / "**WARN**" markers
  fileRef?: string;          // first markdown link / inline code path if present
  rawLineNo: number;         // line number in Concerns.md (1-based)
};

type CuratorVerdict = 'cosmetic' | 'regressed' | 'unverifiable' | 'unaddressed' | 'still-open' | 'easy-pathed' | 'no-proof';

const ATTEMPT_CAP_PER_CONCERN = 2;
const DISPATCH_TIMEOUT_MS = 4 * 60 * 1000;       // < orchestrator 5-min wall
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];

// ─── parsing ────────────────────────────────────────────────────────────────

function parseConcerns(body: string): Concern[] {
  const lines = body.split('\n');
  const out: Concern[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2).trim();
    if (text.length < 10) continue;                // skip empty / decorative bullets
    let severity: Severity = 'info';
    if (/\*\*ERROR\*\*/i.test(text)) severity = 'error';
    else if (/\*\*WARN\*\*/i.test(text)) severity = 'warn';
    // Pull a file ref out of [`path:line`](path#Lline) or `path:line` if present
    let fileRef: string | undefined;
    const m = text.match(/`([^`]+\.[a-zA-Z]+)(?::\d+)?`/);
    if (m) fileRef = m[1];
    out.push({
      fingerprint: fingerprint(text),
      text,
      severity,
      ...(fileRef ? { fileRef } : {}),
      rawLineNo: i + 1,
    });
  }
  return out;
}

function fingerprint(text: string): string {
  // Normalize: lowercase, collapse whitespace, strip markdown decorations,
  // strip the per-finding id + ISO timestamp (those change each curator pass).
  const norm = text
    .toLowerCase()
    .replace(/<small>[^<]*<\/small>/g, '')
    .replace(/finding [a-z0-9-]+/g, '')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/gi, '')
    .replace(/[*_`[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

// Build a Set of fingerprints that have a claimed resolution — we don't
// need to parse Resolutions.md beyond "does it cite this fingerprint or
// near-match text". Cheap heuristic: hash each line of Resolutions.md
// against the same fingerprint function and count matches.
function resolvedFingerprints(resolutionsBody: string, concerns: Concern[]): Set<string> {
  const out = new Set<string>();
  for (const c of concerns) {
    // Look for substring of the concern text in Resolutions.md (case-insens).
    // The user's Claude session typically quotes the concern bullet when
    // logging a resolution. Snippet of 40+ chars is a strong match.
    const snippet = c.text.replace(/[*_`[\]()]/g, '').slice(0, 60).toLowerCase();
    if (snippet.length < 40) continue;
    if (resolutionsBody.toLowerCase().includes(snippet.slice(0, 40))) {
      out.add(c.fingerprint);
    }
  }
  return out;
}

// ─── curator verdict lookup ────────────────────────────────────────────────

function brokenResolutionFingerprints(): Map<string, CuratorVerdict> {
  // The curator emits findings keyed by audit verdict. We want the LATEST
  // verdict per concern fingerprint — anything that says the resolution
  // didn't actually fix the concern.
  const rows = query<{ kind: string; payload_json: string | null; at: number }>(
    `SELECT kind, payload_json, at FROM findings
       WHERE agent = 'curator'
         AND kind IN (
           'curator:concern-unaddressed', 'curator:concern-easy-pathed',
           'curator:concern-still-open',  'curator:resolution-cosmetic',
           'curator:resolution-unverifiable', 'curator:resolution-no-proof',
           'curator:resolution-regressed'
         )
         AND at >= ?
       ORDER BY at DESC`,
    [Date.now() - 14 * 24 * 60 * 60 * 1000],          // 14d lookback
  );
  const out = new Map<string, CuratorVerdict>();
  for (const r of rows) {
    let p: { concern?: string; concernText?: string; fingerprint?: string } = {};
    try { p = JSON.parse(r.payload_json ?? '{}'); } catch { continue; }
    // Curator may emit either a fingerprint or the raw text — derive a
    // fingerprint from whichever is present.
    const fp = p.fingerprint
      ?? (p.concernText ? fingerprint(p.concernText) : undefined)
      ?? (p.concern ? fingerprint(p.concern) : undefined);
    if (!fp) continue;
    if (out.has(fp)) continue;                        // newest wins (DESC)
    out.set(fp, kindToVerdict(r.kind));
  }
  return out;
}

function kindToVerdict(kind: string): CuratorVerdict {
  switch (kind) {
    case 'curator:concern-unaddressed':       return 'unaddressed';
    case 'curator:concern-easy-pathed':       return 'easy-pathed';
    case 'curator:concern-still-open':        return 'still-open';
    case 'curator:resolution-cosmetic':       return 'cosmetic';
    case 'curator:resolution-unverifiable':   return 'unverifiable';
    case 'curator:resolution-no-proof':       return 'no-proof';
    case 'curator:resolution-regressed':      return 'regressed';
    default:                                  return 'still-open';
  }
}

// ─── per-concern attempt counter ───────────────────────────────────────────

function attemptsFor(fp: string): number {
  const r = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM findings
       WHERE agent = 'auto-fix-driver'
         AND kind IN ('auto-fix:dispatched', 'auto-fix:cycle-complete', 'auto-fix:cycle-failed')
         AND payload_json LIKE ?`,
    [`%"fingerprint":"${fp}"%`],
  )[0];
  return r?.n ?? 0;
}

// ─── pre-flight checks ─────────────────────────────────────────────────────

async function workingTreeClean(): Promise<{ clean: boolean; reason?: string }> {
  try {
    const r = await execa('git', ['status', '--porcelain'], { cwd: config.targetPath, timeout: 10_000 });
    if (r.stdout.trim().length === 0) return { clean: true };
    const firstLine = r.stdout.split('\n')[0]!.slice(0, 100);
    return { clean: false, reason: `git status not clean — first dirty entry: ${firstLine}` };
  } catch (e) {
    // Not a git repo (or git unavailable) — refuse to dispatch rather
    // than risk clobbering files we can't roll back.
    return { clean: false, reason: `git status failed: ${(e as Error).message.slice(0, 120)}` };
  }
}

async function gitHead(): Promise<string | null> {
  try {
    const r = await execa('git', ['rev-parse', 'HEAD'], { cwd: config.targetPath, timeout: 5_000 });
    return r.stdout.trim();
  } catch { return null; }
}

async function gitDiffSummary(headBefore: string): Promise<{ filesChanged: string[]; statTail: string } | null> {
  try {
    const status = await execa('git', ['status', '--porcelain'], { cwd: config.targetPath, timeout: 10_000 });
    const filesChanged = status.stdout.trim().split('\n').filter(Boolean).map((l) => l.slice(3));
    if (filesChanged.length === 0) return { filesChanged: [], statTail: '(no changes)' };
    const stat = await execa('git', ['diff', '--stat', headBefore], { cwd: config.targetPath, timeout: 10_000 });
    return { filesChanged, statTail: stat.stdout.trim().slice(-1500) };
  } catch (e) {
    return { filesChanged: [], statTail: `(diff failed: ${(e as Error).message.slice(0, 100)})` };
  }
}

// Hard-path safety: a concern's fileRef must match at least one allowed
// scope glob OR the scopes list is empty (open). Concerns without a
// fileRef would be rejected by the actionability check upstream UNLESS
// they have an imperative + curator verdict — for those, we still need
// to bound dispatch. Treat fileRef-less concerns as out-of-scope when
// scopes is non-empty: there's no way to verify the dispatched session
// would stay within bounds. The user widens scope by adding more globs.
function isInScope(concern: Concern): boolean {
  const scopes = config.autoFixLoop.scopes;
  if (scopes.length === 0) return true;
  if (!concern.fileRef) return false;
  return scopes.some((g) => minimatch(concern.fileRef!, g));
}

function cyclesLast24h(): number {
  const r = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM findings
       WHERE agent = 'auto-fix-driver'
         AND kind IN ('auto-fix:dispatched', 'auto-fix:dry-run-plan')
         AND at >= ?`,
    [Date.now() - 24 * 60 * 60 * 1000],
  )[0];
  return r?.n ?? 0;
}

function consecutiveFailures(): number {
  const rows = query<{ kind: string }>(
    `SELECT kind FROM findings
       WHERE agent = 'auto-fix-driver'
         AND kind IN ('auto-fix:cycle-complete', 'auto-fix:cycle-failed')
       ORDER BY at DESC LIMIT ?`,
    [config.autoFixLoop.maxConsecutiveFailures + 1],
  );
  let failures = 0;
  for (const r of rows) {
    if (r.kind === 'auto-fix:cycle-failed') failures++;
    else break;
  }
  return failures;
}

// ─── confidence gate (hard-path principle: 100% factual or skip) ───────────

type ActionableCheck = { actionable: true } | { actionable: false; reason: string };

function isActionable(concern: Concern, brokenVerdict: CuratorVerdict | undefined): ActionableCheck {
  // Hard-path: a concern only goes to dispatch when we're confident about
  // both WHAT to fix and WHERE. Otherwise it gets needs-clarification and
  // the user (or curator next pass) tightens the wording.
  const stripped = concern.text.replace(/[*_`[\]()<>]/g, '').trim();
  if (stripped.length < 30) return { actionable: false, reason: 'concern text too short to act on (<30 chars meaningful)' };

  // A concern needs at least ONE of: a file reference, OR a curator verdict
  // explaining what's broken, OR an explicit imperative verb in the text.
  const hasFileRef = !!concern.fileRef;
  const hasCuratorContext = !!brokenVerdict;
  const hasImperative = /\b(add|remove|fix|change|update|rename|delete|move|implement|wire|hook|expose|surface|guard|prevent|ensure|require|reject|migrate|replace)\b/i.test(stripped);

  if (!hasFileRef && !hasCuratorContext && !hasImperative) {
    return { actionable: false, reason: 'no file ref, no curator verdict, no imperative verb — concern is observational, not actionable' };
  }

  // Vague / philosophical concerns ("the UX feels off", "we should think about X")
  // shouldn't reach a dispatch. Catch a few common shapes.
  if (/\b(maybe|perhaps|might|could be nice|consider|think about|feels like|seems off|wonder if)\b/i.test(stripped)) {
    return { actionable: false, reason: 'concern is speculative ("maybe / perhaps / consider") — not 100% factual, not dispatchable' };
  }

  return { actionable: true };
}

// ─── dispatch prompt builder ───────────────────────────────────────────────

function buildPrompt(concern: Concern, brokenVerdict: CuratorVerdict | undefined): string {
  const verdictNote = brokenVerdict
    ? `The previous attempt at this concern was flagged by the dev-infra curator as **${brokenVerdict}**. Do better this time — verify the fix actually addresses the root cause, not just the symptom.`
    : `This concern has not been addressed yet.`;
  return `You are working in the user's project repo. The dev-infra background system has identified this open concern from the project's \`${config.concernsFile}\`:

> ${concern.text}

${verdictNote}

# CORE PRINCIPLE — HARD PATH ONLY

This is the dev-infra product's main instruction hook: **no minimal performance, no minimal confidence, never the happy path.** Every step here must be 100% factual + verified before you claim it. If at any point your confidence drops below "I have evidence this is correct," stop editing and write a clarification request instead. Below 100% confidence = no edit. Better to leave the concern open with an honest note than to ship a fix that looks right but isn't.

# Your task

1. **READ before you change anything.** ${concern.fileRef ? `Start from \`${concern.fileRef}\` and trace from there.` : 'Find the relevant code via Grep — do not guess.'} Read enough of the surrounding context that you can name what the file does, who calls it, and what it returns. If you can't, expand the read.
2. **READ** \`${config.concernsFile}\` and \`${config.resolutionsFile}\` (if present) for context. Never delete or rewrite existing entries in either file.
3. **Decide whether you can fix this with 100% confidence.**
   - If you cannot — for ANY reason (ambiguous wording, missing context, would require a design decision, can't trace the call site, can't verify the fix worked) — STOP. Skip to step 5 with the "cannot-fix" branch.
   - If you can, continue.
4. **Make the smallest correct change.** No drive-by refactors. No new features. No reformatting unrelated lines. The diff should be the minimum that addresses the concern.
5. **Verify before claiming success.** Pick the strongest verification you can:
   - Type-check passes: \`npx tsc --noEmit\` (or whatever the project uses) — if available, this is mandatory.
   - The code reads correctly: trace the call site you changed and confirm the new behavior matches what the concern asked for.
   - For UI changes: note that the dev-infra screen-prober will re-capture the screen — leave a note in Resolutions.md saying "expect screenshot diff."
   - **If you have NO way to verify, you do not have 100% confidence — go to the cannot-fix branch instead.**
6. **Append** a new entry to \`${config.resolutionsFile}\` (create the file if missing). Two shapes — pick the one that matches what you actually did:

   **Shape A — fix landed (only when you have evidence):**
   \`\`\`markdown
   ## ${new Date().toISOString().slice(0, 10)} — <one-line summary>
   - Addresses concern: "<quoted text from Concerns.md, first 80 chars>"
   - Files changed: <path>:<line> (one bullet per file)
   - Verification: <concrete evidence — e.g. "tsc --noEmit passes", "traced X→Y and the new return value matches the concern's expectation", "screen-prober will re-capture HomeScreen">
   - Confidence: 100% — <why>
   \`\`\`

   **Shape B — cannot fix (the honest path):**
   \`\`\`markdown
   ## ${new Date().toISOString().slice(0, 10)} — needs clarification: <one-line>
   - Addresses concern: "<quoted text from Concerns.md, first 80 chars>"
   - Why I'm not editing: <specific blocker — e.g. "concern names a file that doesn't exist", "would require a UX decision I can't make alone", "could not trace the call site after reading X, Y, Z">
   - What I'd need: <e.g. "a concrete file:line", "a decision on X vs Y", "an example of the desired behavior">
   \`\`\`

# Hard rules

- Never modify \`${config.concernsFile}\` itself — owned by the user / curator.
- Never delete prior Resolutions.md entries.
- If \`${config.targetPath}/${config.autoFixLoop.killSwitchFile}\` appears at any point, stop and exit cleanly.
- Don't run destructive shell commands. Read, Edit, Write, Glob, Grep are your tools.
- **If you would normally hedge ("this should work", "I think this is right"), use Shape B instead.** The product's value depends on its outputs being trustworthy.

When done, output a one-line summary: either "fixed: <X> · verified by <Y>" or "deferred: <reason>".`;
}

// ─── agent ─────────────────────────────────────────────────────────────────

export const autoFixDriverAgent: Agent = {
  name: 'auto-fix-driver',
  description: 'Picks an unresolved concern, dispatches a Claude session in the user repo to fix it, and audits via curator. Opt-in, dry-run by default.',
  routedFiles: [config.concernsFile, config.resolutionsFile],
  intervalMs: 30 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();
    const c = config.autoFixLoop;

    // Gate 1: feature flag
    if (!c.enabled) {
      return [{
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:loop-disabled',
        at: now,
        severity: 'info',
        summary: `loop disabled — flip autoFixLoop.enabled to start dry-run cycles`,
      }];
    }

    // Gate 2: kill-switch sentinel
    const killSwitch = resolve(config.targetPath, c.killSwitchFile);
    if (existsSync(killSwitch)) {
      return [{
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:kill-switched',
        at: now,
        severity: 'info',
        summary: `${c.killSwitchFile} present — loop paused; remove the file to resume`,
        payload: { killSwitchFile: killSwitch },
      }];
    }

    // Gate 3: Concerns.md present
    const concernsPath = resolve(config.targetPath, config.concernsFile);
    if (!existsSync(concernsPath)) {
      return [{
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:no-concerns-file',
        at: now,
        severity: 'info',
        summary: `${config.concernsFile} not present — nothing to drive against`,
      }];
    }

    // Gate 4: budget
    const cycles = cyclesLast24h();
    if (cycles >= c.maxCyclesPerDay) {
      return [{
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:budget-exceeded',
        at: now,
        severity: 'info',
        summary: `${cycles}/${c.maxCyclesPerDay} cycles in trailing 24h — waiting for window to roll`,
        payload: { cyclesLast24h: cycles, cap: c.maxCyclesPerDay },
      }];
    }

    // Gate 5: consecutive failures
    const fails = consecutiveFailures();
    if (fails >= c.maxConsecutiveFailures) {
      return [{
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:halted-failures',
        at: now,
        severity: 'warn',
        summary: `loop halted — ${fails} consecutive failed cycles; flip autoFixLoop.enabled off then on to restart`,
        payload: { consecutive: fails, cap: c.maxConsecutiveFailures },
      }];
    }

    // Gate 6 (only when actually writing): working tree clean
    if (!c.dryRun) {
      const tree = await workingTreeClean();
      if (!tree.clean) {
        return [{
          id: newId(),
          agent: 'auto-fix-driver',
          kind: 'auto-fix:dirty-tree',
          at: now,
          severity: 'info',
          summary: `${tree.reason ?? 'working tree dirty'} — skipping cycle so we don't clobber in-progress edits`,
        }];
      }
    }

    // Build the gap set.
    const concernsBody = readFileSync(concernsPath, 'utf8');
    const resolutionsPath = resolve(config.targetPath, config.resolutionsFile);
    const resolutionsBody = existsSync(resolutionsPath) ? readFileSync(resolutionsPath, 'utf8') : '';
    const concerns = parseConcerns(concernsBody);
    const resolved = resolvedFingerprints(resolutionsBody, concerns);
    const broken = brokenResolutionFingerprints();

    const gaps = concerns.filter((cn) => {
      const isBroken = broken.has(cn.fingerprint);
      const isResolved = resolved.has(cn.fingerprint);
      if (!isBroken && isResolved) return false;
      if (attemptsFor(cn.fingerprint) >= ATTEMPT_CAP_PER_CONCERN) return false;
      return true;
    });

    // Hard-path filter: split actionable vs needs-clarification vs
    // out-of-scope. Vague / observational / speculative concerns get a
    // clarification finding and are never dispatched. Concerns whose
    // fileRef falls outside autoFixLoop.scopes get an out-of-scope
    // finding — also never dispatched, but visible so the user knows
    // which globs to add when they want to expand the loop.
    const actionable: Concern[] = [];
    const unactionable: Array<{ concern: Concern; reason: string }> = [];
    const outOfScope: Concern[] = [];
    for (const cn of gaps) {
      const verdict = broken.get(cn.fingerprint);
      const check = isActionable(cn, verdict);
      if (!check.actionable) { unactionable.push({ concern: cn, reason: check.reason }); continue; }
      if (!isInScope(cn)) { outOfScope.push(cn); continue; }
      actionable.push(cn);
    }
    // Emit one needs-clarification per unactionable gap, but keep the rail
    // calm: cap at 5 per cycle and the rest go into a digest payload.
    const top = unactionable.slice(0, 5);
    for (const u of top) {
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:needs-clarification',
        at: now,
        severity: 'info',
        summary: `not actionable · ${u.reason} · "${u.concern.text.slice(0, 80)}${u.concern.text.length > 80 ? '…' : ''}"`,
        payload: {
          fingerprint: u.concern.fingerprint,
          concernText: u.concern.text,
          reason: u.reason,
        },
      });
    }
    // Emit one out-of-scope per gap whose fileRef isn't covered by the
    // current scope globs. Capped at 5 too — the summary carries totals.
    for (const cn of outOfScope.slice(0, 5)) {
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:out-of-scope',
        at: now,
        severity: 'info',
        summary: `out of scope · ${cn.fileRef ? `${cn.fileRef} not in [${c.scopes.join(', ')}]` : 'no fileRef + scopes non-empty'} · "${cn.text.slice(0, 70)}${cn.text.length > 70 ? '…' : ''}"`,
        payload: {
          fingerprint: cn.fingerprint,
          concernText: cn.text,
          fileRef: cn.fileRef ?? null,
          scopes: c.scopes,
        },
      });
    }

    if (actionable.length === 0) {
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:no-targets',
        at: now,
        severity: 'info',
        summary: `${concerns.length} concerns · ${resolved.size} resolved · ${broken.size} flagged-broken · ${gaps.length} gaps · ${unactionable.length} needs-clarification · ${outOfScope.length} out-of-scope · 0 actionable`,
        payload: {
          concernCount: concerns.length,
          resolvedCount: resolved.size,
          brokenCount: broken.size,
          gapsTotal: gaps.length,
          unactionableTotal: unactionable.length,
          outOfScopeTotal: outOfScope.length,
          scopes: c.scopes,
        },
      });
      return out;
    }

    // Rank: severity (error > warn > info) → fewer prior attempts → newer.
    const sevWeight: Record<Severity, number> = { error: 3, warn: 2, info: 1 };
    actionable.sort((a, b) => {
      const sd = sevWeight[b.severity] - sevWeight[a.severity];
      if (sd !== 0) return sd;
      const ad = attemptsFor(a.fingerprint) - attemptsFor(b.fingerprint);
      if (ad !== 0) return ad;
      return b.rawLineNo - a.rawLineNo;
    });

    const target = actionable[0]!;
    const verdict = broken.get(target.fingerprint);
    const prompt = buildPrompt(target, verdict);

    // Dry run: emit the plan, don't dispatch.
    if (c.dryRun) {
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:dry-run-plan',
        at: now,
        severity: 'info',
        summary: `[DRY] would dispatch · ${target.severity} · ${target.text.slice(0, 100)}${target.text.length > 100 ? '…' : ''}`,
        payload: {
          fingerprint: target.fingerprint,
          concernText: target.text,
          severity: target.severity,
          fileRef: target.fileRef,
          priorVerdict: verdict ?? null,
          priorAttempts: attemptsFor(target.fingerprint),
          gapsTotal: gaps.length,
          actionableTotal: actionable.length,
          unactionableTotal: unactionable.length,
          prompt,
        },
      });
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:summary',
        at: now,
        severity: 'info',
        summary: `dry-run · ${concerns.length} concerns · ${resolved.size} resolved · ${actionable.length} actionable / ${unactionable.length} needs-clarification · target: ${target.fingerprint}`,
        payload: {
          dryRun: true,
          concerns: concerns.length,
          resolved: resolved.size,
          gaps: gaps.length,
          actionable: actionable.length,
          unactionable: unactionable.length,
        },
      });
      return out;
    }

    // Live dispatch — capture HEAD before so we can diff cleanly afterward
    // (separates this cycle's edits from any other in-flight user work).
    const headBefore = await gitHead();
    out.push({
      id: newId(),
      agent: 'auto-fix-driver',
      kind: 'auto-fix:dispatched',
      at: now,
      severity: 'info',
      summary: `dispatching · ${target.severity} · ${target.text.slice(0, 100)}${target.text.length > 100 ? '…' : ''}`,
      payload: {
        fingerprint: target.fingerprint,
        concernText: target.text,
        severity: target.severity,
        fileRef: target.fileRef,
        priorVerdict: verdict ?? null,
        priorAttempts: attemptsFor(target.fingerprint),
        scopes: c.scopes,
        headBefore,
      },
    });

    try {
      const r = await runClaude({
        prompt,
        cwd: config.targetPath,
        allowedTools: ALLOWED_TOOLS,
        timeoutMs: DISPATCH_TIMEOUT_MS,
      });

      // Post-dispatch diff snapshot — surfaces what the cycle actually
      // changed in the user repo, scoped against the captured HEAD.
      // Out-of-scope file changes are flagged so the user can spot a
      // session that ignored its instructions.
      let diffPayload: { filesChanged: string[]; statTail: string; outOfScopeFiles: string[] } | null = null;
      if (headBefore) {
        const d = await gitDiffSummary(headBefore);
        if (d) {
          const outOfScopeFiles = c.scopes.length === 0
            ? []
            : d.filesChanged.filter((f) => !c.scopes.some((g) => minimatch(f, g)));
          diffPayload = { ...d, outOfScopeFiles };
          out.push({
            id: newId(),
            agent: 'auto-fix-driver',
            kind: 'auto-fix:diff-recorded',
            at: Date.now(),
            severity: outOfScopeFiles.length > 0 ? 'warn' : 'info',
            summary: `${d.filesChanged.length} file${d.filesChanged.length === 1 ? '' : 's'} changed${outOfScopeFiles.length > 0 ? ` · ${outOfScopeFiles.length} OUT-OF-SCOPE` : ''}`,
            payload: {
              fingerprint: target.fingerprint,
              filesChanged: d.filesChanged,
              outOfScopeFiles,
              statTail: d.statTail,
              headBefore,
            },
          });
        }
      }

      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:cycle-complete',
        at: Date.now(),
        severity: 'info',
        summary: `dispatch complete · ${Math.round(r.durationMs / 1000)}s · ${r.text.split('\n').filter(Boolean).pop()?.slice(0, 140) ?? '(no summary)'}`,
        payload: {
          fingerprint: target.fingerprint,
          concernText: target.text,
          durationMs: r.durationMs,
          ...(r.usage ? { usage: r.usage } : {}),
          claudeOutputTail: r.text.slice(-1500),
          ...(diffPayload ? { diff: diffPayload } : {}),
        },
      });
    } catch (e) {
      out.push({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:cycle-failed',
        at: Date.now(),
        severity: 'warn',
        summary: `dispatch failed · ${(e as Error).message.slice(0, 200)}`,
        payload: {
          fingerprint: target.fingerprint,
          concernText: target.text,
          error: (e as Error).message,
          headBefore,
        },
      });
    }

    return out;
  },
};
