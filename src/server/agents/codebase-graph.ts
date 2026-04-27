/* Codebase-graph agent — deterministic.
 *
 * Phase 1 of the user-repo knowledge graph (per
 * project_user_repo_knowledge_graph memory). Walks the user's repo,
 * parses each .ts/.tsx/.js/.jsx file with Tree-sitter, extracts
 * EXPORTED functions + classes + the module itself, registers them in
 * L5 with new entity kinds:
 *
 *   module:<relative-path>
 *   function:<relative-path>:<name>
 *   class:<relative-path>:<name>
 *
 * Plus L1b facts for export relationships:
 *   (function/class urn) exported_by (module urn)
 *
 * Phase 2 (intent extraction via LLM) and Phase 3 (embeddings +
 * clustering) are separate agents; this one is the foundational
 * structural pass that everything else depends on.
 *
 * Hard-path:
 *   - Only EXPORTED items get registered. Exporting is a deliberate
 *     API-surface choice; internal helpers would bloat the register
 *     without adding signal. Internal helpers can be added later if
 *     downstream agents need them.
 *   - Per-file SHA cache (code_files table): on each cycle, skip files
 *     whose content hash matches the last parse. Saves seconds on
 *     unchanged repos.
 *   - Tree-sitter is loaded lazily inside run() so a missing native
 *     binding doesn't crash daemon boot — emits an info finding instead.
 *   - File reads + parses are bounded: skip files > 200KB (likely
 *     generated / minified) and skip the whole agent if the user has
 *     no frontendGlobs / backendDirs configured.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, getCodeFile, recordCodeFileParse, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const MAX_FILE_BYTES = 200 * 1024;
const PARSE_INTERVAL_MS = 30 * 60 * 1000;
const PARSEABLE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', '.cache', '.vite', 'coverage', '.git']);

type ExtractedExport = { kind: 'function' | 'class'; name: string; line: number };
type ParseResult = {
  exports: ExtractedExport[];
  parseError?: string;
};

// Lazy Tree-sitter — keep the cost off boot. Cached after first init.
type Parser = any;
let parser: Parser | null = null;
let tsxLanguage: any = null;
let tsLanguage: any = null;

async function getParser(): Promise<{ parser: Parser; tsx: any; ts: any } | null> {
  if (parser) return { parser, tsx: tsxLanguage, ts: tsLanguage };
  try {
    const TreeSitter = (await import('tree-sitter')).default;
    // tree-sitter-typescript is CJS; ESM dynamic-import wraps the named
    // exports in `.default`. Try direct first then fall back so we work
    // across module-resolution variants.
    const TSmod: any = await import('tree-sitter-typescript');
    const TS: any = (TSmod && TSmod.tsx) ? TSmod : (TSmod.default ?? TSmod);
    if (!TS?.tsx || !TS?.typescript) return null;
    parser = new TreeSitter();
    tsxLanguage = TS.tsx;
    tsLanguage = TS.typescript;
    return { parser, tsx: tsxLanguage, ts: tsLanguage };
  } catch {
    return null;
  }
}

function pickLanguage(p: { tsx: any; ts: any }, ext: string) {
  // .tsx / .jsx use the TSX grammar (handles JSX). .ts / .js / .mjs / .cjs use TS.
  return (ext === '.tsx' || ext === '.jsx') ? p.tsx : p.ts;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

// Walk the configured globs (kept simple — recursive directory walk with
// a skip-set instead of full glob expansion, since chokidar already covers
// the watch globs and we only need an enumeration here).
function walkRepo(rootDirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rootRel of rootDirs) {
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
        if (!PARSEABLE_EXT.has(extname(name))) continue;
        seen.add(abs);
        out.push(abs);
      }
    }
  }
  return out;
}

// Walk the AST and pull every top-level exported function + class. Exports
// take three shapes in TS/JS:
//   export function foo() {}
//   export class Bar {}
//   export const baz = () => {} / export const Quux = class {};
//   export default function foo() {}  → name = 'default'
function extractExports(node: any): ExtractedExport[] {
  const out: ExtractedExport[] = [];

  function walkExportStatement(exportNode: any) {
    // export_statement → declaration | export_specifier list
    for (let i = 0; i < exportNode.namedChildCount; i++) {
      const child = exportNode.namedChild(i);
      if (!child) continue;
      const t = child.type;
      if (t === 'function_declaration') {
        const name = child.childForFieldName('name')?.text ?? null;
        if (name) out.push({ kind: 'function', name, line: child.startPosition.row + 1 });
      } else if (t === 'class_declaration') {
        const name = child.childForFieldName('name')?.text ?? null;
        if (name) out.push({ kind: 'class', name, line: child.startPosition.row + 1 });
      } else if (t === 'lexical_declaration' || t === 'variable_declaration') {
        // export const Foo = () => {} / class {}
        for (let j = 0; j < child.namedChildCount; j++) {
          const decl = child.namedChild(j);
          if (decl?.type !== 'variable_declarator') continue;
          const name = decl.childForFieldName('name')?.text ?? null;
          const value = decl.childForFieldName('value');
          if (!name || !value) continue;
          // Heuristic: arrow_function / function / class_declaration → counts as that kind
          if (value.type === 'arrow_function' || value.type === 'function' || value.type === 'function_expression') {
            out.push({ kind: 'function', name, line: decl.startPosition.row + 1 });
          } else if (value.type === 'class' || value.type === 'class_expression') {
            out.push({ kind: 'class', name, line: decl.startPosition.row + 1 });
          }
        }
      }
    }
  }

  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'export_statement') walkExportStatement(child);
  }
  return out;
}

function parseFile(p: { parser: Parser; tsx: any; ts: any }, absPath: string, source: string): ParseResult {
  try {
    p.parser.setLanguage(pickLanguage(p, extname(absPath)));
    const tree = p.parser.parse(source);
    return { exports: extractExports(tree.rootNode) };
  } catch (e) {
    return { exports: [], parseError: (e as Error).message.slice(0, 200) };
  }
}

export const codebaseGraphAgent: Agent = {
  name: 'codebase-graph',
  description: 'Tree-sitter AST extraction of exported functions + classes from the user repo; foundational pass for the Graphify-class user-repo knowledge graph.',
  routedFiles: [],          // self-paced via interval; the file watcher would be too noisy here
  intervalMs: PARSE_INTERVAL_MS,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    // Pre-flight: source dirs configured?
    const dirs = [...(config.frontendGlobs ?? []), ...(config.backendDirs ?? [])]
      .map((g) => g.replace(/\/\*\*.*$/, ''))      // strip the /**/*.{ts,tsx} suffix
      .filter((g, i, a) => a.indexOf(g) === i);    // dedupe
    if (dirs.length === 0) {
      return [{
        id: newId(),
        agent: 'codebase-graph',
        kind: 'codebase-graph:no-source',
        at: now,
        severity: 'info',
        summary: 'no frontendGlobs / backendDirs configured — nothing to parse',
      }];
    }

    const p = await getParser();
    if (!p) {
      return [{
        id: newId(),
        agent: 'codebase-graph',
        kind: 'codebase-graph:tree-sitter-missing',
        at: now,
        severity: 'warn',
        summary: 'tree-sitter native binding not loadable — run `npm rebuild tree-sitter tree-sitter-typescript` and restart',
      }];
    }

    const files = walkRepo(dirs);
    let parsed = 0;
    let cached = 0;
    let errors = 0;
    let exportsTotal = 0;
    let modulesRegistered = 0;
    const start = Date.now();

    for (const abs of files) {
      const rel = relative(config.targetPath, abs);
      let source: string;
      try { source = readFileSync(abs, 'utf8'); } catch { errors++; continue; }
      const hash = sha256(source);
      const cachedRec = getCodeFile(rel);
      if (cachedRec && cachedRec.sha256 === hash) {
        cached++;
        continue;
      }

      const r = parseFile(p, abs, source);
      if (r.parseError) errors++;

      // Register the module itself (always — this is a stable URN even
      // when the module has zero exports — the export count + intent live
      // off this node downstream).
      const moduleUrn = `module:${rel}`;
      registerEntity({
        urn: moduleUrn,
        kind: 'module',
        label: rel,
        file: rel,
        agent: 'codebase-graph',
        evidence: [rel],
      });
      modulesRegistered++;

      for (const exp of r.exports) {
        const urn = `${exp.kind}:${rel}:${exp.name}`;
        registerEntity({
          urn,
          kind: exp.kind,
          label: exp.name,
          file: rel,
          agent: 'codebase-graph',
          evidence: [`${rel}:${exp.line}`],
        });
        addFact({
          agent: 'codebase-graph',
          subject: urn,
          predicate: 'exported_by',
          object: moduleUrn,
          evidence: [`${rel}:${exp.line}`],
        });
        exportsTotal++;
      }

      // Only record the cache entry when the parse SUCCEEDED — otherwise
      // a failure caches as "done" and the next cycle skips it forever.
      if (!r.parseError) recordCodeFileParse(rel, hash);
      parsed++;
    }

    out.push({
      id: newId(),
      agent: 'codebase-graph',
      kind: 'codebase-graph:summary',
      at: Date.now(),
      severity: errors > parsed * 0.5 ? 'warn' : 'info',
      summary: `${files.length} files · ${parsed} parsed · ${cached} cache-hit · ${errors} parse-error · ${exportsTotal} exports · ${modulesRegistered} modules · ${Math.round((Date.now() - start) / 1000)}s`,
      payload: {
        files: files.length,
        parsed,
        cached,
        errors,
        exportsTotal,
        modulesRegistered,
        durationMs: Date.now() - start,
        dirs,
      },
    });

    return out;
  },
};
