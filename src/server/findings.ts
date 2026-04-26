/* Append-only findings log + in-memory ring buffer.
 *
 * Every finding is written to data/findings.jsonl on disk (one JSON
 * per line — easy to grep, easy to tail) AND held in a 500-deep
 * memory ring for the snapshot endpoint + WebSocket broadcasts.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentRun, Finding } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../data');
const LOG_FILE = resolve(DATA_DIR, 'findings.jsonl');
const RING_MAX = 500;
const RUNS_MAX = 200;

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const ring: Finding[] = [];
const runs: AgentRun[] = [];
const listeners = new Set<(f: Finding) => void>();
const runListeners = new Set<(r: AgentRun) => void>();

// Hydrate from disk on boot — last RING_MAX findings give the UI
// instant continuity across daemon restarts.
if (existsSync(LOG_FILE)) {
  try {
    const lines = readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-RING_MAX)) {
      try { ring.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  } catch (e) {
    console.warn('[findings] could not hydrate from disk', e);
  }
}

export function emit(finding: Finding): void {
  ring.push(finding);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
  appendFileSync(LOG_FILE, JSON.stringify(finding) + '\n');
  for (const fn of listeners) fn(finding);
}

export function emitRun(run: AgentRun): void {
  runs.push(run);
  if (runs.length > RUNS_MAX) runs.splice(0, runs.length - RUNS_MAX);
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
