/* Persistent memory layer.
 *
 * Three concerns under one module so we don't sprawl:
 *
 *   findings    every emitted Finding gets mirrored into SQLite for
 *               cross-session search (the JSONL log on disk is the
 *               source of truth + audit trail; SQLite is the index).
 *
 *   notes       per-agent key/value observations. Agents call note()
 *               to remember things they've learned ("score.recent op
 *               uses a 7-day window"); recall() reads them back. Each
 *               note also gets appended to a per-agent markdown
 *               notebook at data/notebooks/<agent>.md so the user can
 *               read the agent's thinking by hand or via Obsidian.
 *
 *   facts       a graph-shaped ledger of subject/predicate/object
 *               triples that an agent has confirmed in code at 100%
 *               confidence. This is the substrate for the "fully-
 *               modeled project" the bootstrap pass will build.
 *
 * SQLite is sync (better-sqlite3) and file-backed. ~50µs writes on
 * a typical Mac; safe to call inline from emit() without slowing
 * the broadcast path.
 */

import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Finding } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../data');
const NOTEBOOKS_DIR = resolve(DATA_DIR, 'notebooks');
const DB_FILE = resolve(DATA_DIR, 'memory.db');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(NOTEBOOKS_DIR)) mkdirSync(NOTEBOOKS_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  -- L0: append-only finding stream (mirrored from JSONL).
  CREATE TABLE IF NOT EXISTS findings (
    id           TEXT PRIMARY KEY,
    agent        TEXT NOT NULL,
    kind         TEXT NOT NULL,
    at           INTEGER NOT NULL,
    severity     TEXT NOT NULL,
    summary      TEXT NOT NULL,
    file         TEXT,
    line         INTEGER,
    suggestion   TEXT,
    payload_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_findings_agent_at ON findings(agent, at DESC);
  CREATE INDEX IF NOT EXISTS idx_findings_kind     ON findings(kind);
  CREATE INDEX IF NOT EXISTS idx_findings_file     ON findings(file);

  -- L1a: per-agent (key → value) observation store.
  CREATE TABLE IF NOT EXISTS notes (
    agent      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (agent, key)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent);

  -- L1b: 100%-confirmed (subject, predicate, object) graph triples.
  CREATE TABLE IF NOT EXISTS facts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent         TEXT NOT NULL,
    subject       TEXT NOT NULL,
    predicate     TEXT NOT NULL,
    object        TEXT NOT NULL,
    evidence_json TEXT,
    confidence    REAL NOT NULL DEFAULT 1.0,
    at            INTEGER NOT NULL,
    UNIQUE(subject, predicate, object)
  );
  CREATE INDEX IF NOT EXISTS idx_facts_subject   ON facts(subject);
  CREATE INDEX IF NOT EXISTS idx_facts_predicate ON facts(predicate);

  -- L2/L3: segments + micro-segments. parent NULL = top-level.
  -- name uses a slash-separated path: 'auth' / 'auth/oauth' / 'auth/oauth/github'.
  CREATE TABLE IF NOT EXISTS segments (
    name        TEXT PRIMARY KEY,
    parent      TEXT,
    description TEXT,
    owner_agent TEXT,
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_segments_parent ON segments(parent);

  -- L5: register — canonical catalog of every entity (screen, endpoint,
  -- table, MCP tool, etc.) keyed by URN. Agents write here at confidence
  -- 1.0 only, with file evidence references.
  CREATE TABLE IF NOT EXISTS register (
    urn           TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    label         TEXT NOT NULL,
    segment       TEXT,
    file          TEXT,
    evidence_json TEXT,
    confidence    REAL NOT NULL DEFAULT 1.0,
    agent         TEXT NOT NULL,
    at            INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_register_kind    ON register(kind);
  CREATE INDEX IF NOT EXISTS idx_register_segment ON register(segment);

  -- L6: hooks — named subscriptions. When (segment, event) fires, every
  -- active hook on that pair routes to the agent with the prompt fragment
  -- as extra context. Wiring of fire-time logic comes in Step D; this
  -- commit just persists the intentions.
  CREATE TABLE IF NOT EXISTS hooks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    segment         TEXT NOT NULL,
    event           TEXT NOT NULL,
    agent           TEXT NOT NULL,
    prompt_fragment TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    at              INTEGER NOT NULL,
    UNIQUE(segment, event, agent)
  );
  CREATE INDEX IF NOT EXISTS idx_hooks_segment_event ON hooks(segment, event);

  -- L4: wiki — long-form markdown per (segment, topic), machine-written
  -- but human-editable. The DB row is the source of truth for the daemon;
  -- a mirror file is kept under data/wiki/ for Obsidian-vault use.
  CREATE TABLE IF NOT EXISTS wiki_pages (
    segment       TEXT NOT NULL,
    topic         TEXT NOT NULL,
    content       TEXT NOT NULL,
    agent         TEXT NOT NULL,
    confidence    REAL NOT NULL DEFAULT 1.0,
    evidence_json TEXT,
    at            INTEGER NOT NULL,
    PRIMARY KEY (segment, topic)
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_pages_segment ON wiki_pages(segment);

  -- L4 history: every wikiUpsert writes a revision row so the meta-agent
  -- (and humans) can diff what an agent has learned over time.
  CREATE TABLE IF NOT EXISTS wiki_revisions (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    segment TEXT NOT NULL,
    topic   TEXT NOT NULL,
    content TEXT NOT NULL,
    agent   TEXT NOT NULL,
    at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_revisions_topic ON wiki_revisions(segment, topic, at DESC);

  -- Curator promotions: records every finding that was successfully
  -- written to the user's Concerns.md so we never double-write the same
  -- one. Keyed on finding_id (which is unique across all agents).
  CREATE TABLE IF NOT EXISTS promotions (
    finding_id TEXT PRIMARY KEY,
    agent      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL,
    summary    TEXT NOT NULL,
    file       TEXT,
    promoted_to TEXT NOT NULL,
    at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_promotions_at ON promotions(at DESC);

  -- Persistent record of every agent run. The in-memory runs ring is
  -- bounded at 200; this table is the durable source for self-monitor
  -- (D.13) to compute 24h+ metrics across restarts.
  CREATE TABLE IF NOT EXISTS agent_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    agent         TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    duration_ms   INTEGER NOT NULL,
    ok            INTEGER NOT NULL,
    finding_count INTEGER NOT NULL,
    error         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runs_agent_at ON agent_runs(agent, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_runs_at       ON agent_runs(started_at DESC);

  -- Per-(agent, segment) rolling summary (D.22 / 12-patterns #5).
  -- Populated by the dream-consolidator agent (D.21); read by every
  -- LLM agent's runClaude call so the agent doesn't re-derive state
  -- on every run. Segment '*' = an agent-wide summary.
  CREATE TABLE IF NOT EXISTS agent_summaries (
    agent      TEXT NOT NULL,
    segment    TEXT NOT NULL,
    content    TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent, segment)
  );
`);

const WIKI_DIR = resolve(DATA_DIR, 'wiki');
if (!existsSync(WIKI_DIR)) mkdirSync(WIKI_DIR, { recursive: true });

const insertFinding = db.prepare(`
  INSERT OR IGNORE INTO findings
    (id, agent, kind, at, severity, summary, file, line, suggestion, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertNote = db.prepare(`
  INSERT INTO notes (agent, key, value_json, at) VALUES (?, ?, ?, ?)
  ON CONFLICT(agent, key) DO UPDATE SET
    value_json = excluded.value_json,
    at         = excluded.at
`);

const selectNote = db.prepare(`
  SELECT value_json, at FROM notes WHERE agent = ? AND key = ?
`);

const selectAgentNotes = db.prepare(`
  SELECT key, value_json, at FROM notes WHERE agent = ? ORDER BY at DESC
`);

const upsertFact = db.prepare(`
  INSERT INTO facts (agent, subject, predicate, object, evidence_json, confidence, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(subject, predicate, object) DO UPDATE SET
    agent         = excluded.agent,
    evidence_json = excluded.evidence_json,
    confidence    = excluded.confidence,
    at            = excluded.at
`);

const selectFactsBySubject = db.prepare(`
  SELECT agent, subject, predicate, object, evidence_json, confidence, at
  FROM facts WHERE subject = ? ORDER BY at DESC
`);

const selectFactsByPredicate = db.prepare(`
  SELECT agent, subject, predicate, object, evidence_json, confidence, at
  FROM facts WHERE predicate = ? ORDER BY at DESC
`);

/** Mirror a Finding into the SQLite index. Idempotent — INSERT OR IGNORE
 *  on the primary key, so calling it twice is safe (the JSONL append +
 *  hydrate-on-boot path can otherwise produce duplicates). */
export function recordFinding(f: Finding): void {
  insertFinding.run(
    f.id, f.agent, f.kind, f.at, f.severity, f.summary,
    f.file ?? null,
    f.line ?? null,
    f.suggestion ?? null,
    f.payload ? JSON.stringify(f.payload) : null,
  );
}

export type Note = {
  agent: string;
  key: string;
  value: unknown;
  at: number;
};

/** Persist an observation an agent wants to remember. The (agent, key)
 *  pair is the upsert anchor — calling note() with the same key updates
 *  the value in place. Also appends to data/notebooks/<agent>.md so the
 *  user (or an Obsidian vault) can read the agent's thinking. */
export function note(agent: string, key: string, value: unknown): void {
  const at = Date.now();
  upsertNote.run(agent, key, JSON.stringify(value), at);

  const line = `- **${new Date(at).toISOString()}** · \`${key}\` — ${typeof value === 'string' ? value : JSON.stringify(value)}\n`;
  const file = resolve(NOTEBOOKS_DIR, `${agent}.md`);
  if (!existsSync(file)) {
    appendFileSync(file, `# ${agent} notebook\n\nObservations this agent has recorded. Append-only, machine-written; safe to read in Obsidian.\n\n`);
  }
  appendFileSync(file, line);
}

/** Read back what an agent previously remembered for `key`. Returns
 *  undefined if nothing is stored. Wraps the JSON parse so callers
 *  get the original value type back. */
export function recall<T = unknown>(agent: string, key: string): T | undefined {
  const row = selectNote.get(agent, key) as { value_json: string; at: number } | undefined;
  if (!row) return undefined;
  try { return JSON.parse(row.value_json) as T; } catch { return undefined; }
}

/** All notes an agent has authored, newest first. Useful for an agent
 *  to load its full prior context at the start of a run. */
export function recallAll(agent: string): Note[] {
  const rows = selectAgentNotes.all(agent) as { key: string; value_json: string; at: number }[];
  return rows.map((r) => {
    let value: unknown;
    try { value = JSON.parse(r.value_json); } catch { value = r.value_json; }
    return { agent, key: r.key, value, at: r.at };
  });
}

export type Fact = {
  agent: string;
  subject: string;
  predicate: string;
  object: string;
  evidence?: string[];
  confidence?: number;
  at?: number;
};

/** Add (or refresh) a confirmed fact. Triples are unique on
 *  (subject, predicate, object); re-asserting updates the timestamp
 *  + evidence + confidence. Default confidence is 1.0 — agents must
 *  pass < 1.0 explicitly if they're not 100% sure. Hard-path: if you
 *  can't justify 1.0, don't call addFact at all. */
export function addFact(f: Fact): void {
  const at = f.at ?? Date.now();
  const conf = f.confidence ?? 1.0;
  upsertFact.run(
    f.agent, f.subject, f.predicate, f.object,
    f.evidence ? JSON.stringify(f.evidence) : null,
    conf, at,
  );
}

export function factsAbout(subject: string): Fact[] {
  const rows = selectFactsBySubject.all(subject) as Array<{
    agent: string; subject: string; predicate: string; object: string;
    evidence_json: string | null; confidence: number; at: number;
  }>;
  return rows.map((r) => ({
    agent: r.agent, subject: r.subject, predicate: r.predicate, object: r.object,
    evidence: r.evidence_json ? (JSON.parse(r.evidence_json) as string[]) : undefined,
    confidence: r.confidence, at: r.at,
  }));
}

export function factsByPredicate(predicate: string): Fact[] {
  const rows = selectFactsByPredicate.all(predicate) as Array<{
    agent: string; subject: string; predicate: string; object: string;
    evidence_json: string | null; confidence: number; at: number;
  }>;
  return rows.map((r) => ({
    agent: r.agent, subject: r.subject, predicate: r.predicate, object: r.object,
    evidence: r.evidence_json ? (JSON.parse(r.evidence_json) as string[]) : undefined,
    confidence: r.confidence, at: r.at,
  }));
}

// ─── L2/L3: segments ──────────────────────────────────────────────────────

const upsertSegment = db.prepare(`
  INSERT INTO segments (name, parent, description, owner_agent, at)
    VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET
    parent      = excluded.parent,
    description = excluded.description,
    owner_agent = excluded.owner_agent,
    at          = excluded.at
`);
const selectSegment       = db.prepare('SELECT * FROM segments WHERE name = ?');
const selectChildSegments = db.prepare('SELECT * FROM segments WHERE parent IS ? ORDER BY name');
const selectAllSegments   = db.prepare('SELECT * FROM segments ORDER BY name');

export type Segment = { name: string; parent: string | null; description?: string; ownerAgent?: string; at: number };

/** Define (or refresh) a segment. Top-level: parent=null. Hierarchical
 *  paths use slashes (e.g. 'auth/oauth/github'). The parent is the path
 *  with the last segment chopped off; callers may pass it explicitly. */
export function defineSegment(opts: { name: string; parent?: string | null; description?: string; ownerAgent?: string }): void {
  const parent = opts.parent ?? (opts.name.includes('/') ? opts.name.slice(0, opts.name.lastIndexOf('/')) : null);
  upsertSegment.run(opts.name, parent, opts.description ?? null, opts.ownerAgent ?? null, Date.now());
}

export function getSegment(name: string): Segment | undefined {
  const r = selectSegment.get(name) as { name: string; parent: string | null; description: string | null; owner_agent: string | null; at: number } | undefined;
  if (!r) return undefined;
  return { name: r.name, parent: r.parent, description: r.description ?? undefined, ownerAgent: r.owner_agent ?? undefined, at: r.at };
}

/** List child segments of `parent` (null = top-level), or all if undefined. */
export function listSegments(parent?: string | null): Segment[] {
  const rows = (parent === undefined
    ? selectAllSegments.all()
    : selectChildSegments.all(parent)) as Array<{ name: string; parent: string | null; description: string | null; owner_agent: string | null; at: number }>;
  return rows.map((r) => ({ name: r.name, parent: r.parent, description: r.description ?? undefined, ownerAgent: r.owner_agent ?? undefined, at: r.at }));
}

// ─── L5: register ─────────────────────────────────────────────────────────

const upsertRegister = db.prepare(`
  INSERT INTO register (urn, kind, label, segment, file, evidence_json, confidence, agent, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(urn) DO UPDATE SET
    kind          = excluded.kind,
    label         = excluded.label,
    segment       = excluded.segment,
    file          = excluded.file,
    evidence_json = excluded.evidence_json,
    confidence    = excluded.confidence,
    agent         = excluded.agent,
    at            = excluded.at
`);
const selectRegisterByUrn  = db.prepare('SELECT * FROM register WHERE urn = ?');
const selectRegisterByKind = db.prepare('SELECT * FROM register WHERE kind = ? ORDER BY label');
const selectRegisterBySeg  = db.prepare('SELECT * FROM register WHERE segment = ? ORDER BY kind, label');
const selectRegisterAll    = db.prepare('SELECT * FROM register ORDER BY kind, label');

export type Entity = {
  urn: string;
  kind: string;
  label: string;
  segment?: string;
  file?: string;
  evidence?: string[];
  confidence: number;
  agent: string;
  at: number;
};

/** Register (or refresh) an entity. Hard-path: confidence defaults to 1.0
 *  — agents must pass < 1.0 explicitly if not certain, and ideally don't
 *  call register at all unless they have file-level proof. */
export function registerEntity(e: Omit<Entity, 'at' | 'confidence'> & { confidence?: number; at?: number }): void {
  upsertRegister.run(
    e.urn, e.kind, e.label,
    e.segment ?? null,
    e.file ?? null,
    e.evidence ? JSON.stringify(e.evidence) : null,
    e.confidence ?? 1.0,
    e.agent,
    e.at ?? Date.now(),
  );
}

function rowToEntity(r: { urn: string; kind: string; label: string; segment: string | null; file: string | null; evidence_json: string | null; confidence: number; agent: string; at: number }): Entity {
  return {
    urn: r.urn, kind: r.kind, label: r.label,
    segment: r.segment ?? undefined,
    file: r.file ?? undefined,
    evidence: r.evidence_json ? (JSON.parse(r.evidence_json) as string[]) : undefined,
    confidence: r.confidence,
    agent: r.agent,
    at: r.at,
  };
}

export function lookup(urn: string): Entity | undefined {
  const r = selectRegisterByUrn.get(urn) as Parameters<typeof rowToEntity>[0] | undefined;
  return r ? rowToEntity(r) : undefined;
}

export function entities(opts?: { kind?: string; segment?: string }): Entity[] {
  let rows: Parameters<typeof rowToEntity>[0][];
  if (opts?.kind)         rows = selectRegisterByKind.all(opts.kind)    as Parameters<typeof rowToEntity>[0][];
  else if (opts?.segment) rows = selectRegisterBySeg.all(opts.segment)  as Parameters<typeof rowToEntity>[0][];
  else                    rows = selectRegisterAll.all()                as Parameters<typeof rowToEntity>[0][];
  return rows.map(rowToEntity);
}

// ─── L6: hooks ────────────────────────────────────────────────────────────

const upsertHook = db.prepare(`
  INSERT INTO hooks (segment, event, agent, prompt_fragment, active, at)
    VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(segment, event, agent) DO UPDATE SET
    prompt_fragment = excluded.prompt_fragment,
    active          = 1,
    at              = excluded.at
`);
const deactivateHook = db.prepare(`
  UPDATE hooks SET active = 0, at = ? WHERE segment = ? AND event = ? AND agent = ?
`);
const selectHooksFor = db.prepare(`
  SELECT * FROM hooks
  WHERE active = 1
    AND (segment = ? OR segment = '*')
    AND (event   = ? OR event   = '*')
  ORDER BY at DESC
`);
const selectAllActiveHooks = db.prepare(`
  SELECT * FROM hooks WHERE active = 1 ORDER BY segment, event, agent
`);

export type Hook = { id: number; segment: string; event: string; agent: string; promptFragment?: string; active: boolean; at: number };

/** Subscribe `agent` to `event` in `segment`. promptFragment is appended
 *  to that agent's prompt context when the hook fires (Step D wires that
 *  in; this commit just persists the intent). */
export function addHook(opts: { segment: string; event: string; agent: string; promptFragment?: string }): void {
  upsertHook.run(opts.segment, opts.event, opts.agent, opts.promptFragment ?? null, Date.now());
}

export function removeHook(opts: { segment: string; event: string; agent: string }): void {
  deactivateHook.run(Date.now(), opts.segment, opts.event, opts.agent);
}

function rowToHook(r: { id: number; segment: string; event: string; agent: string; prompt_fragment: string | null; active: number; at: number }): Hook {
  return { id: r.id, segment: r.segment, event: r.event, agent: r.agent, promptFragment: r.prompt_fragment ?? undefined, active: r.active === 1, at: r.at };
}

export function firingHooks(segment: string, event: string): Hook[] {
  return (selectHooksFor.all(segment, event) as Parameters<typeof rowToHook>[0][]).map(rowToHook);
}

export function listHooks(): Hook[] {
  return (selectAllActiveHooks.all() as Parameters<typeof rowToHook>[0][]).map(rowToHook);
}

// ─── L4: wiki ─────────────────────────────────────────────────────────────

const upsertWikiPage = db.prepare(`
  INSERT INTO wiki_pages (segment, topic, content, agent, confidence, evidence_json, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(segment, topic) DO UPDATE SET
    content       = excluded.content,
    agent         = excluded.agent,
    confidence    = excluded.confidence,
    evidence_json = excluded.evidence_json,
    at            = excluded.at
`);
const insertWikiRevision = db.prepare(`
  INSERT INTO wiki_revisions (segment, topic, content, agent, at) VALUES (?, ?, ?, ?, ?)
`);
const selectWikiPage      = db.prepare('SELECT * FROM wiki_pages WHERE segment = ? AND topic = ?');
const selectWikiBySegment = db.prepare('SELECT segment, topic, agent, confidence, at FROM wiki_pages WHERE segment = ? ORDER BY topic');
const selectWikiAll       = db.prepare('SELECT segment, topic, agent, confidence, at FROM wiki_pages ORDER BY segment, topic');
const selectWikiRevisions = db.prepare('SELECT id, agent, at FROM wiki_revisions WHERE segment = ? AND topic = ? ORDER BY at DESC LIMIT ?');

export type WikiPage = {
  segment: string;
  topic: string;
  content: string;
  agent: string;
  confidence: number;
  evidence?: string[];
  at: number;
};

export type WikiPageMeta = {
  segment: string;
  topic: string;
  agent: string;
  confidence: number;
  at: number;
};

/** Make a topic safe to use as a filename. Keeps letters/digits/dash/dot. */
function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
}

function wikiFilePath(segment: string, topic: string): string {
  // Segments use slashes; map to nested directories. A leading slash or '..'
  // never enters because segment names are ours and topic is slugified.
  const parts = segment.split('/').filter(Boolean).map(slug);
  return resolve(WIKI_DIR, ...parts, `${slug(topic)}.md`);
}

function wikiFrontmatter(page: WikiPage): string {
  const ev = page.evidence?.length ? `\nevidence:\n${page.evidence.map((e) => `  - ${JSON.stringify(e)}`).join('\n')}` : '';
  return `---
segment: ${JSON.stringify(page.segment)}
topic: ${JSON.stringify(page.topic)}
agent: ${JSON.stringify(page.agent)}
confidence: ${page.confidence}${ev}
updated_at: ${new Date(page.at).toISOString()}
---

`;
}

/** Write (or update) a wiki page. The DB row is canonical; the markdown
 *  file is a mirror for human / Obsidian use. Each call also persists a
 *  revision row so history is recoverable.
 *
 *  Hard-path: confidence defaults to 1.0. If you can't justify 1.0, don't
 *  write the page — leave it for an agent that can. */
export function wikiUpsert(page: Omit<WikiPage, 'at'> & { at?: number }): void {
  const at = page.at ?? Date.now();
  const conf = page.confidence ?? 1.0;
  const ev = page.evidence ? JSON.stringify(page.evidence) : null;

  upsertWikiPage.run(page.segment, page.topic, page.content, page.agent, conf, ev, at);
  insertWikiRevision.run(page.segment, page.topic, page.content, page.agent, at);

  const file = wikiFilePath(page.segment, page.topic);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, wikiFrontmatter({ ...page, at, confidence: conf }) + page.content + '\n');
}

export function wikiRead(segment: string, topic: string): WikiPage | undefined {
  const r = selectWikiPage.get(segment, topic) as { segment: string; topic: string; content: string; agent: string; confidence: number; evidence_json: string | null; at: number } | undefined;
  if (!r) return undefined;
  return {
    segment: r.segment, topic: r.topic, content: r.content,
    agent: r.agent, confidence: r.confidence,
    evidence: r.evidence_json ? (JSON.parse(r.evidence_json) as string[]) : undefined,
    at: r.at,
  };
}

export function wikiList(segment?: string): WikiPageMeta[] {
  const rows = (segment !== undefined
    ? selectWikiBySegment.all(segment)
    : selectWikiAll.all()) as Array<{ segment: string; topic: string; agent: string; confidence: number; at: number }>;
  return rows;
}

export function wikiHistory(segment: string, topic: string, limit = 20): Array<{ id: number; agent: string; at: number }> {
  return selectWikiRevisions.all(segment, topic, limit) as Array<{ id: number; agent: string; at: number }>;
}

// ─── stats ────────────────────────────────────────────────────────────────

/** Aggregate stats — used by the /api/memory endpoint and the UI panel
 *  later in this phase. */
export function memoryStats(): {
  findings: number; notes: number; facts: number;
  segments: number; entities: number; hooks: number;
  wikiPages: number; wikiRevisions: number;
  sizeBytes: number;
} {
  const f  = (db.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n;
  const n  = (db.prepare('SELECT COUNT(*) AS n FROM notes').get()    as { n: number }).n;
  const c  = (db.prepare('SELECT COUNT(*) AS n FROM facts').get()    as { n: number }).n;
  const s  = (db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n;
  const e  = (db.prepare('SELECT COUNT(*) AS n FROM register').get() as { n: number }).n;
  const h  = (db.prepare('SELECT COUNT(*) AS n FROM hooks WHERE active = 1').get() as { n: number }).n;
  const wp = (db.prepare('SELECT COUNT(*) AS n FROM wiki_pages').get()     as { n: number }).n;
  const wr = (db.prepare('SELECT COUNT(*) AS n FROM wiki_revisions').get() as { n: number }).n;
  let size = 0;
  try {
    const stat = (db.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as { size: number });
    size = stat.size;
  } catch { /* */ }
  return { findings: f, notes: n, facts: c, segments: s, entities: e, hooks: h, wikiPages: wp, wikiRevisions: wr, sizeBytes: size };
}

/** Escape hatch for richer queries (e.g. dashboards, the meta-agent).
 *  Read-only — write paths must go through the typed helpers above. */
export function query<T = unknown>(sql: string, params: unknown[] = []): T[] {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error('memory.query is read-only — use the typed helpers for writes');
  }
  return db.prepare(sql).all(...params) as T[];
}

const deleteOldRevisions = db.prepare(`
  DELETE FROM wiki_revisions
  WHERE id IN (
    SELECT id FROM wiki_revisions
    WHERE segment = ? AND topic = ?
    ORDER BY at DESC
    LIMIT -1 OFFSET ?
  )
`);

/** Prune wiki_revisions for a (segment, topic) pair down to `keepN` most
 *  recent rows. Used by the memory-keeper agent to bound history growth. */
export function pruneRevisions(segment: string, topic: string, keepN: number): number {
  const r = deleteOldRevisions.run(segment, topic, keepN);
  return Number(r.changes);
}

const insertPromotion = db.prepare(`
  INSERT OR IGNORE INTO promotions
    (finding_id, agent, kind, severity, summary, file, promoted_to, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const promotionExists = db.prepare(`SELECT 1 FROM promotions WHERE finding_id = ?`);

/** Record that a finding was promoted (written to the user's repo).
 *  Returns true if this was a fresh promotion, false if it was already
 *  promoted (idempotency check). */
export function recordPromotion(opts: {
  findingId: string;
  agent: string;
  kind: string;
  severity: string;
  summary: string;
  file?: string;
  promotedTo: string;
}): boolean {
  if (promotionExists.get(opts.findingId)) return false;
  insertPromotion.run(
    opts.findingId, opts.agent, opts.kind, opts.severity, opts.summary,
    opts.file ?? null, opts.promotedTo, Date.now(),
  );
  return true;
}

export function isPromoted(findingId: string): boolean {
  return promotionExists.get(findingId) !== undefined;
}

const insertRun = db.prepare(`
  INSERT INTO agent_runs (agent, started_at, duration_ms, ok, finding_count, error)
  VALUES (?, ?, ?, ?, ?, ?)
`);
/** Persist an AgentRun for cross-session metrics. The in-memory ring
 *  buffer in findings.ts handles dashboard updates; this table is the
 *  durable record for self-monitor (D.13). */
export function recordRun(opts: { agent: string; startedAt: number; durationMs: number; ok: boolean; findingCount: number; error?: string }): void {
  insertRun.run(opts.agent, opts.startedAt, opts.durationMs, opts.ok ? 1 : 0, opts.findingCount, opts.error ?? null);
}

const upsertSummary = db.prepare(`
  INSERT INTO agent_summaries (agent, segment, content, updated_at)
    VALUES (?, ?, ?, ?)
  ON CONFLICT(agent, segment) DO UPDATE SET
    content = excluded.content,
    updated_at = excluded.updated_at
`);
const selectSummary = db.prepare(`SELECT content, updated_at FROM agent_summaries WHERE agent = ? AND segment = ?`);

/** Persist a per-(agent, segment) rolling summary. Use segment='*' for
 *  an agent-wide summary. Populated by the dream-consolidator agent. */
export function setSummary(agent: string, segment: string, content: string): void {
  upsertSummary.run(agent, segment, content, Date.now());
}

/** Read a per-(agent, segment) rolling summary. Returns undefined if
 *  none exists yet. Use segment='*' for the agent-wide summary. */
export function getSummary(agent: string, segment = '*'): { content: string; updatedAt: number } | undefined {
  const r = selectSummary.get(agent, segment) as { content: string; updated_at: number } | undefined;
  if (!r) return undefined;
  return { content: r.content, updatedAt: r.updated_at };
}

// ─── system phase (bootstrapping → live) ──────────────────────────────────

export type SystemPhase = 'bootstrapping' | 'live';

/** Read the current system phase. Defaults to 'bootstrapping' on first run
 *  (no phase note yet). The phase gates the curator's audit pass + the
 *  bootstrap agent's iteration loop. */
export function getPhase(): SystemPhase {
  const r = recall<SystemPhase>('system', 'phase');
  return r === 'live' ? 'live' : 'bootstrapping';
}

/** Persist the system phase. memory-keeper flips bootstrapping → live once
 *  the completeness gate passes. */
export function setPhase(p: SystemPhase): void {
  note('system', 'phase', p);
}

/** Atomically snapshot the live memory.db to `targetPath`. Uses
 *  better-sqlite3's online backup API — doesn't lock the active db,
 *  doesn't require WAL checkpoint, safe to run while agents are
 *  emitting. Returns the snapshot file size in bytes. */
export async function backupTo(targetPath: string): Promise<number> {
  await db.backup(targetPath);
  try { return (await import('node:fs')).statSync(targetPath).size; }
  catch { return 0; }
}

const sqliteVacuum = db.prepare('VACUUM');

/** Compact the underlying SQLite file. Slow-ish (full rewrite); the
 *  memory-keeper schedules it sparingly. */
export function vacuum(): void {
  sqliteVacuum.run();
}
