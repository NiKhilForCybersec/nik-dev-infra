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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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

  CREATE TABLE IF NOT EXISTS notes (
    agent      TEXT NOT NULL,
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (agent, key)
  );
  CREATE INDEX IF NOT EXISTS idx_notes_agent ON notes(agent);

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
`);

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

/** Aggregate stats — used by the /api/memory endpoint and the UI panel
 *  later in this phase. */
export function memoryStats(): { findings: number; notes: number; facts: number; sizeBytes: number } {
  const f = (db.prepare('SELECT COUNT(*) AS n FROM findings').get() as { n: number }).n;
  const n = (db.prepare('SELECT COUNT(*) AS n FROM notes').get()    as { n: number }).n;
  const c = (db.prepare('SELECT COUNT(*) AS n FROM facts').get()    as { n: number }).n;
  let size = 0;
  try {
    const stat = (db.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as { size: number });
    size = stat.size;
  } catch { /* */ }
  return { findings: f, notes: n, facts: c, sizeBytes: size };
}

/** Escape hatch for richer queries (e.g. dashboards, the meta-agent).
 *  Read-only — write paths must go through the typed helpers above. */
export function query<T = unknown>(sql: string, params: unknown[] = []): T[] {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error('memory.query is read-only — use the typed helpers for writes');
  }
  return db.prepare(sql).all(...params) as T[];
}
