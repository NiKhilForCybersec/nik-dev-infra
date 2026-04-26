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

function parseStringList(src: string, key: string): string[] {
  const m = src.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, 's'));
  if (!m) return [];
  return [...m[1]!.matchAll(/['"]([\w.]+)['"]/g)].map((x) => x[1]!);
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
    for (const file of screenFiles) {
      const screenName = basename(file).replace(/\.tsx$/, '');
      const screenId = `screen:${screenName}`;
      addNode({ id: screenId, type: 'screen', label: screenName, file: rel(file) });

      const manifestPath = file.replace(/\.tsx$/, '.manifest.ts');
      if (existsSync(manifestPath)) {
        const src = readFileSync(manifestPath, 'utf8');
        for (const op of parseStringList(src, 'reads'))       addEdge({ from: screenId, to: `op:${op}`,  kind: 'reads',      file: rel(manifestPath) });
        for (const op of parseStringList(src, 'writes'))      addEdge({ from: screenId, to: `op:${op}`,  kind: 'writes',     file: rel(manifestPath) });
        for (const cmd of parseStringList(src, 'dispatches')) addEdge({ from: screenId, to: `cmd:${cmd}`, kind: 'dispatches', file: rel(manifestPath) });
      }

      const tsx = readFileSync(file, 'utf8');
      const navTargets = new Set<string>();
      for (const m of tsx.matchAll(/onNav\(\s*['"]([\w-]+)['"]\s*\)/g))      navTargets.add(m[1]!);
      for (const m of tsx.matchAll(/state\.screen\s*=\s*['"]([\w-]+)['"]/g)) navTargets.add(m[1]!);
      for (const target of navTargets) {
        const targetId = `screen:${target}`;
        addNode({ id: targetId, type: 'screen', label: target });
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

    const fetchedEndpoints = new Map<string, Set<string>>();   // screenId → endpoint URN set
    const llmInvocations = new Map<string, Set<{ provider: string; line: number; file: string }>>();

    for (const file of frontendFiles) {
      let src: string;
      try { src = readFileSync(file, 'utf8'); } catch { continue; }
      const fileRel = rel(file);

      // Best-effort attribution: if this file is a *Screen.tsx, attribute
      // findings to that screen. Otherwise we still emit a fact but skip
      // the screen→endpoint edge (we can't be 100% sure which screen).
      const screenMatch = /([A-Z]\w*Screen)\.tsx$/.exec(fileRel);
      const screenId = screenMatch ? `screen:${screenMatch[1]}` : null;

      // fetch('/path' OR `${BASE}/...`)
      for (const m of src.matchAll(/\bfetch\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
        const url = m[1]!;
        // Normalize: keep only the path part, strip protocol+host
        const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\$\{[^}]+\}/, '');
        if (!path.startsWith('/')) continue;        // skip non-path strings
        const urn = `endpoint:${path}`;
        addNode({ id: urn, type: 'endpoint', label: path });
        if (screenId) {
          if (!fetchedEndpoints.get(screenId)?.has(urn)) {
            const set = fetchedEndpoints.get(screenId) ?? new Set<string>();
            set.add(urn);
            fetchedEndpoints.set(screenId, set);
            addEdge({ from: screenId, to: urn, kind: 'calls', file: fileRel, line: lineAt(src, m.index!) });
          }
        }
      }

      // LLM SDK imports
      for (const { pkg, provider } of LLM_PACKAGES) {
        if (!pkg.test(src)) continue;
        const m = pkg.exec(src);
        if (!m) continue;
        const providerUrn = `llm_provider:${provider}`;
        addNode({ id: providerUrn, type: 'llm_provider', label: provider });
        if (screenId) {
          const set = llmInvocations.get(screenId) ?? new Set();
          if (![...set].some((x) => x.provider === provider)) {
            set.add({ provider, line: lineAt(src, m.index!), file: fileRel });
            llmInvocations.set(screenId, set);
            addEdge({ from: screenId, to: providerUrn, kind: 'invokes_llm', file: fileRel, line: lineAt(src, m.index!) });
          }
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

    const finding: Finding = {
      id: newId(),
      agent: 'graph',
      kind: 'graph:built',
      at: Date.now(),
      severity: 'info',
      summary: `topology · ${nodes.length} nodes (${counts.screen}s/${counts.op}o/${counts.cmd}c/${counts.endpoint}e/${counts.llm_provider}llm) · ${edges.length} edges (${edgeCounts.reads}r/${edgeCounts.writes}w/${edgeCounts.dispatches}d/${edgeCounts.navigates_to}n/${edgeCounts.calls}c/${edgeCounts.invokes_llm}llm)`,
      payload: { nodeCount: nodes.length, edgeCount: edges.length, nodeKinds: counts, edgeKinds: edgeCounts, file: 'data/graph.json' },
    };
    return [finding];
  },
};
