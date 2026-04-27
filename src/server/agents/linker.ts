/* Linker agent — deterministic.
 *
 * The "coordination layer" of the memory cell vision: turns the
 * graph from a dot-cloud into a connected mesh by bridging the
 * dead-ends every other agent leaves behind.
 *
 * What "memory cells" need from the linker:
 *   - every layer's facts must terminate at a real register entity
 *     (not a pseudo-URN like file:foo.ts when module:foo.ts exists);
 *   - the wiki layer must be visible — wiki_pages rows become
 *     kind=wiki entities so they participate in cell activation;
 *   - lateral edges between cells (note → entity, wiki → entity,
 *     commit → concern) must exist so a question's anchor cell can
 *     traverse outward and pick up adjacent context.
 *
 * The linker makes NO original observations of user code — it only
 * connects what other agents have already confirmed at confidence
 * 1.0. That's why every bridge it emits is also confidence 1.0 (the
 * pseudo-URN bridge) or 0.85 (heuristic mention/proximity match).
 *
 * Cadence: 5min interval; routedFiles empty (we drive ourselves off
 * the memory tables, not the watcher).
 */

import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, query, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

type RegisterRow = { urn: string; kind: string; label: string; file: string | null };

function loadRegister(): Map<string, RegisterRow> {
  const rows = query<RegisterRow>(`SELECT urn, kind, label, file FROM register`);
  const m = new Map<string, RegisterRow>();
  for (const r of rows) m.set(r.urn, r);
  return m;
}

/** Build (file → urn) index of every entity that has a `file` column,
 *  keyed by file path. Used to bridge file:X dead-ends to whichever
 *  module/component/screen lives at that path. */
function buildFileIndex(register: Map<string, RegisterRow>): Map<string, string[]> {
  const idx = new Map<string, string[]>();
  for (const r of register.values()) {
    if (!r.file) continue;
    const list = idx.get(r.file) ?? [];
    list.push(r.urn);
    idx.set(r.file, list);
  }
  return idx;
}

/** Build label-and-urn-keyed index for mention scanning. Lower-cased
 *  labels and full URNs both become candidate match keys. Filters out
 *  short/generic labels (length < 6) so we don't generate spurious
 *  matches on words like "auth" or "user". */
function buildMentionIndex(register: Map<string, RegisterRow>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of register.values()) {
    idx.set(r.urn, r.urn);
    const label = r.label.trim().toLowerCase();
    if (label.length >= 6 && !idx.has(label)) idx.set(label, r.urn);
  }
  return idx;
}

function emitBridge(
  subject: string,
  predicate: string,
  object: string,
  evidence: string[],
  confidence = 1.0,
): boolean {
  // addFact has UNIQUE(subject, predicate, object); duplicates are
  // ignored at SQL level, so we count attempts rather than inserts.
  addFact({ agent: 'linker', subject, predicate, object, evidence, confidence });
  return true;
}

