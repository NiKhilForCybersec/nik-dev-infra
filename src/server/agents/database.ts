import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { DatabaseFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'database.md'), 'utf8');

export const databaseAgent: Agent = {
  name: 'database',
  description: 'Catches contract↔migration drift — column/type mismatches, missing RLS, missing user_id indexes.',
  routedFiles: [
    'supabase/migrations/*.sql',
    'web/src/contracts/*.ts',
  ],
  // Migrations land rarely; an hourly sweep catches drift even when no
  // file changed (e.g. someone tweaked a contract without a migration).
  intervalMs: 60 * 60 * 1000,
  run: async () => {
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 180_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('database', 'Agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 10).map((item) => parseFinding('database', item, DatabaseFindingSchema));
  },
};
