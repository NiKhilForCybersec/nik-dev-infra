import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding, Severity } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT = readFileSync(resolve(here, 'navigation.md'), 'utf8');

type RawFinding = {
  kind: string;
  severity: Severity;
  file?: string;
  line?: number;
  summary: string;
  suggestion?: string;
};

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
    const r = await runClaude({ prompt: PROMPT, timeoutMs: 90_000 });
    const raw = parseJsonArray<RawFinding>(r.text) ?? [];
    return raw.slice(0, 10).map<Finding>((f) => ({
      id: newId(),
      agent: 'navigation',
      kind: f.kind || 'navigation',
      at: Date.now(),
      severity: f.severity || 'warn',
      summary: f.summary,
      ...(f.file ? { file: f.file } : {}),
      ...(f.line ? { line: f.line } : {}),
      ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    }));
  },
};
