import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import { buildProjectGrounding, renderProjectGrounding } from '../grounding.ts';
import type { Agent } from '../types.ts';
import { HardcodedFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'hardcoded.md'), 'utf8');

export const hardcodedAgent: Agent = {
  name: 'hardcoded',
  description: "Catches JSX literals that LOOK like live user data but are hardcoded. Beats regex by reasoning about whether a literal should be derived.",
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/components/*.tsx',
    'docs/Concerns.md',
  ],
  intervalMs: 0,
  run: async () => {
    const grounding = renderProjectGrounding(buildProjectGrounding());
    const r = await runClaude({ prompt: grounding + PROMPT, timeoutMs: 150_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('hardcoded', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 15).map((item) => parseFinding('hardcoded', item, HardcodedFindingSchema));
  },
};
