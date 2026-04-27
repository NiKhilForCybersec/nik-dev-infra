/* memory.code.* — coding-focused MCP tools.
 *
 * These are the high-leverage tools for a Claude Code session
 * editing the project: instead of grepping cold, the session calls
 * memory.code.compile_context(file) and gets the file's intent +
 * exports + imports + dependents + recent findings in one shot.
 *
 * Same data the auto-fix-driver and grounding.ts already use
 * internally — now exposed via MCP so any client can grab it.
 */

import { config } from '../../config.ts';
import { buildFileGrounding, buildProjectGrounding, renderFileGrounding, renderProjectGrounding } from '../../grounding.ts';
import { query } from '../../memory.ts';

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

export const codeTools: ToolDef[] = [
  {
    name: 'memory.code.compile_context',
    description: 'Returns the full grounding packet for a file: intent (purpose / used-by / depends-on / fragile-when), API surface (exports), what the file imports (internal modules + external packages), and the blast radius (modules that import this file). Same data used internally by auto-fix-driver. Use this BEFORE any non-trivial edit to ground the change in real understanding.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Repo-relative path, e.g. web/src/screens/HomeScreen.tsx' },
      },
      required: ['file'],
    },
  },
  {
    name: 'memory.code.intent',
    description: "Returns just the LLM-extracted intent summary for a file (purpose / used-by / depends-on / fragile-when). Empty when the intent-extractor hasn't run on this file yet.",
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'memory.code.dependents',
    description: 'Returns modules in the user repo that import the given file (the blast radius of edits). Uses the codebase-graph Tree-sitter extraction.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'memory.code.imports',
    description: 'Returns the modules + external packages this file imports. Uses the codebase-graph Tree-sitter extraction.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'memory.code.findings',
    description: 'Returns recent dev-infra findings touching a file or matching a kind. Filters by file (substring match), kind (substring match), severity, and time window in hours. All filters optional; leaving everything blank returns the most recent findings across the project.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional file path substring filter' },
        kind: { type: 'string', description: 'Optional finding-kind substring (e.g. "drift" / "secrets:")' },
        severity: { type: 'string', description: 'Optional: info / warn / error' },
        hours: { type: 'number', description: 'Optional: only findings from last N hours' },
        limit: { type: 'number', description: 'Default 20, max 100' },
      },
    },
  },
  {
    name: 'memory.code.coverage_gaps',
    description: 'Returns exports without test coverage (per the test-coverage agent). Useful to find regression risk before shipping a change.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Optional: only gaps in this file' },
        limit: { type: 'number', description: 'Default 20' },
      },
    },
  },
  {
    name: 'memory.code.concerns',
    description: 'Returns the active concerns (curator output + ingester rows). Filterable by query substring + severity.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring filter on summary' },
        severity: { type: 'string', description: 'Optional: info / warn / error' },
        limit: { type: 'number', description: 'Default 30' },
      },
    },
  },
  {
    name: 'memory.code.project_context',
    description: 'Returns the project-wide grounding packet: codebase scale, top modules with extracted intent, top external packages by import count. Use this when starting a new conversation to orient on the codebase.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type Json = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

function reqString(args: Json, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`missing required arg: ${key}`);
  return v;
}

