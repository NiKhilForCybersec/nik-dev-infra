/* Knowledge-graph grounding helpers — shared by every LLM agent that
 * benefits from richer context than "read this file cold."
 *
 * Two builders:
 *   buildFileGrounding(path)    — for agents targeting one file
 *                                  (auto-fix-driver). Pulls the file's
 *                                  intent + exports + imports +
 *                                  dependents.
 *   buildProjectGrounding()     — for agents that scan the whole repo
 *                                  (drift, navigation, hardcoded).
 *                                  Pulls totals + the top modules with
 *                                  extracted intent so the LLM has
 *                                  semantic context across the codebase.
 *
 * Hard-path framing (the section header in both builders):
 *   STRUCTURE is authoritative — exact AST extractions from
 *   codebase-graph.
 *   INTENT is suggestive — LLM-summarized; the agent must verify
 *   against the file before quoting.
 *
 * When the knowledge graph is empty (cold-start repos) both builders
 * return empty strings — agents degrade gracefully to their old
 * behavior.
 */

import { query } from './memory.ts';

type IntentRecord = { shape?: string; purpose?: string; usedBy?: string; dependsOn?: string; fragileWhen?: string; deferred?: string };

function parseIntent(raw: string | null): IntentRecord | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as IntentRecord; } catch { return null; }
}

// ─── per-file grounding ─────────────────────────────────────────────────

export type FileGrounding = {
  intentBlock: string | null;
  importsBlock: string | null;
  exportsBlock: string | null;
  dependentsBlock: string | null;
  /** True when at least one block has content. Use for `if (g.populated)` checks. */
  populated: boolean;
};

export function buildFileGrounding(fileRef: string | undefined): FileGrounding {
  const empty: FileGrounding = { intentBlock: null, importsBlock: null, exportsBlock: null, dependentsBlock: null, populated: false };
  if (!fileRef) return empty;
  const moduleUrn = `module:${fileRef}`;

  let intentBlock: string | null = null;
  try {
    const row = query<{ intent_summary: string | null }>(
      `SELECT intent_summary FROM code_files WHERE path = ?`,
      [fileRef],
    )[0];
    const j = parseIntent(row?.intent_summary ?? null);
    if (j) {
      if (j.shape === 'A' && j.purpose) {
        intentBlock = `**Purpose:** ${j.purpose}\n**Used by:** ${j.usedBy ?? '(unknown)'}\n**Depends on:** ${j.dependsOn ?? '(unknown)'}\n**Fragile when:** ${j.fragileWhen ?? '(unknown)'}`;
      } else if (j.shape === 'B' && j.deferred) {
        intentBlock = `_(intent extraction deferred: ${j.deferred})_`;
      }
    }
  } catch { /* */ }

  const importsRows = query<{ object: string; predicate: string }>(
    `SELECT object, predicate FROM facts
       WHERE agent = 'codebase-graph' AND subject = ?
         AND predicate IN ('imports', 'imports_dynamic', 'depends_on')
       ORDER BY predicate, object LIMIT 30`,
    [moduleUrn],
  );
  const internal = importsRows.filter((r) => r.predicate.startsWith('imports'));
  const external = importsRows.filter((r) => r.predicate === 'depends_on');
  const importsBlock = (internal.length || external.length)
    ? [
        internal.length ? `Internal modules (${internal.length}):\n${internal.slice(0, 12).map((r) => `  - ${r.object.replace(/^module:/, '')}`).join('\n')}` : null,
        external.length ? `External packages (${external.length}):\n${external.slice(0, 12).map((r) => `  - ${r.object.replace(/^package:/, '')}`).join('\n')}` : null,
      ].filter(Boolean).join('\n')
    : null;

  const expRows = query<{ urn: string; kind: string; label: string }>(
    `SELECT urn, kind, label FROM register
       WHERE agent = 'codebase-graph' AND file = ? AND kind IN ('function', 'class')
       ORDER BY kind, label LIMIT 30`,
    [fileRef],
  );
  const exportsBlock = expRows.length
    ? `Exports (${expRows.length}):\n${expRows.slice(0, 20).map((r) => `  - ${r.kind} ${r.label}`).join('\n')}`
    : null;

  const dependentsRows = query<{ subject: string }>(
    `SELECT DISTINCT subject FROM facts
       WHERE agent = 'codebase-graph'
         AND predicate IN ('imports', 'imports_dynamic')
         AND object = ?
       ORDER BY subject LIMIT 20`,
    [moduleUrn],
  );
  const dependentsBlock = dependentsRows.length
    ? `Dependents — modules that import this file (${dependentsRows.length}):\n${dependentsRows.slice(0, 12).map((r) => `  - ${r.subject.replace(/^module:/, '')}`).join('\n')}`
    : null;

  return {
    intentBlock,
    importsBlock,
    exportsBlock,
    dependentsBlock,
    populated: !!(intentBlock || importsBlock || exportsBlock || dependentsBlock),
  };
}

