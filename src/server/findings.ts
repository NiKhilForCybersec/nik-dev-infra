/* Append-only findings log + in-memory ring buffer.
 *
 * Every finding is written to data/findings.jsonl on disk (one JSON
 * per line — easy to grep, easy to tail) AND held in a 500-deep
 * memory ring for the snapshot endpoint + WebSocket broadcasts.
 *
 * Rotation: when findings.jsonl exceeds ROTATION_BYTES (10 MB) it's
 * renamed to findings.YYYY-MM-DD.jsonl (with -N suffix on collision).
 * Boot hydration only tail-reads the active file, so an archive of
 * 100k+ historical findings doesn't slow startup.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { recordFinding, recordRun } from './memory.ts';
import type { AgentRun, Finding } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
// DATA_DIR can be overridden for tests / sandboxing via DEV_INFRA_DATA_DIR.
const DATA_DIR = process.env.DEV_INFRA_DATA_DIR
  ? resolve(process.env.DEV_INFRA_DATA_DIR)
  : resolve(here, '../../data');
const LOG_FILE = resolve(DATA_DIR, 'findings.jsonl');
const RING_MAX = 500;
const RUNS_MAX = 200;
const ROTATION_BYTES = 10 * 1024 * 1024;        // 10 MB
const TAIL_BYTES = 256 * 1024;                   // ~500 lines @ ~512 b each

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const ring: Finding[] = [];
const runs: AgentRun[] = [];
const listeners = new Set<(f: Finding) => void>();
const runListeners = new Set<(r: AgentRun) => void>();

// Bytes already on disk in the active file. Tracked in-process so emit()
// avoids a statSync per call. Initialized once from disk at boot.
let activeBytes = 0;
if (existsSync(LOG_FILE)) {
  try { activeBytes = statSync(LOG_FILE).size; } catch { /* */ }
}

// Hydrate the ring from the tail of the active file only — archives are
// not read at boot, so 100k+ historical findings have zero startup cost.
// Each hydrated finding is also mirrored into the memory index in case
// the SQLite db lags the JSONL (e.g. fresh checkout, or older findings
// from before the memory layer existed).
for (const line of tailLines(LOG_FILE, RING_MAX)) {
  try {
    const f = JSON.parse(line) as Finding;
    ring.push(f);
    recordFinding(f);
  } catch { /* skip malformed */ }
}

export function emit(finding: Finding): void {
  ring.push(finding);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  rotateIfNeeded();
  const line = JSON.stringify(finding) + '\n';
  appendFileSync(LOG_FILE, line);
  activeBytes += Buffer.byteLength(line);
  recordFinding(finding);
  for (const fn of listeners) fn(finding);
}

export function emitRun(run: AgentRun): void {
  runs.push(run);
  if (runs.length > RUNS_MAX) runs.splice(0, runs.length - RUNS_MAX);
  recordRun(run);
  for (const fn of runListeners) fn(run);
}

export function snapshot(): { findings: Finding[]; runs: AgentRun[] } {
  return { findings: ring.slice(), runs: runs.slice() };
}

export function onFinding(fn: (f: Finding) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function onRun(fn: (r: AgentRun) => void): () => void {
  runListeners.add(fn);
  return () => runListeners.delete(fn);
}

/** Generate a sortable, mostly-unique id. */
export function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Build a schema-rejected Finding for output that isn't even a parseable
 *  JSON array — distinct from output that parses but fails schema. */
export function rejectedFinding(agent: string, summary: string, payload?: Record<string, unknown>): Finding {
  return {
    id: newId(),
    agent,
    kind: 'schema-rejected',
    at: Date.now(),
    severity: 'warn',
    summary,
    ...(payload ? { payload } : {}),
  };
}

/** Validate raw agent output against a Zod schema and return a Finding.
 *  Malformed output produces a `schema-rejected` finding rather than a
 *  thrown error — the agent stays alive and the bad payload is logged. */
export function parseFinding<S extends z.ZodTypeAny>(
  agent: string,
  raw: unknown,
  schema: S,
): Finding {
  const r = schema.safeParse(raw);
  if (r.success) {
    const f = r.data as {
      kind: string;
      severity: 'info' | 'warn' | 'error';
      summary: string;
      file?: string;
      line?: number;
      suggestion?: string;
      payload?: Record<string, unknown>;
    };
    return {
      id: newId(),
      agent,
      kind: f.kind,
      at: Date.now(),
      severity: f.severity,
      summary: f.summary,
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
      ...(f.payload ? { payload: f.payload } : {}),
    };
  }
  const issues = r.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  console.warn(`[findings] ${agent} produced malformed output:`, issues);
  return {
    id: newId(),
    agent,
    kind: 'schema-rejected',
    at: Date.now(),
    severity: 'warn',
    summary: `Agent output failed schema validation — ${issues.slice(0, 240)}`,
    payload: { raw, issues: r.error.issues },
  };
}

/** Rename the active log to findings.YYYY-MM-DD.jsonl (with -N collision
 *  suffix) when it crosses ROTATION_BYTES. Resets activeBytes. */
function rotateIfNeeded(): void {
  if (activeBytes < ROTATION_BYTES) return;
  const date = new Date().toISOString().slice(0, 10);
  let target = resolve(DATA_DIR, `findings.${date}.jsonl`);
  let n = 0;
  while (existsSync(target)) {
    n++;
    target = resolve(DATA_DIR, `findings.${date}.${n}.jsonl`);
  }
  try {
    renameSync(LOG_FILE, target);
    console.log(`[findings] rotated → ${basename(target)} (${activeBytes} bytes)`);
  } catch (e) {
    console.warn('[findings] rotation failed:', (e as Error).message);
    return;
  }
  activeBytes = 0;
}

/** Read the last `maxLines` complete lines from `file` without slurping
 *  the whole thing. We grab the last TAIL_BYTES, drop the leading
 *  partial line (unless we started at 0), and keep only the tail. */
function tailLines(file: string, maxLines: number): string[] {
  if (!existsSync(file)) return [];
  let stats;
  try { stats = statSync(file); } catch { return []; }
  if (stats.size === 0) return [];
  const start = Math.max(0, stats.size - TAIL_BYTES);
  const len = stats.size - start;
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, start);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lines = text.split('\n').filter(Boolean);
  if (start > 0 && lines.length > 0) lines.shift();
  return lines.slice(-maxLines);
}
