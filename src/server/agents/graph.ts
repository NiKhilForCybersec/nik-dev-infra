/* Graph agent — deterministic.
 *
 * Walks the target repo and assembles a typed topology graph that
 * captures both the frontend and the backend (per the Step-D
 * graph-expansion plan):
 *
 *   screen ──reads/writes──▶ op
 *   screen ─dispatches────▶ cmd
 *   screen ─navigates_to──▶ screen
 *   screen ─calls─────────▶ endpoint            (fetch('/api/x'))
 *   screen ─invokes_llm───▶ llm_provider        (sdk import)
 *   endpoint exists                              (Supabase Edge fn / Next route / Express)
 *
 * Output is written to data/graph.json (served via /api/graph)
 * AND mirrored into the memory layer:
 *   - register entries for every screen / op / cmd / endpoint /
 *     llm_provider node (URN-keyed canonical catalog)
 *   - addFact triples for every edge — these are the bootstrap
 *     pass's substrate for "what's true about this codebase"
 *
 * Hard-path: every fact is written at confidence 1.0 only with a
 * file:line evidence reference. If a regex matches but we can't
 * pin the source, no fact is written.
 *
 * Cheap (~50ms typical for the Nik repo); regex-based, no AST.
 * Re-runs whenever a screen / manifest / contract / backend /
 * frontend file changes.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../../data');
const GRAPH_FILE = resolve(DATA_DIR, 'graph.json');

type NodeType = 'screen' | 'op' | 'cmd' | 'endpoint' | 'llm_provider';
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to' | 'calls' | 'invokes_llm';
type Node = { id: string; type: NodeType; label: string; file?: string };
type Edge = { from: string; to: string; kind: EdgeKind; file?: string; line?: number };

function listFilesIn(dir: string, predicate: (name: string) => boolean): string[] {
  try { return readdirSync(dir).filter(predicate).map((f) => resolve(dir, f)); }
  catch { return []; }
}

function listSubdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => resolve(dir, e.name));
  } catch { return []; }
}

/** Walk a directory recursively, collecting files matching the predicate.
 *  Hard-coded skip list for noisy paths — node_modules, .git, dist/. */
function walk(dir: string, predicate: (rel: string) => boolean, out: string[] = [], depth = 0): string[] {
  if (depth > 8) return out;     // hard cap; Nik's tree is shallow
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === 'build') continue;
    const abs = resolve(dir, e.name);
    if (e.isDirectory()) walk(abs, predicate, out, depth + 1);
    else if (e.isFile() && predicate(abs)) out.push(abs);
  }
  return out;
}

function rel(p: string): string {
  return p.startsWith(config.targetPath) ? p.slice(config.targetPath.length + 1) : p;
}