/** Render a FileGrounding as a complete markdown section (header +
 *  hard-path framing + blocks). Returns '' when nothing's populated. */
export function renderFileGrounding(g: FileGrounding): string {
  if (!g.populated) return '';
  const blocks = [
    g.intentBlock && `## What this file is (per dev-infra knowledge graph)\n\n${g.intentBlock}`,
    g.exportsBlock && `## API surface\n\n${g.exportsBlock}`,
    g.importsBlock && `## What this file uses\n\n${g.importsBlock}`,
    g.dependentsBlock && `## Blast radius — who imports this file\n\n${g.dependentsBlock}`,
  ].filter(Boolean);
  return `\n# Pre-loaded context (don't re-derive — verify before relying)\n\n${blocks.join('\n\n')}\n\nThis context comes from dev-infra's codebase-graph + intent-extractor agents. It's authoritative for STRUCTURE (the imports + exports are exact AST extractions) but only suggestive for INTENT (LLM summary; verify against the file before quoting it as fact). Use it to plan your work; still read the actual files.\n`;
}

// ─── project-wide grounding ─────────────────────────────────────────────

export type ProjectGrounding = {
  totals: { modules: number; functions: number; classes: number; packages: number; intents: number };
  topIntents: { path: string; purpose: string }[];
  topPackages: { name: string; useCount: number }[];
  populated: boolean;
};

export function buildProjectGrounding(): ProjectGrounding {
  const totals = {
    modules: query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE agent = 'codebase-graph' AND kind = 'module'`)[0]?.n ?? 0,
    functions: query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE agent = 'codebase-graph' AND kind = 'function'`)[0]?.n ?? 0,
    classes: query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE agent = 'codebase-graph' AND kind = 'class'`)[0]?.n ?? 0,
    packages: query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE agent = 'codebase-graph' AND kind = 'package'`)[0]?.n ?? 0,
    intents: query<{ n: number }>(`SELECT COUNT(*) AS n FROM code_files WHERE intent_summary IS NOT NULL`)[0]?.n ?? 0,
  };

  // Top modules with intent — order by export count desc so the most
  // structurally-important files lead the list.
  const intentRows = query<{ path: string; intent_summary: string | null; export_count: number }>(`
    SELECT cf.path, cf.intent_summary,
      (SELECT COUNT(*) FROM register r
        WHERE r.agent = 'codebase-graph' AND r.kind IN ('function','class') AND r.file = cf.path) AS export_count
    FROM code_files cf
    WHERE cf.intent_summary IS NOT NULL
    ORDER BY export_count DESC, cf.intent_at DESC
    LIMIT 15
  `);
  const topIntents: { path: string; purpose: string }[] = [];
  for (const r of intentRows) {
    const j = parseIntent(r.intent_summary);
    if (j?.shape === 'A' && j.purpose) topIntents.push({ path: r.path, purpose: j.purpose });
  }

  // Top external packages — by use count, so the LLM knows the stack.
  const pkgRows = query<{ name: string; use_count: number }>(`
    SELECT r.label AS name, (SELECT COUNT(*) FROM facts f WHERE f.agent='codebase-graph' AND f.predicate='depends_on' AND f.object = r.urn) AS use_count
    FROM register r
    WHERE r.agent = 'codebase-graph' AND r.kind = 'package'
    ORDER BY use_count DESC
    LIMIT 12
  `);
  const topPackages = pkgRows.map((r) => ({ name: r.name, useCount: r.use_count ?? 0 }));

  return {
    totals,
    topIntents,
    topPackages,
    populated: totals.modules > 0,
  };
}

export function renderProjectGrounding(g: ProjectGrounding): string {
  if (!g.populated) return '';
  const intentLines = g.topIntents.length
    ? g.topIntents.map((i) => `  - **${i.path}** — ${i.purpose}`).join('\n')
    : '  _(intent-extractor still warming up — purposes will populate over the next hours)_';
  const pkgLines = g.topPackages.length
    ? g.topPackages.map((p) => `  - ${p.name}${p.useCount > 1 ? ` (×${p.useCount})` : ''}`).join('\n')
    : '  _(no external packages registered yet)_';
  return `\n# Project context (from dev-infra knowledge graph)

**Codebase scale:** ${g.totals.modules} modules · ${g.totals.functions} exported functions · ${g.totals.classes} classes · ${g.totals.packages} external packages · ${g.totals.intents} modules with extracted intent.

**Most-important modules with extracted purpose** (${g.topIntents.length} of ${g.totals.intents}):
${intentLines}

**External packages in use** (top ${g.topPackages.length} by import count):
${pkgLines}

This context is authoritative for STRUCTURE (counts + paths are exact AST extractions) and suggestive for INTENT (LLM-summarized purposes; verify by reading the file before quoting). Use it to orient yourself before diving into specifics.
`;
}
