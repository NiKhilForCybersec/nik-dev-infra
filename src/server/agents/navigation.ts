import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import { buildProjectGrounding, renderProjectGrounding } from '../grounding.ts';
import type { Agent } from '../types.ts';
import { NavigationFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'navigation.md'), 'utf8');

export const navigationAgent: Agent = {
  name: 'navigation',
  description: "Validates onNav() targets, MoreScreen tiles, and routes — catches the 'tile points to wrong screen' bug class.",
  routedFiles: [
    'web/src/screens/*.tsx',
    'web/src/types/app-state.ts',
    'web/src/App.tsx',
  ],
  intervalMs: 0,
  run: async () => {
    const grounding = renderProjectGrounding(buildProjectGrounding());
    const r = await runClaude({ prompt: grounding + PROMPT, timeoutMs: 90_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('navigation', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 10).map((item) => parseFinding('navigation', item, NavigationFindingSchema));
  },
};
