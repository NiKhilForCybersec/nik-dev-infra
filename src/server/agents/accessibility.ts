import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { AccessibilityFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'accessibility.md'), 'utf8');

export const accessibilityAgent: Agent = {
  name: 'accessibility',
  description: 'Flags icon-only buttons w/o aria-label, color-only state, tiny tap targets, missing alts, keyboard traps.',
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/components/*.tsx',
  ],
  intervalMs: 0,
  run: async () => {
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 120_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('accessibility', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 12).map((item) => parseFinding('accessibility', item, AccessibilityFindingSchema));
  },
};
