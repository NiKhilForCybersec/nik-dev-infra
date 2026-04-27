/* Test-coverage agent — deterministic.
 *
 * Per project_test_coverage_agent memory. Cross-references the
 * knowledge-graph exports (codebase-graph) against test-file imports
 * + describe/it names (Tree-sitter parse). Every exported function /
 * class with no test coverage is a candidate gap; severity is graded
 * by recency + auto-fix-driver activity:
 *
 *   error  — auto-fix-driver edited an export in last 7d, no test added
 *   warn   — user touched an export in last 7d (codebase-graph
 *            parsed_at), no test
 *   info   — ever-untested export with intent-extractor fragility
 *            note, low priority backlog
 *   (none) — ever-untested with no recency / fragility signal: too
 *            noisy to flag, kept silent
 *
 * Per-cycle cap of 5 user-facing findings to keep the rail calm. The
 * `coverage:summary` digest carries totals. A finding latches via the
 * (path, label) fingerprint — re-emits ONLY when severity bumps OR
 * the touch threshold crosses again. Resolved gaps emit
 * `coverage:closed` (info, suppressed by curator).
 *
 * Hard-path: only flags when BOTH a test framework is configured
 * (vitest / jest / playwright / mocha / @playwright/test / node:test
 * present in any walked package.json) AND at least 1 test file was
 * parsed. Otherwise emits `coverage:no-framework` once and exits.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, query, registerEntity } from '../memory.ts';
import type { Agent, Finding, Severity } from '../types.ts';

const MAX_FILE_BYTES = 200 * 1024;
const PER_CYCLE_FINDING_CAP = 5;
const RECENCY_MS = 7 * 24 * 60 * 60 * 1000;
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache', '.vite', 'coverage', '.git']);
const TEST_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_NAME_PATTERN = /(\.(test|spec)\.[mc]?[tj]sx?$|^.*__tests__\/)/i;
// Bare `playwright` is the browser-automation runtime (we use it for
// screenshots) — NOT the test runner. Only `@playwright/test`
// indicates a configured Playwright test suite. Same logic for vitest:
// `@vitest/runner` is the binary, not always declared as a top-level dep.
const TEST_FRAMEWORKS = ['vitest', 'jest', 'mocha', '@playwright/test', '@vitest/runner', 'ava', 'tap', 'uvu'];

type ParsedTest = {
  path: string;
  imports: { source: string; names: string[] }[];
  blocks: string[];                 // describe / it / test string-literal args
};

let parser: any = null;
let tsxLanguage: any = null;
let tsLanguage: any = null;
async function getParser() {
  if (parser) return { parser, tsx: tsxLanguage, ts: tsLanguage };
  try {
    const TreeSitter = (await import('tree-sitter')).default;
    const TSmod: any = await import('tree-sitter-typescript');
    const TS: any = (TSmod && TSmod.tsx) ? TSmod : (TSmod.default ?? TSmod);
    if (!TS?.tsx || !TS?.typescript) return null;
    parser = new TreeSitter();
    tsxLanguage = TS.tsx;
    tsLanguage = TS.typescript;
    return { parser, tsx: tsxLanguage, ts: tsLanguage };
  } catch { return null; }
}

function pickLanguage(p: { tsx: any; ts: any }, ext: string) {
  return (ext === '.tsx' || ext === '.jsx') ? p.tsx : p.ts;
}

// ─── package.json discovery (multi-workspace) ──────────────────────────────

function detectFrameworks(): string[] {
  const found = new Set<string>();
  const candidates = ['package.json', 'web/package.json', 'app/package.json', 'apps/web/package.json', 'packages/web/package.json'];
  for (const rel of candidates) {
    const p = resolve(config.targetPath, rel);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const allDeps = { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) };
      for (const f of TEST_FRAMEWORKS) if (f in allDeps) found.add(f);
    } catch { /* */ }
  }
  return [...found];
}

// ─── walk for test files only ──────────────────────────────────────────────