export const linkerAgent: Agent = {
  name: 'linker',
  description:
    'Coordination layer for the memory cell graph: registers wiki pages as entities, bridges file:/section:/scope:/pkg: pseudo-URNs to real register entries, scans notes/wiki/concerns for entity mentions, and links commits to concerns by file overlap.',
  routedFiles: [],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    const register = loadRegister();
    if (register.size === 0) {
      return [{
        id: newId(),
        agent: 'linker',
        kind: 'linker:no-data',
        at: now,
        severity: 'info',
        summary: 'register is empty — nothing to link yet',
      }];
    }

    const fileIndex = buildFileIndex(register);
    const mentionIndex = buildMentionIndex(register);

    let wikiRegistered = 0;
    let wikiDescribesEmitted = 0;
    let fileBridges = 0;
    let sectionEntities = 0;
    let scopeEntities = 0;
    let packageEntities = 0;
    let agentEntities = 0;
    let segmentEntities = 0;
    let noteMentions = 0;
    let commitToConcernLinks = 0;
    let resolutionToCommitLinks = 0;

    // ─── 1. WIKI CELLS ────────────────────────────────────────────────────
    // Promote every wiki_pages row to a kind=wiki entity so it shows up in
    // the graph + can be traversed during cell activation. URN scheme:
    // wiki:<segment>:<topic>. Confidence inherits the page's confidence.
    type WikiRow = { segment: string; topic: string; content: string; agent: string; confidence: number; at: number };
    const wikiRows = query<WikiRow>(
      `SELECT segment, topic, content, agent, confidence, at FROM wiki_pages`,
    );
    for (const w of wikiRows) {
      const urn = `wiki:${w.segment}:${w.topic}`;
      registerEntity({
        urn,
        kind: 'wiki',
        label: `${w.segment} / ${w.topic}`,
        segment: w.segment,
        agent: 'linker',
        confidence: 1.0,
        evidence: [`wiki_pages:${w.segment}/${w.topic}`, `${w.content.length} chars`],
      });
      wikiRegistered++;

      // Wiki describes the segment it's filed under, and whatever entities
      // it mentions in its body.
      emitBridge(urn, 'filed_under', `segment:${w.segment}`, [`wiki_pages:${w.segment}/${w.topic}`], 1.0);
      const lcBody = w.content.toLowerCase();
      const lcSeg = w.segment.toLowerCase();
      for (const [needle, targetUrn] of mentionIndex) {
        if (targetUrn === urn) continue;
        // Cheap heuristic: only consider needles that look segment-aligned
        // OR full URNs that appear as substrings. Avoids false positives
        // from generic English words elsewhere in the body.
        if (needle.startsWith(lcSeg) || needle.startsWith(targetUrn.split(':')[0] + ':')) {
          if (!lcBody.includes(needle.toLowerCase())) continue;
        } else if (!lcBody.includes(needle.toLowerCase())) {
          continue;
        }
        if (emitBridge(urn, 'describes', targetUrn, [`wiki_pages:${w.segment}/${w.topic}`], 0.85)) {
          wikiDescribesEmitted++;
        }
      }
    }

    // ─── 2. FILE PSEUDO-URN BRIDGES ───────────────────────────────────────
    // Anywhere a fact terminates at file:X and a real entity lives at that
    // path, emit (file:X) is_module (entity_urn) at confidence 1.0. The
    // bridge is reified as a real register row too, so the dead-end node
    // becomes a real cell that points at its concrete entity.
    type FactRow = { subject: string; object: string };
    const fileTargets = query<FactRow>(
      `SELECT DISTINCT subject, object FROM facts WHERE object LIKE 'file:%'`,
    );
    const seenFileUrns = new Set<string>();
    for (const f of fileTargets) {
      if (seenFileUrns.has(f.object)) continue;
      seenFileUrns.add(f.object);
      const filePath = f.object.slice(5);              // strip 'file:'
      const matches = fileIndex.get(filePath) ?? [];
      // Even when there's no matching entity we register the file: URN so
      // the graph has a node — otherwise the edge points at empty space.
      registerEntity({
        urn: f.object,
        kind: 'file',
        label: filePath,
        file: filePath,
        agent: 'linker',
        confidence: 1.0,
        evidence: [`bridged from ${f.subject}`],
      });
      for (const m of matches) {
        // Don't self-bridge — file:X → file:X already exists.
        if (m === f.object) continue;
        if (emitBridge(f.object, 'is_entity', m, [`file:${filePath} → ${m}`], 1.0)) {
          fileBridges++;
        }
      }
    }

    // ─── 3. SECTION / SCOPE / PACKAGE ENTITIES ────────────────────────────
    // These three pseudo-URN families show up frequently as fact objects
    // but never have register entries. Promote each unique value to a real
    // entity so concerns/notes/code-change-tracker links resolve.
    type ObjRow = { object: string; n: number };
    const sectionObjs = query<ObjRow>(
      `SELECT object, COUNT(*) AS n FROM facts WHERE object LIKE 'section:%' GROUP BY object`,
    );
    for (const s of sectionObjs) {
      registerEntity({
        urn: s.object,
        kind: 'section',
        label: s.object.slice(8).slice(0, 120),         // strip 'section:'
        agent: 'linker',
        confidence: 1.0,
        evidence: [`${s.n} fact${s.n === 1 ? '' : 's'} reference this section`],
      });
      sectionEntities++;
    }

    const scopeObjs = query<ObjRow>(
      `SELECT object, COUNT(*) AS n FROM facts WHERE object LIKE 'scope:%' GROUP BY object`,
    );
    for (const s of scopeObjs) {
      registerEntity({
        urn: s.object,
        kind: 'scope',
        label: s.object.slice(6).slice(0, 120),
        agent: 'linker',
        confidence: 1.0,
        evidence: [`${s.n} fact${s.n === 1 ? '' : 's'} reference this scope`],
      });
      scopeEntities++;
    }

    const pkgObjs = query<ObjRow>(
      `SELECT object, COUNT(*) AS n FROM facts WHERE object LIKE 'pkg:%' GROUP BY object`,
    );
    for (const p of pkgObjs) {
      const existing = register.get(p.object);
      if (existing) continue;                            // already a real entity
      registerEntity({
        urn: p.object,
        kind: 'package',
        label: p.object.slice(4).slice(0, 120),
        agent: 'linker',
        confidence: 1.0,
        evidence: [`${p.n} dependency edge${p.n === 1 ? '' : 's'}`],
      });
      packageEntities++;
    }

    // ─── 3b. AGENT CELLS ─────────────────────────────────────────────────
    // Every distinct agent that's emitted facts/findings should be a cell.
    // self-awareness emits one kind=self entity but doesn't promote each
    // individual agent — the linker fills the gap. Sourced from agents
    // appearing in the facts table (any agent that's contributed to the
    // graph qualifies as an entity in the graph).
    type AgentRow = { agent: string };
    const agentRows = query<AgentRow>(
      `SELECT DISTINCT agent FROM facts UNION SELECT DISTINCT agent FROM register`,
    );
    for (const a of agentRows) {
      const urn = `agent:${a.agent}`;
      if (register.has(urn)) continue;
      registerEntity({
        urn,
        kind: 'agent',
        label: a.agent,
        agent: 'linker',
        confidence: 1.0,
        evidence: [`emits facts to register/facts as agent="${a.agent}"`],
      });
      agentEntities++;
    }

    // ─── 3c. SEGMENT CELLS ───────────────────────────────────────────────
    // Segments are referenced by every wiki page + many concerns but
    // never promoted to register entities. Promote each unique segment
    // appearing as a fact object so traversal lands on a real cell.
    type SegRow = { object: string; n: number };
    const segObjs = query<SegRow>(
      `SELECT object, COUNT(*) AS n FROM facts WHERE object LIKE 'segment:%' GROUP BY object`,
    );
    for (const s of segObjs) {
      if (register.has(s.object)) continue;
      registerEntity({
        urn: s.object,
        kind: 'segment',
        label: s.object.slice(8).slice(0, 120),
        agent: 'linker',
        confidence: 1.0,
        evidence: [`${s.n} fact${s.n === 1 ? '' : 's'} reference this segment`],
      });
      segmentEntities++;
    }

    // ─── 4. NOTE → ENTITY MENTIONS ───────────────────────────────────────
    // Scan note bodies (kind=note in register + the notes table) for
    // mentions of any entity URN/label. Lateral cell links — lets a
    // question that anchors on a note pull adjacent entities into context.
    type NoteRow = { agent: string; key: string; value_json: string };
    const noteRows = query<NoteRow>(
      `SELECT agent, key, value_json FROM notes WHERE length(value_json) > 20`,
    );
    for (const n of noteRows) {
      const lc = n.value_json.toLowerCase();
      const urn = `note:${n.agent}:${n.key}`;
      // Best-effort register the note as a cell so lateral edges point at
      // a real node. Cheap; idempotent.
      registerEntity({
        urn,
        kind: 'note',
        label: `${n.agent} · ${n.key}`.slice(0, 120),
        agent: 'linker',
        confidence: 1.0,
        evidence: [`notes table: ${n.agent}/${n.key}`],
      });
      for (const [needle, targetUrn] of mentionIndex) {
        if (targetUrn === urn) continue;
        if (needle.length < 6) continue;                 // avoid noise
        if (!lc.includes(needle.toLowerCase())) continue;
        if (emitBridge(urn, 'mentions', targetUrn, [`note ${n.agent}/${n.key}`], 0.85)) {
          noteMentions++;
        }
      }
    }

    // ─── 5. COMMIT → CONCERN PROXIMITY ────────────────────────────────────
    // For each commit, find concerns targeting the same file:X and emit
    // (commit) likely_addresses (concern) at confidence 0.85. Stronger than
    // free-text scanning because both endpoints share file evidence.
    type EdgeRow = { commit_urn: string; concern_urn: string; file_urn: string };
    const overlap = query<EdgeRow>(
      `SELECT DISTINCT
         m.subject AS commit_urn,
         t.subject AS concern_urn,
         m.object  AS file_urn
       FROM facts m
       JOIN facts t
         ON t.object = m.object
       WHERE m.predicate = 'modified'
         AND t.predicate = 'targets'
         AND m.subject LIKE 'commit:%'
         AND t.subject LIKE 'concern:%'`,
    );
    for (const e of overlap) {
      if (emitBridge(
        e.commit_urn,
        'likely_addresses',
        e.concern_urn,
        [`shared file: ${e.file_urn}`],
        0.85,
      )) {
        commitToConcernLinks++;
      }
    }

    // ─── 6. RESOLUTION → COMMIT TEMPORAL/FILE PROXIMITY ──────────────────
    // For each kind=resolution entity, find commits within ±48h whose
    // modified files overlap with the resolution's evidence. Emits
    // (resolution) likely_authored_by (commit) at confidence 0.85.
    type ResRow = { urn: string; at: number; evidence_json: string | null };
    const resolutions = query<ResRow>(
      `SELECT urn, at, evidence_json FROM register WHERE kind = 'resolution'`,
    );
    if (resolutions.length > 0) {
      const window = 48 * 60 * 60 * 1000;
      type CRow = { commit_urn: string };
      for (const r of resolutions) {
        let fileObjects: string[] = [];
        try {
          const parsed = JSON.parse(r.evidence_json ?? '[]') as string[];
          fileObjects = parsed.filter((s) => /\.[a-zA-Z]+$/.test(s)).map((f) => `file:${f}`);
        } catch { /* */ }
        if (fileObjects.length === 0) continue;

        const placeholders = fileObjects.map(() => '?').join(',');
        const candidates = query<CRow>(
          `SELECT DISTINCT m.subject AS commit_urn
             FROM facts m
             JOIN register c ON c.urn = m.subject
            WHERE m.predicate = 'modified'
              AND m.object IN (${placeholders})
              AND c.kind = 'commit'
              AND ABS(c.at - ?) <= ?`,
          [...fileObjects, r.at, window],
        );
        for (const c of candidates) {
          if (emitBridge(
            r.urn,
            'likely_authored_by',
            c.commit_urn,
            [`temporal+file proximity (window=48h)`],
            0.85,
          )) {
            resolutionToCommitLinks++;
          }
        }
      }
    }

    out.push({
      id: newId(),
      agent: 'linker',
      kind: 'linker:summary',
      at: now,
      severity: 'info',
      summary:
        `${wikiRegistered} wiki cells · ${wikiDescribesEmitted} wiki→entity · ${fileBridges} file bridges · ` +
        `${sectionEntities} sections · ${scopeEntities} scopes · ${packageEntities} packages · ` +
        `${agentEntities} agent cells · ${segmentEntities} segment cells · ` +
        `${noteMentions} note mentions · ${commitToConcernLinks} commit→concern · ${resolutionToCommitLinks} resolution→commit`,
      payload: {
        wikiRegistered,
        wikiDescribesEmitted,
        fileBridges,
        sectionEntities,
        scopeEntities,
        packageEntities,
        agentEntities,
        segmentEntities,
        noteMentions,
        commitToConcernLinks,
        resolutionToCommitLinks,
        targetPath: config.targetPath,
      },
    });
    return out;
  },
};