export async function callCodeTool(name: string, args: Json): Promise<ToolResult> {
  switch (name) {
    case 'memory.code.compile_context': {
      const file = reqString(args, 'file');
      const g = buildFileGrounding(file);
      if (!g.populated) {
        return ok(`No knowledge-graph data for ${file} yet. The codebase-graph + intent-extractor agents may not have parsed this file. Try memory.code.findings to see if any agent has touched it.`);
      }
      return ok(renderFileGrounding(g));
    }
    case 'memory.code.intent': {
      const file = reqString(args, 'file');
      const row = query<{ intent_summary: string | null }>(
        `SELECT intent_summary FROM code_files WHERE path = ?`,
        [file],
      )[0];
      if (!row?.intent_summary) return ok(`(no intent extracted yet for ${file})`);
      try { return json(JSON.parse(row.intent_summary)); }
      catch { return ok(row.intent_summary); }
    }
    case 'memory.code.dependents': {
      const file = reqString(args, 'file');
      const moduleUrn = `module:${file}`;
      const rows = query<{ subject: string; predicate: string }>(
        `SELECT DISTINCT subject, predicate FROM facts
           WHERE agent = 'codebase-graph'
             AND predicate IN ('imports', 'imports_dynamic')
             AND object = ?
           ORDER BY subject`,
        [moduleUrn],
      );
      if (rows.length === 0) return ok(`(no dependents — nothing in the user repo imports ${file})`);
      return json({
        file,
        dependentCount: rows.length,
        dependents: rows.map((r) => ({
          module: r.subject.replace(/^module:/, ''),
          dynamic: r.predicate === 'imports_dynamic',
        })),
      });
    }
    case 'memory.code.imports': {
      const file = reqString(args, 'file');
      const moduleUrn = `module:${file}`;
      const rows = query<{ object: string; predicate: string }>(
        `SELECT object, predicate FROM facts
           WHERE agent = 'codebase-graph' AND subject = ?
             AND predicate IN ('imports', 'imports_dynamic', 'depends_on')
           ORDER BY predicate, object`,
        [moduleUrn],
      );
      if (rows.length === 0) return ok(`(no imports tracked for ${file})`);
      return json({
        file,
        internal: rows.filter((r) => r.predicate.startsWith('imports')).map((r) => r.object.replace(/^module:/, '')),
        external: rows.filter((r) => r.predicate === 'depends_on').map((r) => r.object.replace(/^package:/, '')),
      });
    }
    case 'memory.code.findings': {
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
      const fileFilter = typeof args.file === 'string' ? args.file : null;
      const kindFilter = typeof args.kind === 'string' ? args.kind : null;
      const sevFilter = typeof args.severity === 'string' ? args.severity : null;
      const hoursFilter = typeof args.hours === 'number' ? args.hours : null;
      const sinceMs = hoursFilter ? Date.now() - hoursFilter * 60 * 60 * 1000 : 0;

      const conds: string[] = ['1=1'];
      const params: unknown[] = [];
      if (fileFilter) { conds.push('file LIKE ?'); params.push(`%${fileFilter}%`); }
      if (kindFilter) { conds.push('kind LIKE ?'); params.push(`%${kindFilter}%`); }
      if (sevFilter) { conds.push('severity = ?'); params.push(sevFilter); }
      if (sinceMs > 0) { conds.push('at >= ?'); params.push(sinceMs); }
      params.push(limit);

      const rows = query<{ at: number; agent: string; kind: string; severity: string; summary: string; file: string | null; line: number | null }>(
        `SELECT at, agent, kind, severity, summary, file, line FROM findings
           WHERE ${conds.join(' AND ')}
           ORDER BY at DESC LIMIT ?`,
        params,
      );
      if (rows.length === 0) return ok('(no findings match)');
      return json({
        count: rows.length,
        findings: rows.map((r) => ({
          at: new Date(r.at).toISOString(),
          agent: r.agent, kind: r.kind, severity: r.severity,
          summary: r.summary,
          ...(r.file ? { file: r.file } : {}),
          ...(r.line ? { line: r.line } : {}),
        })),
      });
    }
    case 'memory.code.coverage_gaps': {
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
      const fileFilter = typeof args.file === 'string' ? args.file : null;
      const conds: string[] = [`agent = 'test-coverage'`, `kind = 'coverage:gap-discovered'`];
      const params: unknown[] = [];
      if (fileFilter) { conds.push('file LIKE ?'); params.push(`%${fileFilter}%`); }
      params.push(limit);
      const rows = query<{ summary: string; file: string | null; severity: string; payload_json: string | null }>(
        `SELECT summary, file, severity, payload_json FROM findings
           WHERE ${conds.join(' AND ')}
           ORDER BY at DESC LIMIT ?`,
        params,
      );
      if (rows.length === 0) return ok('(no coverage gaps tracked — make sure a test framework is configured)');
      return json({
        count: rows.length,
        gaps: rows.map((r) => {
          let payload: { label?: string; kind?: string; reason?: string } = {};
          try { payload = JSON.parse(r.payload_json ?? '{}'); } catch { /* */ }
          return {
            file: r.file,
            severity: r.severity,
            export: payload.label,
            exportKind: payload.kind,
            reason: payload.reason,
          };
        }),
      });
    }
    case 'memory.code.concerns': {
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 30, 100);
      const queryFilter = typeof args.query === 'string' ? args.query : null;
      const sevFilter = typeof args.severity === 'string' ? args.severity : null;
      const conds: string[] = [`(agent = 'concerns-ingest' OR (agent = 'curator' AND kind LIKE 'curator:concern-%'))`];
      const params: unknown[] = [];
      if (queryFilter) { conds.push('summary LIKE ?'); params.push(`%${queryFilter}%`); }
      if (sevFilter) { conds.push('severity = ?'); params.push(sevFilter); }
      params.push(limit);
      const rows = query<{ at: number; kind: string; severity: string; summary: string; file: string | null }>(
        `SELECT at, kind, severity, summary, file FROM findings
           WHERE ${conds.join(' AND ')}
           ORDER BY at DESC LIMIT ?`,
        params,
      );
      if (rows.length === 0) return ok(`(no concerns yet — concerns-ingest agent may not have run; current concernsFile=${config.concernsFile})`);
      return json({
        count: rows.length,
        concerns: rows.map((r) => ({
          at: new Date(r.at).toISOString(),
          severity: r.severity, kind: r.kind, summary: r.summary,
          ...(r.file ? { file: r.file } : {}),
        })),
      });
    }
    case 'memory.code.project_context': {
      const g = buildProjectGrounding();
      if (!g.populated) return ok('(no project context yet — wait for codebase-graph + intent-extractor to populate)');
      return ok(renderProjectGrounding(g));
    }
  }
  throw new Error(`unknown code tool: ${name}`);
}
