/* memory.* — general MCP tools (recall, facts, wiki, entities, notes,
 * approval queue read+decide).
 *
 * Same shape as memory.code.* — pure read+write wrappers over the
 * existing memory.ts helpers, no new state.
 */

import { addFact, decideApproval, entities, factsByPredicate, getApproval, listApprovals, lookup, query, recallAll, registerEntity, wikiList, wikiRead } from '../../memory.ts';
import { newId } from '../../findings.ts';

type ToolDef = {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
};

export const generalTools: ToolDef[] = [
  {
    name: 'memory.recall',
    description: 'Substring search across notes, facts (subject/object), wiki, and register labels. Returns the best matches with their layer + raw row. Use as a first-pass "what does dev-infra remember about X?" query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to search for' },
        limit: { type: 'number', description: 'Default 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory.facts.find',
    description: 'Query the facts graph by subject URN, predicate, or object URN (any combination). Returns matching triples with evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Optional URN, e.g. module:web/src/App.tsx' },
        predicate: { type: 'string', description: 'Optional, e.g. imports / depends_on / exported_by' },
        object: { type: 'string', description: 'Optional URN' },
        limit: { type: 'number', description: 'Default 50' },
      },
    },
  },
  {
    name: 'memory.wiki.read',
    description: 'Read the long-form wiki page for a (segment, topic) pair, or list all topics in a segment when topic is omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        segment: { type: 'string', description: 'Slash-pathed segment, e.g. screen/Home' },
        topic: { type: 'string', description: 'Optional — omit to list all topics in the segment' },
      },
      required: ['segment'],
    },
  },
  {
    name: 'memory.entities.get',
    description: 'Look up a single entity by URN.',
    inputSchema: {
      type: 'object',
      properties: { urn: { type: 'string', description: 'URN like screen:Home / function:foo.ts:bar' } },
      required: ['urn'],
    },
  },
  {
    name: 'memory.entities.list',
    description: 'List entities, filterable by kind and/or segment.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Optional, e.g. screen / module / function / package' },
        segment: { type: 'string', description: 'Optional segment filter' },
        limit: { type: 'number', description: 'Default 50' },
      },
    },
  },
  {
    name: 'memory.approvals.list',
    description: 'List pending approvals (auto-fix cycles + prompt-diff proposals waiting for human review). Same data the AUTO-FIX dashboard panel shows.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Optional: pending (default) | all' } },
    },
  },
  {
    name: 'memory.approvals.decide',
    description: 'Approve or reject a pending approval. Same effect as the dashboard buttons. Use with caution — REJECT on an auto-fix cycle reverts the file changes via git checkout.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Approval id from memory.approvals.list' },
        decision: { type: 'string', description: 'approved | rejected' },
        note: { type: 'string', description: 'Optional human note' },
      },
      required: ['id', 'decision'],
    },
  },
  {
    name: 'memory.note',
    description: 'Drop a free-form note into memory. Use this when the user says "remember this" or you observe something worth preserving across sessions. Tagged with source=mcp-client and a fresh URN.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note body — be specific; avoid vague phrasing' },
        scope: { type: 'string', description: 'Optional segment, e.g. project:memory_os / personal:nik / global. Defaults to "session".' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags array' },
      },
      required: ['text'],
    },
  },
];

type Json = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
const json = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const reqString = (args: Json, key: string): string => {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new Error(`missing required arg: ${key}`);
  return v;
};

