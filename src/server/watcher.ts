/* File watcher over the target repo using chokidar.
 *
 * Emits 'change' events with a relative path. The orchestrator
 * subscribes + dispatches relevant agents (debounced).
 */

import chokidar from 'chokidar';
import { resolve } from 'node:path';
import { config } from './config.ts';

export type WatchEvent = {
  kind: 'add' | 'change' | 'unlink';
  /** Path relative to the watched repo's root. */
  rel: string;
  /** Absolute path. */
  abs: string;
};

export function startWatcher(onEvent: (e: WatchEvent) => void): { stop: () => void } {
  const targets = config.watchGlobs.map((p) => resolve(config.targetPath, p));
  const watcher = chokidar.watch(targets, {
    ignored: [/node_modules/, /\/\.git\//, /\/dist\//],
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  for (const kind of ['add', 'change', 'unlink'] as const) {
    watcher.on(kind, (abs) => {
      const root = config.targetPath;
      const rel = abs.startsWith(root) ? abs.slice(root.length + 1) : abs;
      onEvent({ kind, rel, abs });
    });
  }

  return { stop: () => void watcher.close() };
}
