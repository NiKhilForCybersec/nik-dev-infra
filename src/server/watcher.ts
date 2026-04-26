/* File watcher over ~/NIK using chokidar.
 *
 * Emits 'change' events with a relative path. The orchestrator
 * subscribes + dispatches relevant agents (debounced).
 */

import chokidar from 'chokidar';
import { resolve } from 'node:path';
import { NIK_PATH } from './claude.ts';

export type WatchEvent = {
  kind: 'add' | 'change' | 'unlink';
  /** Path relative to ~/NIK. */
  rel: string;
  /** Absolute path. */
  abs: string;
};

const WATCH_TARGETS = [
  'web/src/**/*.{ts,tsx}',
  'web/public/*',
  'supabase/migrations/*.sql',
  'docs/**/*.md',
  'packages/**/*.{ts,tsx}',
];

export function startWatcher(onEvent: (e: WatchEvent) => void): { stop: () => void } {
  const targets = WATCH_TARGETS.map((p) => resolve(NIK_PATH, p));
  const watcher = chokidar.watch(targets, {
    ignored: [/node_modules/, /\/\.git\//, /\/dist\//],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  for (const kind of ['add', 'change', 'unlink'] as const) {
    watcher.on(kind, (abs) => {
      const rel = abs.startsWith(NIK_PATH) ? abs.slice(NIK_PATH.length + 1) : abs;
      onEvent({ kind, rel, abs });
    });
  }

  return { stop: () => void watcher.close() };
}
