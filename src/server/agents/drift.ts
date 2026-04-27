import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import { buildProjectGrounding, renderProjectGrounding } from '../grounding.ts';
import type { Agent } from '../types.ts';
import { DriftFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'drift.md'), 'utf8');

export const driftAgent: Agent = {
  name: 'drift',
  description: 'Spots manifest ↔ JSX wiring drift, including semantic mismatches static analysis misses.',
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/screens/*.manifest.ts',
    'web/src/contracts/*.ts',
    'web/src/components/ItemsListScreen.tsx',
  ],
  intervalMs: 0,
  run: async () => {
    const grounding = renderProjectGrounding(buildProjectGrounding());
    const r = await runClaude({ prompt: grounding + PROMPT, timeoutMs: 120_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('drift', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 10).map((item) => parseFinding('drift', item, DriftFindingSchema));
  },
};