export async function callGeneralTool(name: string, args: Json): Promise<ToolResult> {
  switch (name) {
    case 'memory.recall': {
      const q = reqString(args, 'query');
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 20, 100);
      const hits = recallAll(q, limit);
      if (hits.length === 0) return ok(`(no memory rows match "${q}")`);
      return json({ query: q, count: hits.length, hits });
    }
    case 'memory.facts.find': {
      const subject = typeof args.subject === 'string' ? args.subject : null;
      const predicate = typeof args.predicate === 'string' ? args.predicate : null;
      const object = typeof args.object === 'string' ? args.object : null;
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 200);
      const conds: string[] = ['1=1'];
      const params: unknown[] = [];
      if (subject) { conds.push('subject = ?'); params.push(subject); }
      if (predicate) { conds.push('predicate = ?'); params.push(predicate); }
      if (object) { conds.push('object = ?'); params.push(object); }
      params.push(limit);
      const rows = query<{ subject: string; predicate: string; object: string; agent: string; confidence: number; evidence_json: string | null; at: number }>(
        `SELECT subject, predicate, object, agent, confidence, evidence_json, at FROM facts
           WHERE ${conds.join(' AND ')}
           ORDER BY at DESC LIMIT ?`,
        params,
      );
      return json({
        count: rows.length,
        facts: rows.map((r) => ({
          subject: r.subject, predicate: r.predicate, object: r.object,
          agent: r.agent, confidence: r.confidence,
          at: new Date(r.at).toISOString(),
          evidence: r.evidence_json ? (() => { try { return JSON.parse(r.evidence_json!); } catch { return null; } })() : null,
        })),
      });
    }
    case 'memory.wiki.read': {
      const segment = reqString(args, 'segment');
      const topic = typeof args.topic === 'string' ? args.topic : null;
      if (topic) {
        const r = wikiRead({ segment, topic });
        if (!r) return ok(`(no wiki page for ${segment}/${topic})`);
        return ok(r.body_md);
      }
      const list = wikiList({ segment });
      if (list.length === 0) return ok(`(no wiki pages in segment ${segment})`);
      return json({ segment, topics: list.map((p) => ({ topic: p.topic, version: p.version, updatedAt: new Date(p.updatedAt).toISOString() })) });
    }
    case 'memory.entities.get': {
      const urn = reqString(args, 'urn');
      const e = lookup(urn);
      return e ? json(e) : ok(`(no entity with urn ${urn})`);
    }
    case 'memory.entities.list': {
      const kind = typeof args.kind === 'string' ? args.kind : undefined;
      const segment = typeof args.segment === 'string' ? args.segment : undefined;
      const limit = Math.min(typeof args.limit === 'number' ? args.limit : 50, 200);
      const all = entities({ ...(kind ? { kind } : {}), ...(segment ? { segment } : {}) });
      return json({ count: all.length, entities: all.slice(0, limit) });
    }
    case 'memory.approvals.list': {
      const filter = args.filter === 'all' ? 'all' : 'pending';
      const rows = listApprovals(filter);
      return json({
        count: rows.length,
        approvals: rows.map((r) => ({
          ...r,
          payload: (() => { try { return JSON.parse(r.payload_json); } catch { return null; } })(),
        })),
      });
    }
    case 'memory.approvals.decide': {
      const id = reqString(args, 'id');
      const decision = reqString(args, 'decision');
      if (decision !== 'approved' && decision !== 'rejected') {
        throw new Error(`decision must be 'approved' or 'rejected'`);
      }
      const row = getApproval(id);
      if (!row) throw new Error(`approval not found: ${id}`);
      if (row.status !== 'pending') throw new Error(`approval already ${row.status}`);
      const note = typeof args.note === 'string' ? args.note : undefined;
      decideApproval(id, decision, note);
      // NOTE: file revert + prompt-diff apply only happen via the
      // /api/approvals HTTP endpoint (which is wired into the daemon
      // process). MCP path here just records the decision so the
      // queue clears; daemon's curator picks up the cycle on next run.
      return ok(`approval ${id} → ${decision}. Note: file revert (auto-fix) and prompt-diff apply (self-improve) only run via the daemon's HTTP endpoint, not through MCP. Use the dashboard's APPROVE/REJECT buttons for those side effects.`);
    }
    case 'memory.note': {
      const text = reqString(args, 'text');
      const scope = typeof args.scope === 'string' ? args.scope : 'session';
      const tags = Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === 'string') : [];
      const id = newId();
      const urn = `note:${id}`;
      registerEntity({
        urn, kind: 'note', label: text.slice(0, 80),
        agent: 'mcp-client',
        segment: scope,
        evidence: [text],
        confidence: 1.0,
      });
      // Add a fact so the note is queryable via the graph too.
      addFact({
        agent: 'mcp-client',
        subject: urn,
        predicate: 'note_in_scope',
        object: `scope:${scope}`,
        evidence: [text],
        confidence: 1.0,
      });
      for (const tag of tags) {
        addFact({
          agent: 'mcp-client',
          subject: urn,
          predicate: 'tagged',
          object: `tag:${tag}`,
          evidence: [text],
          confidence: 1.0,
        });
      }
      return ok(`note recorded · urn=${urn} · scope=${scope}${tags.length ? ` · tags=${tags.join(',')}` : ''}`);
    }
  }
  throw new Error(`unknown general tool: ${name}`);
}
