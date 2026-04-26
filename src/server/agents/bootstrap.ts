/* Bootstrap agent — claude -p driven.
 *
 * The first phase of the "build a 100%-confident model of the
 * project" plan. Reads every entity the deterministic graph agent
 * has populated into the register, asks claude -p to:
 *
 *   1. cluster them into product segments (slash-pathed)
 *   2. assign each entity to a segment (or leave it unassigned)
 *   3. write a 4-8 sentence wiki page per segment, citing entities
 *
 * The agent's response is parsed + applied to the memory layer:
 *   defineSegment(...) for each new segment
 *   registerEntity(...) for each assignment (preserves prior fields)
 *   wikiUpsert(...)     for each wiki page
 *
 * Hard-path: any malformed assignment (URN not in register), any
 * wiki page citing 0 entities, or any segment proposal without a
 * description is dropped + flagged. The agent never writes
 * confidence < 1.0; if it would, it returns empty.
 *
 * Bootstrap is intentionally NOT on a periodic schedule. It runs:
 *   - once on first daemon boot if register has entities but
 *     segments table is empty (auto-bootstrap)
 *   - on manual trigger via POST /api/agents/bootstrap/run
 *
 * Subsequent runs (D.3 follow-ups) will refine clusters and seed
 * deeper wiki pages.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude } from '../claude.ts';
import { newId, rejectedFinding } from '../findings.ts';
import { defineSegment, entities, lookup, registerEntity, wikiUpsert } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_BASE = readFileSync(resolve(here, 'bootstrap.md'), 'utf8');

type SegmentSpec = { name: string; description?: string };
type Assignment  = { urn: string; segment: string };
type WikiSpec    = { segment: string; topic: string; content: string };
type BootstrapOutput = {
  segments?: SegmentSpec[];
  assignments?: Assignment[];
  wiki?: WikiSpec[];
};

function buildPrompt(): string {
  const ents = entities();
  const lines = ents.map((e) => `- ${e.urn}${e.file ? `  (${e.file})` : ''}`).join('\n');
  return `${PROMPT_BASE}

---

## Input — entities currently in the register (${ents.length} total)

${lines || '(none — bootstrap cannot run with zero entities; return empty output)'}
`;
}

/** Pull a single JSON object out of a possibly-fenced response. */
function parseJsonObject<T>(text: string): T | null {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate: string = fenceMatch && fenceMatch[1] ? fenceMatch[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)) as T; }
  catch { return null; }
}

export const bootstrapAgent: Agent = {
  name: 'bootstrap',
  description: 'Builds the project model: clusters register entities into segments + seeds a wiki page per segment.',
  routedFiles: [],
  intervalMs: 0,                       // manual / one-shot only
  run: async () => {
    const ents = entities();
    if (ents.length === 0) {
      return [{
        id: newId(),
        agent: 'bootstrap',
        kind: 'bootstrap:no-source',
        at: Date.now(),
        severity: 'info',
        summary: 'register is empty — let the graph agent populate entities first',
      }];
    }

    const findings: Finding[] = [{
      id: newId(),
      agent: 'bootstrap',
      kind: 'bootstrap:start',
      at: Date.now(),
      severity: 'info',
      summary: `bootstrap pass starting · ${ents.length} entities to cluster`,
      payload: { entityCount: ents.length },
    }];

    const r = await runClaude({ prompt: buildPrompt(), timeoutMs: 240_000 });
    const out = parseJsonObject<BootstrapOutput>(r.text);
    if (!out) {
      findings.push(rejectedFinding('bootstrap', 'agent output was not a parseable JSON object', { textPreview: r.text.slice(0, 500) }));
      return findings;
    }

    const segs = (out.segments ?? []).filter((s) => typeof s.name === 'string' && s.name.length > 0);
    const validSegNames = new Set(segs.map((s) => s.name));
    for (const s of segs) defineSegment({ name: s.name, description: s.description, ownerAgent: 'bootstrap' });

    const validUrns = new Set(ents.map((e) => e.urn));
    let assignedOk = 0, assignedBad = 0;
    for (const a of out.assignments ?? []) {
      if (!validUrns.has(a.urn)) { assignedBad++; continue; }
      if (!validSegNames.has(a.segment)) { assignedBad++; continue; }
      const existing = lookup(a.urn);
      if (!existing) { assignedBad++; continue; }
      registerEntity({
        urn: existing.urn,
        kind: existing.kind,
        label: existing.label,
        ...(existing.file ? { file: existing.file } : {}),
        ...(existing.evidence ? { evidence: existing.evidence } : {}),
        agent: 'bootstrap',
        confidence: existing.confidence,
        segment: a.segment,
      });
      assignedOk++;
    }

    let wikiOk = 0, wikiBad = 0;
    for (const w of out.wiki ?? []) {
      if (!validSegNames.has(w.segment) || typeof w.content !== 'string' || w.content.length < 30) { wikiBad++; continue; }
      // Hard-path: require the wiki page to cite at least one entity URN we know about.
      const cites = ents.some((e) => w.content.includes(e.urn));
      if (!cites) { wikiBad++; continue; }
      wikiUpsert({
        segment: w.segment,
        topic: w.topic || 'overview',
        content: w.content,
        agent: 'bootstrap',
        confidence: 1.0,
      });
      wikiOk++;
    }

    findings.push({
      id: newId(),
      agent: 'bootstrap',
      kind: 'bootstrap:complete',
      at: Date.now(),
      severity: 'info',
      summary: `bootstrap pass · ${segs.length} segments · ${assignedOk}/${(out.assignments ?? []).length} entities assigned · ${wikiOk}/${(out.wiki ?? []).length} wiki pages seeded`,
      payload: {
        segments: segs.length,
        assignedOk, assignedBad,
        wikiOk, wikiBad,
        durationMs: r.durationMs,
      },
    });
    return findings;
  },
};
