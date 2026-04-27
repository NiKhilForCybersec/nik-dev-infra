/* Intent-extractor agent — LLM (claude -p), bounded.
 *
 * Phase 2 of the user-repo knowledge graph (per
 * project_user_repo_knowledge_graph memory). For each module the
 * codebase-graph agent registered, ask claude -p ONE question:
 *
 *   "What is this file for? Who uses it? What does it depend on?
 *    What could break it?"
 *
 * Stores a short prose answer in code_files.intent_summary and emits
 * an `intent:extracted` finding. Downstream agents (auto-fix-driver
 * especially) read this back as grounding context: instead of grepping
 * cold, the dispatched session sees "this module is for X, depends on
 * Y, called by Z, fragile because of W."
 *
 * Hard-path:
 *   - LLM cost bounded: at most N modules per cycle (default 5),
 *     interval 30 min. ~10/day; on a 200-module repo, full coverage
 *     in ~3 weeks. Acceptable steady-state.
 *   - Skip modules with 0 exports (no API surface = nothing to
 *     describe coherently).
 *   - Re-extract only when file content hash changed since last intent
 *     write — the codebase-graph parser updates code_files.sha256 on
 *     content change, so we compare intent_at vs parsed_at.
 *   - The prompt forces a strict Shape A (4 concrete bullets, each
 *     with file evidence) or Shape B ("can't summarize, here's why").
 *     No hedging language. Below 100% confidence = no store.
 *   - Per-cycle cap on parallel claude calls = 1 (sequential). Avoids
 *     blowing the agent budget cap when a repo first lights up.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { getCodeFile, query, recordCodeFileIntent } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

// Phase 4: pinned to haiku for structured extraction. The MODEL switch
// halves the API cost per call but DOES NOT speed up wall clock —
// measured 2026-04-27, a single haiku call still took 65s wall (9s
// API + ~55s claude CLI bootstrap). The CLI overhead dominates every
// call regardless of model. Real speedup would require switching to
// the Anthropic SDK directly (queued, big refactor). Until then,
// hold timeouts conservative + cap parallelism via per-cycle wall
// budget. Cost optimization is still a net win: haiku is ~12× cheaper.
const MODEL = 'claude-haiku-4-5';
const PER_CYCLE_CAP = 3;
const MAX_FILE_BYTES = 100 * 1024;       // skip files >100KB for the LLM call (token cost)
const TIMEOUT_MS = 90_000;               // CLI bootstrap dominates — needs the full window
const SOURCE_TRUNCATE = 12_000;          // 12KB of source max — the structured intent prompt only needs the gist
// Stop dispatching new calls once the cycle has consumed this much wall
// clock — leaves headroom under the orchestrator's 5-min hard timeout.
const CYCLE_WALL_BUDGET_MS = 220_000;

type Candidate = {
  path: string;
  exportNames: string[];
  exportCount: number;
  staleness: 'never' | 'stale' | 'fresh';   // never = no intent yet; stale = file changed since last intent
};

function selectCandidates(): Candidate[] {
  // Pick modules that:
  //   - codebase-graph has parsed (have a code_files row)
  //   - have at least 1 exported function or class in register
  //   - have NO intent_summary, OR intent_at is older than parsed_at
  // Ranked: never > stale, then by export count desc (most-used first).
  const rows = query<{
    path: string;
    parsed_at: number;
    intent_summary: string | null;
    intent_at: number | null;
    export_count: number;
  }>(`
    SELECT cf.path, cf.parsed_at, cf.intent_summary, cf.intent_at,
      (SELECT COUNT(*) FROM register r
         WHERE r.agent = 'codebase-graph'
           AND r.kind IN ('function', 'class')
           AND r.file = cf.path) AS export_count
    FROM code_files cf
    WHERE export_count > 0
    ORDER BY export_count DESC, cf.parsed_at DESC
  `);

  const out: Candidate[] = [];
  for (const r of rows) {
    const staleness: Candidate['staleness'] =
      r.intent_summary === null ? 'never'
      : (r.intent_at ?? 0) < r.parsed_at ? 'stale'
      : 'fresh';
    if (staleness === 'fresh') continue;
    // Pull export names so we can include them in the prompt.
    const names = query<{ label: string }>(
      `SELECT label FROM register WHERE agent = 'codebase-graph' AND file = ? AND kind IN ('function','class') ORDER BY label`,
      [r.path],
    ).map((x) => x.label);
    out.push({
      path: r.path,
      exportNames: names,
      exportCount: r.export_count,
      staleness,
    });
    if (out.length >= PER_CYCLE_CAP * 2) break;       // prefetch a few extras
  }
  // Never-extracted come first; then stale.
  out.sort((a, b) => {
    if (a.staleness === 'never' && b.staleness !== 'never') return -1;
    if (b.staleness === 'never' && a.staleness !== 'never') return 1;
    return b.exportCount - a.exportCount;
  });
  return out.slice(0, PER_CYCLE_CAP);
}

function buildPrompt(c: Candidate, source: string): string {
  return `# Hard path — extract THIS module's intent

You are summarizing one source file from the user's repo so other dev-infra agents can ground their work in real understanding instead of grepping cold. Confidence-or-skip: if you can't answer ALL four questions from evidence in the file, return Shape B.

## File: ${c.path}

Exports (${c.exportCount}): ${c.exportNames.slice(0, 12).join(', ')}${c.exportNames.length > 12 ? ` … +${c.exportNames.length - 12}` : ''}

\`\`\`
${source.slice(0, SOURCE_TRUNCATE)}
\`\`\`

## Output — pick ONE shape

**Shape A (you can answer all four with file evidence):**
\`\`\`
PURPOSE: <1 sentence — what this module does, in plain English. No hedging. No "this seems to" / "appears to".>
USED-BY: <which kinds of callers — e.g. "screens that need user-profile state", "API handlers", "the auth flow". Cite import patterns or naming conventions visible in the file. If unknown from this file alone, say "unknown from this file" (do NOT guess).>
DEPENDS-ON: <key non-stdlib imports + what each provides — e.g. "supabase: persistence; zod: validation; ../contracts/user: contract op definitions". Skip trivial imports (react, lodash).>
FRAGILE-WHEN: <concrete failure modes you can SEE in the code — e.g. "row missing user_id (no null guard line 42)", "fetch retries unbounded (no timeout passed line 17)". Only failures grounded in lines you can point to. If none visible, say "no obvious fragility from this file alone".>
\`\`\`

**Shape B (you cannot answer all four with file-level evidence):**
\`\`\`
DEFERRED: <one sentence — why you can't summarize. Examples: "file is just re-exports, no implementation", "file is generated/minified", "file requires reading 5+ other modules to understand">
\`\`\`

Return ONLY the chosen shape. No prose around it. No markdown headers other than the field labels above.`;
}

function parseShapeA(text: string): { purpose: string; usedBy: string; dependsOn: string; fragileWhen: string } | null {
  // Permissive: tolerate optional code fences + extra whitespace, but require all four labels.
  const stripped = text.replace(/^```[a-z]*\n?|\n?```$/g, '').trim();
  const m = stripped.match(
    /PURPOSE:\s*(.+?)\s*\n\s*USED-BY:\s*(.+?)\s*\n\s*DEPENDS-ON:\s*(.+?)\s*\n\s*FRAGILE-WHEN:\s*(.+?)\s*$/s,
  );
  if (!m) return null;
  return { purpose: m[1]!.trim(), usedBy: m[2]!.trim(), dependsOn: m[3]!.trim(), fragileWhen: m[4]!.trim() };
}

function parseShapeB(text: string): string | null {
  const m = text.match(/DEFERRED:\s*(.+?)\s*$/s);
  return m ? m[1]!.trim() : null;
}

export const intentExtractorAgent: Agent = {
  name: 'intent-extractor',
  description: 'LLM-extracts a 4-bullet intent summary per module (purpose / used-by / depends-on / fragile-when); stored in code_files for downstream grounding.',
  routedFiles: [],
  intervalMs: 30 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();
    const candidates = selectCandidates();

    if (candidates.length === 0) {
      return [{
        id: newId(),
        agent: 'intent-extractor',
        kind: 'intent:no-candidates',
        at: now,
        severity: 'info',
        summary: 'no modules need intent extraction (every parsed module is fresh)',
      }];
    }

    let extracted = 0;
    let deferred = 0;
    let failed = 0;
    const cycleStart = Date.now();

    for (const c of candidates) {
      // Wall-budget check — bail out before risking the orchestrator's
      // hard 5-min timeout. Better to ship partial results than crash.
      if (Date.now() - cycleStart > CYCLE_WALL_BUDGET_MS) break;
      const abs = resolve(config.targetPath, c.path);
      if (!existsSync(abs)) { failed++; continue; }
      let source: string;
      try { source = readFileSync(abs, 'utf8'); } catch { failed++; continue; }
      if (source.length > MAX_FILE_BYTES) {
        // Too big — skip. The cycle moves on to the next candidate.
        continue;
      }

      try {
        const r = await runClaude({
          prompt: buildPrompt(c, source),
          timeoutMs: TIMEOUT_MS,
          model: MODEL,
          // Read-only — no Edit/Write needed. The intent agent never mutates user code.
          allowedTools: ['Read', 'Grep', 'Glob'],
        });

        const a = parseShapeA(r.text);
        if (a) {
          // Store as a structured-ish blob inside the single intent_summary
          // column. Downstream agents read it back as a JSON object.
          const body = JSON.stringify({ shape: 'A', ...a, extractedAt: Date.now() });
          recordCodeFileIntent(c.path, body, Date.now());
          extracted++;
          out.push({
            id: newId(),
            agent: 'intent-extractor',
            kind: 'intent:extracted',
            at: Date.now(),
            severity: 'info',
            summary: `${c.path} · ${a.purpose.slice(0, 110)}${a.purpose.length > 110 ? '…' : ''}`,
            file: c.path,
            payload: {
              path: c.path,
              exportCount: c.exportCount,
              staleness: c.staleness,
              ...a,
              ...(r.usage ? { usage: r.usage } : {}),
            },
          });
          continue;
        }

        const b = parseShapeB(r.text);
        if (b) {
          // Persist the deferral so we don't keep re-trying — same file
          // hash will hit fresh on next cycle and be skipped.
          recordCodeFileIntent(c.path, JSON.stringify({ shape: 'B', deferred: b, extractedAt: Date.now() }), Date.now());
          deferred++;
          out.push({
            id: newId(),
            agent: 'intent-extractor',
            kind: 'intent:deferred',
            at: Date.now(),
            severity: 'info',
            summary: `${c.path} · deferred: ${b.slice(0, 140)}`,
            file: c.path,
            payload: { path: c.path, reason: b },
          });
          continue;
        }

        // Neither shape matched → schema reject (don't store).
        failed++;
        out.push({
          id: newId(),
          agent: 'intent-extractor',
          kind: 'intent:malformed',
          at: Date.now(),
          severity: 'warn',
          summary: `${c.path} · malformed LLM output (neither Shape A nor B)`,
          file: c.path,
          payload: { path: c.path, outputTail: r.text.slice(-400) },
        });
      } catch (e) {
        failed++;
        out.push({
          id: newId(),
          agent: 'intent-extractor',
          kind: 'intent:failed',
          at: Date.now(),
          severity: 'warn',
          summary: `${c.path} · ${(e as Error).message.slice(0, 160)}`,
          file: c.path,
          payload: { path: c.path, error: (e as Error).message },
        });
      }
    }

    out.push({
      id: newId(),
      agent: 'intent-extractor',
      kind: 'intent:summary',
      at: Date.now(),
      severity: 'info',
      summary: `intent · ${candidates.length} candidates · ${extracted} extracted · ${deferred} deferred · ${failed} failed`,
      payload: { candidates: candidates.length, extracted, deferred, failed, perCycleCap: PER_CYCLE_CAP },
    });

    return out;
  },
};