function walkTestFiles(rootDirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Walk both the configured frontend / backend dirs AND any top-level
  // tests/ dir, since many repos keep tests siblings of src.
  const allDirs = [...rootDirs, 'tests', 'test', '__tests__', 'spec'].filter((g, i, a) => a.indexOf(g) === i);
  for (const rootRel of allDirs) {
    const root = resolve(config.targetPath, rootRel);
    if (!existsSync(root)) continue;
    const stack: string[] = [root];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let entries: string[];
      try { entries = readdirSync(cur); } catch { continue; }
      for (const name of entries) {
        if (SKIP_DIR_NAMES.has(name)) continue;
        const abs = join(cur, name);
        if (seen.has(abs)) continue;
        let st;
        try { st = statSync(abs); } catch { continue; }
        if (st.isDirectory()) { stack.push(abs); continue; }
        if (!st.isFile()) continue;
        if (st.size > MAX_FILE_BYTES) continue;
        if (!TEST_EXT.has(extname(name))) continue;
        const rel = relative(config.targetPath, abs);
        if (!TEST_NAME_PATTERN.test(rel)) continue;
        seen.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}

// ─── parse one test file: imports + describe/it names ──────────────────────

function parseTestFile(p: { parser: any; tsx: any; ts: any }, abs: string, rel: string, source: string): ParsedTest {
  const imports: ParsedTest['imports'] = [];
  const blocks: string[] = [];
  try {
    p.parser.setLanguage(pickLanguage(p, extname(abs)));
    const tree = p.parser.parse(source);
    const root = tree.rootNode;

    // Top-level imports
    for (let i = 0; i < root.namedChildCount; i++) {
      const child = root.namedChild(i);
      if (!child || child.type !== 'import_statement') continue;
      const stringNode = child.children.find((c: any) => c.type === 'string');
      const fragment = stringNode?.namedChild(0);
      const sourceStr = fragment?.text ?? null;
      if (!sourceStr) continue;
      const names: string[] = [];
      const clause = child.children.find((c: any) => c.type === 'import_clause');
      if (clause) {
        for (let j = 0; j < clause.namedChildCount; j++) {
          const part = clause.namedChild(j);
          if (!part) continue;
          if (part.type === 'identifier') names.push(part.text);
          else if (part.type === 'namespace_import') {
            const id = part.namedChild(0);
            if (id?.text) names.push(id.text);
          } else if (part.type === 'named_imports') {
            for (let k = 0; k < part.namedChildCount; k++) {
              const spec = part.namedChild(k);
              if (spec?.type === 'import_specifier') {
                const id = spec.namedChild(0);
                if (id?.text) names.push(id.text);
              }
            }
          }
        }
      }
      imports.push({ source: sourceStr, names });
    }

    // Recursive walk for describe / it / test calls.
    function findBlocks(n: any, depth: number) {
      if (depth > 6) return;
      if (n.type === 'call_expression') {
        const callee = n.children[0];
        const calleeName = callee?.text;
        if (calleeName && /^(describe|it|test)(?:\.(?:only|skip|each))?$/.test(calleeName)) {
          const argList = n.children.find((c: any) => c.type === 'arguments');
          const firstArg = argList?.namedChild(0);
          if (firstArg?.type === 'string') {
            const fragment = firstArg.namedChild(0);
            if (fragment?.text) blocks.push(fragment.text);
          }
        }
      }
      for (let i = 0; i < n.namedChildCount; i++) findBlocks(n.namedChild(i), depth + 1);
    }
    findBlocks(root, 0);
  } catch { /* parse error — return what we have */ }
  return { path: rel, imports, blocks };
}

// ─── path resolver (mirrors codebase-graph; kept local to avoid coupling) ──

const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];
const INDEX_NAMES = RESOLVE_EXTS.map((e) => `index${e}`);
function resolveFileOnDisk(absStem: string): string | null {
  for (const ext of RESOLVE_EXTS) { const p = absStem + ext; if (existsSync(p)) return p; }
  for (const idx of INDEX_NAMES) { const p = join(absStem, idx); if (existsSync(p)) return p; }
  return null;
}

let aliasCache: { baseUrl: string; paths: Record<string, string[]> } | null | undefined;
function loadAliases() {
  if (aliasCache !== undefined) return aliasCache;
  const candidates = ['tsconfig.json', 'web/tsconfig.json', 'apps/web/tsconfig.json', 'tsconfig.base.json'];
  for (const rel of candidates) {
    const abs = resolve(config.targetPath, rel);
    if (!existsSync(abs)) continue;
    try {
      const raw = readFileSync(abs, 'utf8')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([}\]])/g, '$1');
      const j = JSON.parse(raw);
      const co = j.compilerOptions ?? {};
      if (co.paths || co.baseUrl) {
        aliasCache = { baseUrl: resolve(abs, '..', co.baseUrl ?? '.'), paths: co.paths ?? {} };
        return aliasCache;
      }
    } catch { /* */ }
  }
  aliasCache = null;
  return null;
}

