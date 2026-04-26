/* AI-coverage agent — claude -p driven.
 *
 * Every screen manifest declares the ops it writes + the commands
 * it dispatches + the natural-language `aiAffordances` phrases
 * the app's AI agent should be able to handle for that screen.
 *
 * The rule (per project_ai_affordance_agent memory): every write
 * op + every command on a screen must have at least one
 * aiAffordances phrase that plausibly triggers it. Manual-only
 * actions are AI-coverage gaps the user has to do by hand.
 *
 * This agent reviews manifests in batches, asks claude -p to
 * judge coverage, and emits findings for the gaps.
 *
 * Hard-path: only emit a gap when 100% sure no affordance maps —
 * including liberal interpretation of generic phrases. False
 * gaps erode trust; real gaps unlock real product value.
 *
 * Cost control: 5 manifests per run, picked by mtime so recently-
 * touched manifests are reviewed first. Manifest changes route a
 * re-run via the watcher.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { AiCoverageFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_BASE = readFileSync(resolve(here, 'ai-coverage.md'), 'utf8');

const PER_RUN_MANIFESTS = 5;

function pickRecentManifests(): string[] {
  if (!config.manifestsGlob) return [];
  // The glob looks like `web/src/screens/*.manifest.ts`. Walk that dir.
  const dir = resolve(config.targetPath, dirname(config.manifestsGlob));
  let entries: string[];
  try { entries = readdirSync(dir).filter((f) => f.endsWith('.manifest.ts')); }
  catch { return []; }
  return entries
    .map((f) => ({ f, m: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, PER_RUN_MANIFESTS)
    .map((e) => `${dirname(config.manifestsGlob!)}/${e.f}`);
}

export const aiCoverageAgent: Agent = {
  name: 'ai-coverage',
  description: 'Catches ops/commands a screen exposes manually but the AI agent has no aiAffordances phrase for.',
  routedFiles: [
    ...(config.manifestsGlob ? [config.manifestsGlob] : []),
    ...(config.contractsDir ? [`${config.contractsDir}/*.ts`] : []),
  ],
  intervalMs: 0,
  run: async () => {
    const manifests = pickRecentManifests();
    if (manifests.length === 0) {
      return [];
    }
    const prompt = `${PROMPT_BASE}

---

## Input — manifests to review (newest-first by mtime)

${manifests.map((m) => `- ${m}`).join('\n')}

`;
    const r = await runClaude({ prompt, timeoutMs: 150_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('ai-coverage', 'agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 25).map((item) => parseFinding('ai-coverage', item, AiCoverageFindingSchema));
  },
};
