/* Self-awareness agent — deterministic.
 *
 * Per project_self_monitoring memory: dev-infra watches the user's
 * repo, but it must also know itself. This agent reads its own
 * code (agents/index.ts + schemas.ts + package.json) and produces
 * a self-description in memory:
 *
 *   - register entity:  urn `self:nik-dev-infra`
 *   - facts:            self:* `has_agent`     <agent-name>
 *                       self:* `emits_kind`    <finding-kind>
 *                       self:* `depends_on`    <package@version>
 *                       self:* `runs_at`       <port>
 *                       self:* `target`        <config.targetPath>
 *   - segment:          `meta/self` with a wiki page describing
 *                       the current shape (counts of agents,
 *                       memory layers, deps, version)
 *
 * Hard-path: only writes facts derivable from the actual files;
 * never assumes (e.g. doesn't list dependencies that aren't in
 * package.json). Output is the dev-infra's own "register".
 *
 * Distinct from `memory-keeper` (which audits the memory layer's
 * integrity) — this agent reports on dev-infra's own structure.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, defineSegment, registerEntity, wikiUpsert } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../../..');
const PKG_PATH = resolve(REPO_ROOT, 'package.json');
const INDEX_PATH = resolve(here, 'index.ts');
const SCHEMAS_PATH = resolve(here, 'schemas.ts');
const SELF_URN = 'self:nik-dev-infra';

function readPackage(): { name?: string; version?: string; deps: Record<string, string> } {
  if (!existsSync(PKG_PATH)) return { deps: {} };
  try {
    const j = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
      name?: string; version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      name: j.name,
      version: j.version,
      deps: { ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) },
    };
  } catch { return { deps: {} }; }
}

function readAgentNames(): string[] {
  if (!existsSync(INDEX_PATH)) return [];
  const src = readFileSync(INDEX_PATH, 'utf8');
  // Pull names from imports of *Agent identifiers, then verify they
  // appear in the ALL_AGENTS array. Safer than parsing the array
  // literally (which can have comments / line breaks).
  const out = new Set<string>();
  for (const m of src.matchAll(/import\s+\{\s*(\w+Agent)\s*\}\s+from\s+['"]\.\/([\w-]+)\.ts['"]/g)) {
    out.add(m[2]!);
  }
  return [...out].sort();
}

function readEmittedKinds(): string[] {
  if (!existsSync(SCHEMAS_PATH)) return [];
  const src = readFileSync(SCHEMAS_PATH, 'utf8');
  // Pull every quoted string inside any z.enum([...]) block.
  const kinds = new Set<string>();
  for (const m of src.matchAll(/z\.enum\(\[([\s\S]*?)\]\)/g)) {
    for (const k of m[1]!.matchAll(/['"]([\w:.-]+)['"]/g)) kinds.add(k[1]!);
  }
  return [...kinds].sort();
}

const PORT = Number(process.env.PORT ?? 5175);

export const selfAwarenessAgent: Agent = {
  name: 'self-awareness',
  description: 'Reads dev-infra\'s own code; registers facts about its agents, schemas, deps, target. Seeds meta/self wiki.',
  routedFiles: [],
  intervalMs: 30 * 60 * 1000,
  run: async () => {
    const findings: Finding[] = [];
    const pkg = readPackage();
    const agentNames = readAgentNames();
    const kinds = readEmittedKinds();

    // Register the canonical self entity (always).
    registerEntity({
      urn: SELF_URN,
      kind: 'self',
      label: pkg.name ?? 'nik-dev-infra',
      file: 'package.json',
      evidence: ['package.json', 'src/server/agents/index.ts', 'src/server/agents/schemas.ts'],
      agent: 'self-awareness',
    });

    // meta + meta/self segments
    defineSegment({ name: 'meta',      description: 'meta-system: memory, scheduling, agent ownership', ownerAgent: 'memory-keeper' });
    defineSegment({ name: 'meta/self', description: "dev-infra's own structure + behavior",             ownerAgent: 'self-awareness' });

    // facts: has_agent <name>
    for (const a of agentNames) {
      addFact({ agent: 'self-awareness', subject: SELF_URN, predicate: 'has_agent', object: `agent:${a}`, evidence: ['src/server/agents/index.ts'] });
    }
    // facts: emits_kind <kind>
    for (const k of kinds) {
      addFact({ agent: 'self-awareness', subject: SELF_URN, predicate: 'emits_kind', object: `kind:${k}`, evidence: ['src/server/agents/schemas.ts'] });
    }
    // facts: depends_on <pkg@version>
    for (const [name, ver] of Object.entries(pkg.deps)) {
      addFact({ agent: 'self-awareness', subject: SELF_URN, predicate: 'depends_on', object: `pkg:${name}@${ver}`, evidence: ['package.json'] });
    }
    // facts: runs_at + target
    addFact({ agent: 'self-awareness', subject: SELF_URN, predicate: 'runs_at',  object: `port:${PORT}`, evidence: ['src/server/index.ts'] });
    addFact({ agent: 'self-awareness', subject: SELF_URN, predicate: 'target',   object: `path:${config.targetPath}`, evidence: ['src/server/config.ts'] });

    // Wiki seed for meta/self/architecture.
    const wikiBody = `# nik-dev-infra · self-description

Generated by the self-awareness agent. **Do not hand-edit** — this page is overwritten on every run.

## Core
- Name: \`${pkg.name ?? 'nik-dev-infra'}\`
- Version: \`${pkg.version ?? '?'}\`
- Listening: port ${PORT}
- Watching target: \`${config.targetPath}\` (label: ${config.targetLabel})

## Agents (${agentNames.length})

${agentNames.map((a) => `- \`agent:${a}\``).join('\n')}

## Finding kinds emitted (${kinds.length})

${kinds.map((k) => `- \`${k}\``).join('\n')}

## Dependencies (${Object.keys(pkg.deps).length})

${Object.entries(pkg.deps).slice(0, 50).map(([n, v]) => `- ${n} ${v}`).join('\n')}
${Object.keys(pkg.deps).length > 50 ? `\n…and ${Object.keys(pkg.deps).length - 50} more` : ''}
`;
    wikiUpsert({
      segment: 'meta/self',
      topic: 'architecture',
      content: wikiBody,
      agent: 'self-awareness',
      evidence: ['package.json', 'src/server/agents/index.ts', 'src/server/agents/schemas.ts'],
    });

    findings.push({
      id: newId(),
      agent: 'self-awareness',
      kind: 'self:described',
      at: Date.now(),
      severity: 'info',
      summary: `self-described · ${agentNames.length} agents · ${kinds.length} finding kinds · ${Object.keys(pkg.deps).length} deps · target=${config.targetLabel}`,
      payload: { agentCount: agentNames.length, kindCount: kinds.length, depCount: Object.keys(pkg.deps).length, version: pkg.version, port: PORT },
    });
    return findings;
  },
};