function resolveImportToFile(testAbs: string, source: string): string | null {
  const src = source.startsWith('type:') ? source.slice(5).trim() : source;
  if (src.startsWith('./') || src.startsWith('../')) {
    const stem = resolve(dirname(testAbs), src);
    const f = resolveFileOnDisk(stem);
    return f ? relative(config.targetPath, f) : null;
  }
  const aliases = loadAliases();
  if (aliases) {
    for (const [pattern, targets] of Object.entries(aliases.paths)) {
      const re = new RegExp('^' + pattern.replace('*', '(.+)') + '$');
      const m = re.exec(src);
      if (!m) continue;
      for (const target of targets) {
        const stem = resolve(aliases.baseUrl, target.replace('*', m[1] ?? ''));
        const f = resolveFileOnDisk(stem);
        if (f) return relative(config.targetPath, f);
      }
    }
  }
  return null;
}

// ─── coverage cross-reference ─────────────────────────────────────────────

type ExportRow = { urn: string; file: string; label: string; kind: string; parsed_at: number | null; intent_summary: string | null };

function rankGaps(uncovered: ExportRow[]): { sev: Severity; reason: string; row: ExportRow }[] {
  const now = Date.now();
  // Look up auto-fix-driver touches in last 7d (keyed by file path —
  // any cycle that targeted the file gets credit).
  const recentFix = new Map<string, number>();
  const fixRows = query<{ file: string; at: number }>(
    `SELECT file, MAX(at) AS at FROM findings
       WHERE agent = 'auto-fix-driver' AND kind IN ('auto-fix:cycle-complete')
         AND file IS NOT NULL AND at >= ?
       GROUP BY file`,
    [now - RECENCY_MS],
  );
  for (const r of fixRows) recentFix.set(r.file, r.at);

  const ranked: { sev: Severity; reason: string; row: ExportRow }[] = [];
  for (const row of uncovered) {
    const fixedRecently = recentFix.has(row.file);
    const userTouchedRecently = row.parsed_at !== null && (now - row.parsed_at) < RECENCY_MS;
    let intentFragile = false;
    if (row.intent_summary) {
      try {
        const j = JSON.parse(row.intent_summary) as { fragileWhen?: string };
        const fw = (j.fragileWhen ?? '').toLowerCase();
        intentFragile = fw.length > 0 && !/no obvious fragility/i.test(fw);
      } catch { /* */ }
    }
    if (fixedRecently) {
      ranked.push({ sev: 'error', reason: 'auto-fix cycle landed in last 7d but no test added — regression risk', row });
    } else if (userTouchedRecently) {
      ranked.push({ sev: 'warn', reason: 'export edited in last 7d, no test', row });
    } else if (intentFragile) {
      ranked.push({ sev: 'info', reason: 'export marked fragile by intent extractor + no test', row });
    }
    // No-recency, no-fragility exports are intentionally skipped — that
    // bucket is "backlog noise" and would flood the rail on first run.
  }
  // Severity priority then most-recent-touch.
  const sevWeight: Record<Severity, number> = { error: 3, warn: 2, info: 1 };
  ranked.sort((a, b) => {
    const sd = sevWeight[b.sev] - sevWeight[a.sev];
    if (sd !== 0) return sd;
    return (b.row.parsed_at ?? 0) - (a.row.parsed_at ?? 0);
  });
  return ranked;
}

