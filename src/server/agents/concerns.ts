import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { ConcernsFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'concerns.md'), 'utf8');

export const concernsAgent: Agent = {
  name: 'concerns',
  description: "Reads the concerns markdown file and classifies each entry as open/resolved/unmapped, linking each open one to the agent that should watch it.",
  routedFiles: [config.concernsFile],
  // Daily backstop in case the file gets edited via something the watcher
  // misses (e.g. an external sync), or as a fresh classification pass.
  intervalMs: 24 * 60 * 60 * 1000,
  run: async () => {
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 90_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('concerns', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 20).map((item) => parseFinding('concerns', item, ConcernsFindingSchema));
  },
};