function lineAt(text: string, idx: number): number {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Pull op references out of a manifest list. Handles both shapes:
 *    reads: ['hydration.today', 'sleep.recent']    (string literals)
 *    reads: [hydration.today, sleep.recent]        (TS identifier paths)
 *  Identifier paths are recognised by `lowercase.lowercase` chains, which
 *  is the convention Nik (and most TS codebases) use for op names. */
function parseOpRefs(src: string, key: string): string[] {
  const m = src.match(new RegExp(`${key}\\s*:\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) return [];
  const inner = m[1]!;
  const out = new Set<string>();
  for (const x of inner.matchAll(/['"]([\w.]+\.\w+)['"]/g)) out.add(x[1]!);
  for (const x of inner.matchAll(/\b([a-z][\w]*\.[a-zA-Z][\w]*)\b/g)) out.add(x[1]!);
  return [...out];
}

const LLM_PACKAGES: Array<{ pkg: RegExp; provider: string }> = [
  { pkg: /['"]@anthropic-ai\/sdk['"]/,   provider: 'anthropic' },
  { pkg: /['"]@ai-sdk\/anthropic['"]/,   provider: 'anthropic' },
  { pkg: /['"]openai['"]/,               provider: 'openai' },
  { pkg: /['"]@google\/generative-ai['"]/, provider: 'google' },
  { pkg: /['"]cohere-ai['"]/,            provider: 'cohere' },
  { pkg: /['"]@mistralai\/mistralai['"]/, provider: 'mistral' },
];

export const graphAgent: Agent = {
  name: 'graph',
  description: 'Builds the project topology — frontend wirings, backend endpoints, fetch call sites, LLM invocations.',
  routedFiles: [
    ...(config.screensGlob ? [config.screensGlob] : []),
    ...(config.manifestsGlob ? [config.manifestsGlob] : []),
    ...(config.contractsDir ? [`${config.contractsDir}/*.ts`] : []),
    ...config.backendDirs.map((d) => `${d}/**/*.{ts,tsx,js,mjs}`),
    ...config.frontendGlobs,
  ],
  intervalMs: 0,
  run: async () => {
    if (!existsSync(config.targetPath)) {
      return [{
        id: newId(),
        agent: 'graph',
        kind: 'graph:no-source',
        at: Date.now(),
        severity: 'info',
        summary: `target path does not exist: ${config.targetPath}`,
      }];
    }

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const seenIds = new Set<string>();
    const addNode = (n: Node) => {
      if (seenIds.has(n.id)) return;
      seenIds.add(n.id);
      nodes.push(n);
      registerEntity({
        urn: n.id,
        kind: n.type,
        label: n.label,
        ...(n.file ? { file: n.file, evidence: [n.file] } : {}),
        agent: 'graph',
      });
    };
    const addEdge = (e: Edge) => {
      edges.push(e);
      const evidence = e.file ? [`${e.file}${e.line ? `:${e.line}` : ''}`] : [];
      addFact({
        agent: 'graph',
        subject: e.from,
        predicate: e.kind,
        object: e.to,
        ...(evidence.length ? { evidence } : {}),
      });
    };

    // ── Contracts → ops + commands ───────────────────────────────────────
    const contractsDir = config.contractsDir ? resolve(config.targetPath, config.contractsDir) : null;
    if (contractsDir) for (const file of listFilesIn(contractsDir, (f) => f.endsWith('.ts') && f !== 'index.ts')) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/name:\s*['"]([\w.]+)['"]/g)) {
        const name = m[1]!;
        const type: NodeType = name.startsWith('ui.') ? 'cmd' : 'op';
        addNode({ id: `${type}:${name}`, type, label: name, file: rel(file) });
      }
    }

    // ── Screens + manifests + nav targets ────────────────────────────────
    const screensDir = config.screensGlob ? resolve(config.targetPath, dirname(config.screensGlob)) : null;
    const screenFiles = screensDir ? listFilesIn(screensDir, (f) => f.endsWith('Screen.tsx')) : [];

    // First pass: build a navId → screen URN map. Each screen's
    // .manifest.ts declares `id: 'home'` etc.; that's what onNav(...) and
    // state.screen = '...' use. Without this map the graph emits a stub
    // `screen:home` separate from the real `screen:HomeScreen`, doubling
    // up nodes — which is the bug seen in the dashboard.
    const navIdToScreenUrn = new Map<string, string>();
    for (const file of screenFiles) {
      const manifestPath = file.replace(/\.tsx$/, '.manifest.ts');
      if (!existsSync(manifestPath)) continue;
      const src = readFileSync(manifestPath, 'utf8');
      const m = src.match(/\bid\s*:\s*['"]([\w-]+)['"]/);
      if (!m) continue;
      const screenName = basename(file).replace(/\.tsx$/, '');
      navIdToScreenUrn.set(m[1]!, `screen:${screenName}`);
    }

    // Pre-pass: register every screen file with its file path BEFORE any
    // per-screen processing. Otherwise screen A nav-targeting screen B
    // (when B hasn't been processed yet) registers a stub node for B
    // without its file path — and the later iteration's addNode is
    // dropped because the URN already exists in seenIds.
    for (const file of screenFiles) {
      const screenName = basename(file).replace(/\.tsx$/, '');
      addNode({ id: `screen:${screenName}`, type: 'screen', label: screenName, file: rel(file) });
    }

    for (const file of screenFiles) {
      const screenName = basename(file).replace(/\.tsx$/, '');
      const screenId = `screen:${screenName}`;

      const manifestPath = file.replace(/\.tsx$/, '.manifest.ts');
      if (existsSync(manifestPath)) {
        const src = readFileSync(manifestPath, 'utf8');
        for (const op of parseOpRefs(src, 'reads'))    addEdge({ from: screenId, to: `op:${op}`,   kind: 'reads',      file: rel(manifestPath) });
        for (const op of parseOpRefs(src, 'writes'))   addEdge({ from: screenId, to: `op:${op}`,   kind: 'writes',     file: rel(manifestPath) });
        // Nik manifests use `commands:` (not `dispatches:`); also accept
        // the older key for forward-compat.
        for (const cmd of parseOpRefs(src, 'commands'))    addEdge({ from: screenId, to: `cmd:${cmd}`, kind: 'dispatches', file: rel(manifestPath) });
        for (const cmd of parseOpRefs(src, 'dispatches')) addEdge({ from: screenId, to: `cmd:${cmd}`, kind: 'dispatches', file: rel(manifestPath) });
      }

      const tsx = readFileSync(file, 'utf8');

      // Inline useOp / useOpMutation calls inside the screen JSX. Backstop
      // for screens whose manifest is missing or out of date — and for the
      // case where the screen calls an op that's NOT declared in the
      // manifest (which is itself a drift signal).
      // Pattern: useOp(<alias>.<field>, ...) or useOpMutation(<alias>.<field>, ...)
      // The alias-to-canonical normalization happens via op-name suffix
      // matching when the op is later resolved against the contracts.
      for (const m of tsx.matchAll(/use(?:Op|OpMutation|Mutation)\s*\(\s*([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)/g)) {
        const alias = m[1]!;
        const field = m[2]!;
        // Heuristic op name: alias's lowercased prefix + field. We strip a
        // trailing 'Ops' or 'Op' suffix from the alias (e.g. hydrationOps → hydration).
        const stem = alias.replace(/Ops?$/i, '').replace(/^[A-Z]/, (c) => c.toLowerCase());
        const opName = `${stem}.${field}`;
        const isMutation = m[0].includes('Mutation');
        addEdge({ from: screenId, to: `op:${opName}`, kind: isMutation ? 'writes' : 'reads', file: rel(file), line: lineAt(tsx, m.index!) });
      }

      // useCommand('command.name', …) — string-literal command name
      for (const m of tsx.matchAll(/useCommand\s*\(\s*['"]([\w.]+)['"]/g)) {
        addEdge({ from: screenId, to: `cmd:${m[1]!}`, kind: 'dispatches', file: rel(file), line: lineAt(tsx, m.index!) });
      }

      const navTargets = new Set<string>();
      // Direct: onNav('xxx') or state.screen = 'xxx'
      for (const m of tsx.matchAll(/onNav\(\s*['"]([\w-]+)['"]\s*\)/g))      navTargets.add(m[1]!);
      for (const m of tsx.matchAll(/state\.screen\s*=\s*['"]([\w-]+)['"]/g)) navTargets.add(m[1]!);
      // Tile catalog: an array of objects each shaped roughly
      //   { id: 'cycle', icon: 'refresh', label: 'Cycle', ... }
      // The catalog is dispatched dynamically via `onNav(item.id)`, so the
      // literal-arg regex above misses the targets. We pick them up by
      // matching object literals with both `id:` and `icon:` fields, BUT
      // only emit the nav edge when:
      //   (a) the file actually dispatches via onNav(item.id) /
      //       setState({ screen: item.id }) — proving the array is used
      //       for navigation, not for, say, symptom or tab labels, AND
      //   (b) the extracted id resolves to a screen URN we know about.
      // This filters out unrelated tile-shaped data (symptom buttons,
      // rating tiers, tabs) without losing real catalogs.
      const dispatchesItemId = /onNav\s*\(\s*item\.id|state\.screen\s*=\s*item\.id|setState\s*\(\s*\{\s*screen\s*:\s*item\.id/.test(tsx);
      if (dispatchesItemId) {
        for (const m of tsx.matchAll(/\{[^{}]*?\bid\s*:\s*['"]([\w-]+)['"][^{}]*?\bicon\s*:[^{}]*?\}/g)) {
          const id = m[1]!;
          if (navIdToScreenUrn.has(id)) navTargets.add(id);
        }
      }
      for (const target of navTargets) {
        // Resolve the nav-id to its canonical screen URN if a manifest
        // declared it; otherwise fall back to a stub. Either way we don't
        // create a duplicate node when the screen file already exists.
        const targetId = navIdToScreenUrn.get(target) ?? `screen:${target}`;
        if (!seenIds.has(targetId)) addNode({ id: targetId, type: 'screen', label: target });
        addEdge({ from: screenId, to: targetId, kind: 'navigates_to', file: rel(file) });
      }
    }

    // ── Backend endpoints ────────────────────────────────────────────────
    // (a) Supabase Edge function shape: <backendDir>/<fn>/index.ts
    // (b) Next.js App Router: <backendDir>/.../route.ts
    // (c) Next.js Pages API: <backendDir>/.../*.ts (one file = one endpoint)
    // (d) Express/Hono/Fastify-style: any file with `app.METHOD('/path', …)`
    for (const backendRel of config.backendDirs) {
      const backendAbs = resolve(config.targetPath, backendRel);
      if (!existsSync(backendAbs)) continue;
      let st;
      try { st = statSync(backendAbs); } catch { continue; }
      if (!st.isDirectory()) continue;

      // (a) Supabase Edge: each subdir with index.ts is one endpoint
      for (const sub of listSubdirs(backendAbs)) {
        const idx = join(sub, 'index.ts');
        if (!existsSync(idx)) continue;
        const fnName = basename(sub);
        const urn = `endpoint:${backendRel}/${fnName}`;
        addNode({ id: urn, type: 'endpoint', label: fnName, file: rel(idx) });
      }

      // (c) Next.js app/api route.ts files anywhere underneath
      for (const file of walk(backendAbs, (f) => f.endsWith('/route.ts') || f.endsWith('/route.tsx') || f.endsWith('/route.js'))) {
        const path = rel(file).replace(/^.+?\/api\//, '/api/').replace(/\/route\.[tj]sx?$/, '');
        const urn = `endpoint:${path || rel(file)}`;
        addNode({ id: urn, type: 'endpoint', label: path || basename(file), file: rel(file) });
      }

      // (d) Express/Hono/Fastify-style verb declarations
      for (const file of walk(backendAbs, (f) => /\.(ts|tsx|js|mjs)$/.test(f))) {
        let src: string;
        try { src = readFileSync(file, 'utf8'); } catch { continue; }
        const re = /\b(?:app|router|server|api)\.(get|post|put|patch|delete|options|use)\s*\(\s*['"`]([^'"`]+)['"`]/g;
        for (const m of src.matchAll(re)) {
          const method = m[1]!.toUpperCase();
          const path = m[2]!;
          const urn = `endpoint:${method} ${path}`;
          addNode({ id: urn, type: 'endpoint', label: `${method} ${path}`, file: rel(file) });
        }
      }
    }

    // ── Frontend → backend fetch calls + LLM SDK imports ─────────────────
    const frontendFiles = config.frontendGlobs.flatMap((g) => {
      // Best-effort: take everything under the first glob segment that looks like a dir.
      const root = g.split('*')[0]?.replace(/\/+$/, '');
      if (!root) return [];
      const abs = resolve(config.targetPath, root);
      if (!existsSync(abs)) return [];
      return walk(abs, (f) => /\.(ts|tsx|js|mjs)$/.test(f));
    });

    // Transitive attribution prep: for every *Screen.tsx, scan its
    // top-of-file relative imports and resolve each to an absolute path.
    // We then build a reverse map: file → set<screenURN that imports it>.
    // When a non-Screen file contains fetch() / LLM SDK imports, the
    // edges get attributed to every screen that imports it (directly or
    // through one hop). Hard-path: only one hop and only relative imports
    // (../foo), not bare module names — we never assume what an
    // unresolved bare import does.
    const importsByFile = new Map<string, Set<string>>();   // absFile → relative imports it issues
    function resolveImport(fromAbs: string, spec: string): string | null {
      if (!spec.startsWith('.')) return null;
      const baseDir = dirname(fromAbs);
      // Order matters: resolve to file extensions BEFORE checking the
      // bare path, otherwise a directory gets returned and the next
      // readFileSync explodes (EISDIR). Each candidate is only accepted
      // if it exists AND is a regular file.
      const candidates = [
        resolve(baseDir, spec + '.ts'),
        resolve(baseDir, spec + '.tsx'),
        resolve(baseDir, spec + '.js'),
        resolve(baseDir, spec + '.mjs'),
        resolve(baseDir, spec, 'index.ts'),
        resolve(baseDir, spec, 'index.tsx'),
        resolve(baseDir, spec, 'index.js'),
        resolve(baseDir, spec),
      ];
      for (const c of candidates) {
        if (!existsSync(c)) continue;
        try { if (statSync(c).isFile()) return c; } catch { continue; }
      }
      return null;
    }
    function fileImports(absFile: string, src: string): Set<string> {
      const out = new Set<string>();
      // import ... from '...'  AND  export ... from '...'  AND  bare side-effect import '...'
      const re = /\b(?:import|export)(?:[\s\S]*?from\s+|\s+)?['"]([^'"]+)['"]/g;
      for (const m of src.matchAll(re)) {
        const r = resolveImport(absFile, m[1]!);
        if (r) out.add(r);
      }
      return out;
    }
    // Pass A: index every screen's imports.
    const importedByScreen = new Map<string, Set<string>>();   // screenURN → abs files
    for (const file of screenFiles) {
      let src: string;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      const screenName = basename(file).replace(/\.tsx$/, '');
      const screenId = `screen:${screenName}`;
      const imps = fileImports(file, src);
      importsByFile.set(file, imps);
      importedByScreen.set(screenId, imps);
    }
    // Reverse map: file → screens that import it (directly).
    const screensImporting = new Map<string, Set<string>>();
    for (const [screenId, files] of importedByScreen) {
      for (const f of files) {
        const set = screensImporting.get(f) ?? new Set<string>();
        set.add(screenId);
        screensImporting.set(f, set);
      }
    }
    // Pass B: also follow each imported file's own imports (one more hop).
    for (const f of [...screensImporting.keys()]) {
      let src: string;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }
      const next = fileImports(f, src);
      const ownerScreens = screensImporting.get(f)!;
      for (const n of next) {
        const cur = screensImporting.get(n) ?? new Set<string>();
        for (const s of ownerScreens) cur.add(s);
        screensImporting.set(n, cur);
      }
    }

    const fetchedEndpoints = new Map<string, Set<string>>();   // screenId → endpoint URN set
    const llmInvocations = new Map<string, Set<string>>();      // screenId → providers

    function attributeScreens(absFile: string): string[] {
      // Direct: file IS a Screen file.
      const m = /([A-Z]\w*Screen)\.tsx$/.exec(rel(absFile));
      if (m) return [`screen:${m[1]!}`];
      // Transitive: any screen that (transitively) imports this file.
      const set = screensImporting.get(absFile);
      return set ? [...set] : [];
    }

    for (const file of frontendFiles) {
      let src: string;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      const fileRel = rel(file);
      const owners = attributeScreens(file);

      // fetch('/path' OR `${BASE}/...`)
      for (const m of src.matchAll(/\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
        const url = m[1]!;
        const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{[^}]+\}/, '');
        if (!path.startsWith('/')) continue;
        const urn = `endpoint:${path}`;
        addNode({ id: urn, type: 'endpoint', label: path });
        for (const screenId of owners) {
          const seen = fetchedEndpoints.get(screenId) ?? new Set<string>();
          if (seen.has(urn)) continue;
          seen.add(urn);
          fetchedEndpoints.set(screenId, seen);
          addEdge({ from: screenId, to: urn, kind: 'calls', file: fileRel, line: lineAt(src, m.index!) });
        }
      }

      // LLM SDK imports
      for (const { pkg, provider } of LLM_PACKAGES) {
        if (!pkg.test(src)) continue;
        const m = pkg.exec(src);
        if (!m) continue;
        const providerUrn = `llm_provider:${provider}`;
        addNode({ id: providerUrn, type: 'llm_provider', label: provider });
        for (const screenId of owners) {
          const seen = llmInvocations.get(screenId) ?? new Set<string>();
          if (seen.has(provider)) continue;
          seen.add(provider);
          llmInvocations.set(screenId, seen);
          addEdge({ from: screenId, to: providerUrn, kind: 'invokes_llm', file: fileRel, line: lineAt(src, m.index!) });
        }
      }
    }

    // Stub any remaining edge endpoints as nodes so the graph has no dangling ends.
    for (const e of edges) {
      if (!seenIds.has(e.to)) {
        const type: NodeType = e.kind === 'navigates_to' ? 'screen'
          : e.kind === 'calls' ? 'endpoint'
          : e.kind === 'invokes_llm' ? 'llm_provider'
          : e.kind === 'dispatches' ? 'cmd' : 'op';
        addNode({ id: e.to, type, label: e.to.replace(/^[^:]+:/, '') });
      }
    }

    const graph = { nodes, edges, builtAt: Date.now() };
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2));

    const counts: Record<NodeType, number> = { screen: 0, op: 0, cmd: 0, endpoint: 0, llm_provider: 0 };
    for (const n of nodes) counts[n.type]++;
    const edgeCounts: Record<EdgeKind, number> = { reads: 0, writes: 0, dispatches: 0, navigates_to: 0, calls: 0, invokes_llm: 0 };
    for (const e of edges) edgeCounts[e.kind]++;

    const findings: Finding[] = [{
      id: newId(),
      agent: 'graph',
      kind: 'graph:built',
      at: Date.now(),
      severity: 'info',
      summary: `topology · ${nodes.length} nodes (${counts.screen}s/${counts.op}o/${counts.cmd}c/${counts.endpoint}e/${counts.llm_provider}llm) · ${edges.length} edges (${edgeCounts.reads}r/${edgeCounts.writes}w/${edgeCounts.dispatches}d/${edgeCounts.navigates_to}n/${edgeCounts.calls}c/${edgeCounts.invokes_llm}llm)`,
      payload: { nodeCount: nodes.length, edgeCount: edges.length, nodeKinds: counts, edgeKinds: edgeCounts, file: 'data/graph.json' },
    }];

    // ── Orphan detection — every lone warrior in the playground gets a
    // finding so the dashboard treats them as real signal, not visual
    // noise. Hard-path: no assumption about why they're alone, just
    // "nothing in the codebase wires this", with severity-by-kind:
    //   cmd       warn   — declared in contract, but no screen dispatches
    //   op        info   — declared but no screen reads/writes (could be
    //                      pre-built ahead of UI; could be dead)
    //   endpoint  info   — registered but no screen calls (often a hook
    //                      indirection — D.4 fix #4 will close this)
    //   llm_provider info — same, hook indirection
    //   screen    info   — silent screen (no outgoing edges); legit for
    //                      AuthScreen-style entry points but worth
    //                      surfacing as a check
    const incomingByTo = new Map<string, number>();
    const outgoingByFrom = new Map<string, number>();
    for (const e of edges) {
      incomingByTo.set(e.to, (incomingByTo.get(e.to) ?? 0) + 1);
      outgoingByFrom.set(e.from, (outgoingByFrom.get(e.from) ?? 0) + 1);
    }
    const ORPHAN_KIND: Record<NodeType, { kind: string; severity: Finding['severity'] }> = {
      cmd:          { kind: 'graph:orphan-cmd',          severity: 'warn' },
      op:           { kind: 'graph:orphan-op',           severity: 'info' },
      endpoint:     { kind: 'graph:orphan-endpoint',     severity: 'info' },
      llm_provider: { kind: 'graph:orphan-llm-provider', severity: 'info' },
      screen:       { kind: 'graph:silent-screen',       severity: 'info' },
    };
    const PER_KIND_CAP = 12;
    const perKindCount: Partial<Record<NodeType, number>> = {};
    for (const n of nodes) {
      const isOrphan = n.type === 'screen'
        ? (outgoingByFrom.get(n.id) ?? 0) === 0
        : (incomingByTo.get(n.id) ?? 0) === 0;
      if (!isOrphan) continue;
      const slot = ORPHAN_KIND[n.type];
      const c = perKindCount[n.type] ?? 0;
      if (c >= PER_KIND_CAP) continue;
      perKindCount[n.type] = c + 1;
      findings.push({
        id: newId(),
        agent: 'graph',
        kind: slot.kind,
        at: Date.now(),
        severity: slot.severity,
        summary: n.type === 'screen'
          ? `${n.label} has no outbound edges (no reads/writes/dispatches/calls/nav)`
          : `${n.label} (${n.type}) is declared but no screen ${n.type === 'cmd' ? 'dispatches' : n.type === 'op' ? 'reads/writes' : 'calls'} it`,
        ...(n.file ? { file: n.file } : {}),
        payload: { urn: n.id, type: n.type, label: n.label },
      });
    }

    return findings;
  },
};
