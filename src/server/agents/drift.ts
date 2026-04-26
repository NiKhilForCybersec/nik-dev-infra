import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding, Severity } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'drift.md'), 'utf8');

type RawFinding = {
  kind: string;
  severity: Severity;
  file?: string;
  line?: number;
  summary: string;
  suggestion?: string;
};

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
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 120_000 });
    const raw = parseJsonArray<RawFinding>(r.text) ?? [];
    return raw.slice(0, 10).map<Finding>((f) => ({
      id: newId(),
      agent: 'drift',
      kind: f.kind || 'drift',
      at: Date.now(),
      severity: f.severity || 'warn',
      summary: f.summary,
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    }));
  },
};
