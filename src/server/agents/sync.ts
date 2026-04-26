import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { SyncFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'sync.md'), 'utf8');

export const syncAgent: Agent = {
  name: 'sync',
  description: 'Catches cross-screen value disagreement — same metric, different op / hardcoded / different formula.',
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/screens/*.manifest.ts',
    'web/src/contracts/*.ts',
  ],
  // Sync issues compound; weekly backstop catches drift even when no
  // file edit triggered a run (e.g. rare ops only invoked at runtime).
  intervalMs: 6 * 60 * 60 * 1000,
  run: async () => {
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 180_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('sync', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 10).map((item) => parseFinding('sync', item, SyncFindingSchema));
  },
};