function fingerprint(row: ExportRow): string {
  return createHash('sha256').update(`${row.file}::${row.kind}::${row.label}`).digest('hex').slice(0, 16);
}

// Latch: don't re-emit the same gap finding within the lookback unless
// severity escalated. Look for a prior `coverage:gap-discovered` with
// the same fingerprint in the last 24h.
function recentlyEmitted(fp: string, currentSev: Severity): boolean {
  const rows = query<{ severity: string; at: number }>(
    `SELECT severity, at FROM findings
       WHERE agent = 'test-coverage' AND kind = 'coverage:gap-discovered'
         AND payload_json LIKE ?
         AND at >= ?
       ORDER BY at DESC LIMIT 1`,
    [`%"fingerprint":"${fp}"%`, Date.now() - 24 * 60 * 60 * 1000],
  );
  if (rows.length === 0) return false;
  const last = rows[0]!;
  // Re-emit only if severity escalated (info → warn → error).
  const sevW: Record<string, number> = { info: 1, warn: 2, error: 3 };
  return (sevW[currentSev] ?? 0) <= (sevW[last.severity] ?? 0);
}

export const testCoverageAgent: Agent = {
  name: 'test-coverage',
  description: 'Cross-references knowledge-graph exports against test-file imports + describe/it; flags untested code (esp. auto-fix touches without tests).',
  routedFiles: [
    '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', '**/*.test.jsx',
    '**/*.spec.ts', '**/*.spec.tsx', '**/*.spec.js', '**/*.spec.jsx',
  ],
  intervalMs: 30 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    // Reset alias cache once per cycle so tsconfig edits land.
    aliasCache = undefined;

    // Pre-flight 1: at least one test framework declared
    const frameworks = detectFrameworks();
    if (frameworks.length === 0) {
      return [{
        id: newId(),
        agent: 'test-coverage',
        kind: 'coverage:no-framework',
        at: now,
        severity: 'info',
        summary: 'no test framework declared in any walked package.json (vitest / jest / mocha / @playwright/test / playwright) — coverage check skipped',
      }];
    }

    // Pre-flight 2: the knowledge graph has been populated
    const moduleCount = query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM register WHERE agent = 'codebase-graph' AND kind = 'module'`,
    )[0]?.n ?? 0;
    if (moduleCount === 0) {
      return [{
        id: newId(),
        agent: 'test-coverage',
        kind: 'coverage:no-framework',
        at: now,
        severity: 'info',
        summary: 'codebase-graph has not parsed yet — coverage check requires at least one knowledge-graph cycle to complete first',
      }];
    }

    // Walk + parse test files
    const p = await getParser();
    if (!p) {
      return [{
        id: newId(),
        agent: 'test-coverage',
        kind: 'coverage:no-framework',
        at: now,
        severity: 'warn',
        summary: 'tree-sitter native binding not loadable — npm rebuild tree-sitter tree-sitter-typescript',
      }];
    }

    const dirs = [...(config.frontendGlobs ?? []), ...(config.backendDirs ?? [])]
      .map((g) => g.replace(/\/\*\*.*$/, ''))
      .filter((g, i, a) => a.indexOf(g) === i);
    const testFiles = walkTestFiles(dirs);

    if (testFiles.length === 0) {
      return [{
        id: newId(),
        agent: 'test-coverage',
        kind: 'coverage:no-test-files',
        at: now,
        severity: 'info',
        summary: `${frameworks.join(' + ')} declared but no test files found — convention is *.test.{ts,tsx} / *.spec.{ts,tsx} / __tests__/**`,
        payload: { frameworks },
      }];
    }

    // Build (file → set of resolved import targets) map + blocks lookup
    const coverageByFile = new Map<string, { suite: string; importedFrom: Set<string>; importedNames: Set<string>; blocks: string[] }>();
    let parsedSuites = 0;
    for (const abs of testFiles) {
      const rel = relative(config.targetPath, abs);
      let source: string;
      try { source = readFileSync(abs, 'utf8'); } catch { continue; }
      const t = parseTestFile(p, abs, rel, source);
      const importedFrom = new Set<string>();
      const importedNames = new Set<string>();
      for (const imp of t.imports) {
        for (const n of imp.names) importedNames.add(n);
        const f = resolveImportToFile(abs, imp.source);
        if (f) importedFrom.add(f);
      }
      coverageByFile.set(rel, { suite: rel, importedFrom, importedNames, blocks: t.blocks });

      // Register the test suite + emit covers facts. The covers edge is
      // emitted per imported export — we resolve those below against
      // the registry.
      const suiteUrn = `test-suite:${rel}`;
      registerEntity({
        urn: suiteUrn,
        kind: 'test-suite',
        label: rel,
        file: rel,
        agent: 'test-coverage',
        evidence: [rel],
      });
      parsedSuites++;
    }

    // Cross-reference: every export in register → covered if any test
    // suite imports its file AND mentions its name OR has a block name
    // matching its label.
    const exports = query<ExportRow>(`
      SELECT r.urn, r.file, r.label, r.kind,
        cf.parsed_at, cf.intent_summary
      FROM register r
      LEFT JOIN code_files cf ON cf.path = r.file
      WHERE r.agent = 'codebase-graph' AND r.kind IN ('function', 'class') AND r.file IS NOT NULL
      ORDER BY r.file, r.label
    `);
    let covered = 0;
    let coveredViaImport = 0;
    let coveredViaName = 0;
    const uncovered: ExportRow[] = [];
    for (const row of exports) {
      let isCovered = false;
      let viaImport = false;
      let viaName = false;
      for (const [, suite] of coverageByFile) {
        if (suite.importedFrom.has(row.file) && suite.importedNames.has(row.label)) {
          isCovered = true; viaImport = true; break;
        }
        // Soft signal: describe / it text mentions the export label.
        if (suite.blocks.some((b) => b.includes(row.label))) {
          isCovered = true; viaName = true;
          // Don't break — prefer an import-match if also present.
        }
      }
      if (isCovered) {
        covered++;
        if (viaImport) coveredViaImport++;
        else if (viaName) coveredViaName++;
        // Emit a covers fact (idempotent via memory layer's UPSERT).
        addFact({
          agent: 'test-coverage',
          subject: `module:${row.file}`,         // suite URN would also work; module-level keeps the graph less noisy
          predicate: 'covers',
          object: row.urn,
          evidence: [row.file],
        });
      } else {
        uncovered.push(row);
      }
    }

    const ranked = rankGaps(uncovered);
    let emitted = 0;
    for (const r of ranked) {
      if (emitted >= PER_CYCLE_FINDING_CAP) break;
      const fp = fingerprint(r.row);
      if (recentlyEmitted(fp, r.sev)) continue;
      out.push({
        id: newId(),
        agent: 'test-coverage',
        kind: 'coverage:gap-discovered',
        at: now,
        severity: r.sev,
        summary: `${r.row.kind} \`${r.row.label}\` in ${r.row.file} · ${r.reason}`,
        file: r.row.file,
        payload: {
          fingerprint: fp,
          urn: r.row.urn,
          file: r.row.file,
          label: r.row.label,
          kind: r.row.kind,
          reason: r.reason,
        },
      });
      emitted++;
    }

    out.push({
      id: newId(),
      agent: 'test-coverage',
      kind: 'coverage:summary',
      at: now,
      severity: ranked.some((x) => x.sev === 'error') ? 'warn' : 'info',
      summary: `${exports.length} exports · ${covered} covered (${coveredViaImport} via import, ${coveredViaName} via name) · ${uncovered.length} uncovered · ${ranked.length} ranked gaps · ${emitted} new findings · ${parsedSuites} test suites`,
      payload: {
        exports: exports.length,
        covered,
        coveredViaImport,
        coveredViaName,
        uncovered: uncovered.length,
        rankedGaps: ranked.length,
        newFindings: emitted,
        testSuites: parsedSuites,
        frameworks,
      },
    });

    return out;
  },
};
