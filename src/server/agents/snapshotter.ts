/* Snapshotter agent — deterministic.
 *
 * Per data/self-concerns: catastrophic data loss is one rm -rf
 * away. This agent runs every 6 hours, takes an atomic backup of
 * memory.db via better-sqlite3's online backup API (doesn't lock
 * the active db; safe while agents emit), and prunes the snapshot
 * directory to KEEP_N most-recent.
 *
 * No claude -p. No external network. Pure local filesystem.
 *
 * Output:
 *   snapshot:created    info  — snapshot landed; size in bytes
 *   snapshot:pruned     info  — older snapshots removed (paired)
 *   snapshot:failed     warn  — backup or stat threw
 */

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupTo } from '../memory.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(here, '../../../data');
const SNAPSHOT_DIR = resolve(DATA_DIR, 'snapshots');

const KEEP_N = 10;
const FILENAME_PATTERN = /^memory\.\d{4}-\d{2}-\d{2}-\d{4}\.db$/;

function timestampFilename(d: Date = new Date()): string {
  const z = (n: number) => n.toString().padStart(2, '0');
  return `memory.${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.db`;
}

function listSnapshots(): Array<{ name: string; abs: string; mtimeMs: number }> {
  if (!existsSync(SNAPSHOT_DIR)) return [];
  let entries: string[];
  try { entries = readdirSync(SNAPSHOT_DIR); } catch { return []; }
  return entries
    .filter((n) => FILENAME_PATTERN.test(n))
    .map((n) => {
      const abs = resolve(SNAPSHOT_DIR, n);
      let mtimeMs = 0;
      try { mtimeMs = statSync(abs).mtimeMs; } catch { /* */ }
      return { name: n, abs, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export const snapshotterAgent: Agent = {
  name: 'snapshotter',
  description: 'Atomic memory.db backups every 6h to data/snapshots/; keeps newest 10, prunes the rest.',
  routedFiles: [],
  intervalMs: 6 * 60 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });

    const target = resolve(SNAPSHOT_DIR, timestampFilename());
    try {
      const sizeBytes = await backupTo(target);
      out.push({
        id: newId(),
        agent: 'snapshotter',
        kind: 'snapshot:created',
        at: Date.now(),
        severity: 'info',
        summary: `memory.db snapshot · ${(sizeBytes / 1024 / 1024).toFixed(2)} MB · data/snapshots/${timestampFilename(new Date())}`,
        payload: { path: `data/snapshots/${timestampFilename(new Date())}`, sizeBytes },
      });
    } catch (e) {
      out.push({
        id: newId(),
        agent: 'snapshotter',
        kind: 'snapshot:failed',
        at: Date.now(),
        severity: 'warn',
        summary: `snapshot failed: ${(e as Error).message}`,
        payload: { error: (e as Error).message },
      });
      return out;
    }

    // Prune: keep newest KEEP_N, delete older ones.
    const all = listSnapshots();
    if (all.length > KEEP_N) {
      let pruned = 0;
      for (const stale of all.slice(KEEP_N)) {
        try { unlinkSync(stale.abs); pruned++; } catch { /* permission / race */ }
      }
      if (pruned > 0) {
        out.push({
          id: newId(),
          agent: 'snapshotter',
          kind: 'snapshot:pruned',
          at: Date.now(),
          severity: 'info',
          summary: `pruned ${pruned} older snapshot${pruned === 1 ? '' : 's'} (kept newest ${KEEP_N})`,
          payload: { pruned, keepN: KEEP_N, retained: all.length - pruned },
        });
      }
    }

    return out;
  },
};
