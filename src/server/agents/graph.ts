/* Graph agent — deterministic.
 *
 * Walks the Nik project tree and assembles a topology graph:
 *   screens ──reads──▶ ops
 *   screens ──writes─▶ ops
 *   screens ─dispatches▶ commands
 *   screens ─nav▶ screens
 *
 * Output is written to data/graph.json (served via /api/graph) and
 * a single `graph:built` finding is emitted with node + edge counts.
 *
 * Cheap (~30ms typical); regex-based, no AST. Re-runs on any
 * screen / manifest / contract change.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NIK_PATH } from '../claude.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../../data');
const GRAPH_FILE = resolve(DATA_DIR, 'graph.json');

type NodeType = 'screen' | 'op' | 'cmd';
type EdgeKind = 'reads' | 'writes' | 'dispatches' | 'navigates_to';
type Node = { id: string; type: NodeType; label: string; file?: string };
type Edge = { from: string; to: string; kind: EdgeKind };

const SCREENS_DIR = resolve(NIK_PATH, 'web/src/screens');
const CONTRACTS_DIR = resolve(NIK_PATH, 'web/src/contracts');

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  try { return readdirSync(dir).filter(predicate).map((f) => resolve(dir, f)); }
  catch { return []; }
}

function rel(p: string): string {
  return p.startsWith(NIK_PATH) ? p.slice(NIK_PATH.length + 1) : p;
}

function parseStringList(src: string, key: string): string[] {
  // Matches `key: [ ... ]` and pulls each quoted ident out.
  const m = src.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`, 's'));
  if (!m) return [];
  return [...m[1]!.matchAll(/['"]([\w.]+)['"]/g)].map((x) => x[1]!);
}

export const graphAgent: Agent = {
  name: 'graph',
  description: 'Builds the project topology JSON (screens → ops → commands → navigation) for the graph panel.',
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/screens/*.manifest.ts',
    'web/src/contracts/*.ts',
  ],
  intervalMs: 0,
  run: async () => {
    if (!existsSync(NIK_PATH)) {
      return [{
        id: newId(),
        agent: 'graph',
        kind: 'graph:no-source',
        at: Date.now(),
        severity: 'info',
        summary: `target path does not exist: ${NIK_PATH}`,
      }];
    }

    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const seenIds = new Set<string>();
    const addNode = (n: Node) => { if (!seenIds.has(n.id)) { seenIds.add(n.id); nodes.push(n); } };

    // Contracts → ops + commands
    for (const file of listFiles(CONTRACTS_DIR, (f) => f.endsWith('.ts') && f !== 'index.ts')) {
      const src = readFileSync(file, 'utf8');
      const re = /name:\s*['"]([\w.]+)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const name = m[1]!;
        const type: NodeType = name.startsWith('ui.') ? 'cmd' : 'op';
        addNode({ id: name, type, label: name, file: rel(file) });
      }
    }

    // Screens + their manifests + nav usage
    const screenFiles = listFiles(SCREENS_DIR, (f) => f.endsWith('Screen.tsx'));
    for (const file of screenFiles) {
      const screenName = basename(file).replace(/\.tsx$/, '');
      const screenId = `screen:${screenName}`;
      addNode({ id: screenId, type: 'screen', label: screenName, file: rel(file) });

      const manifestPath = file.replace(/\.tsx$/, '.manifest.ts');
      if (existsSync(manifestPath)) {
        const src = readFileSync(manifestPath, 'utf8');
        for (const op of parseStringList(src, 'reads'))       edges.push({ from: screenId, to: op, kind: 'reads' });
        for (const op of parseStringList(src, 'writes'))      edges.push({ from: screenId, to: op, kind: 'writes' });
        for (const cmd of parseStringList(src, 'dispatches')) edges.push({ from: screenId, to: cmd, kind: 'dispatches' });
      }

      // Navigation calls: onNav('xxx') and state.screen = 'xxx'
      const tsx = readFileSync(file, 'utf8');
      const navTargets = new Set<string>();
      for (const m of tsx.matchAll(/onNav\(\s*['"]([\w-]+)['"]\s*\)/g))         navTargets.add(m[1]!);
      for (const m of tsx.matchAll(/state\.screen\s*=\s*['"]([\w-]+)['"]/g))    navTargets.add(m[1]!);
      for (const target of navTargets) {
        const targetId = `screen:${target}`;
        addNode({ id: targetId, type: 'screen', label: target });
        edges.push({ from: screenId, to: targetId, kind: 'navigates_to' });
      }
    }

    // Nodes referenced by edges that we never registered (orphan ops/cmds the
    // contracts didn't declare): add as stubs so the graph has no dangling
    // edge endpoints.
    for (const e of edges) {
      if (!seenIds.has(e.to)) {
        const type: NodeType = e.kind === 'navigates_to' ? 'screen'
          : e.kind === 'dispatches' ? 'cmd' : 'op';
        addNode({ id: e.to, type, label: e.to });
      }
    }

    const graph = { nodes, edges, builtAt: Date.now() };
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(GRAPH_FILE, JSON.stringify(graph, null, 2));

    const screens = nodes.filter((n) => n.type === 'screen').length;
    const ops = nodes.filter((n) => n.type === 'op').length;
    const cmds = nodes.filter((n) => n.type === 'cmd').length;

    const finding: Finding = {
      id: newId(),
      agent: 'graph',
      kind: 'graph:built',
      at: Date.now(),
      severity: 'info',
      summary: `topology · ${nodes.length} nodes (${screens} screens, ${ops} ops, ${cmds} cmds) · ${edges.length} edges`,
      payload: { nodeCount: nodes.length, edgeCount: edges.length, screens, ops, cmds, file: 'data/graph.json' },
    };
    return [finding];
  },
};
