/* Bindings agent — claude -p driven.
 *
 * Pins every JSX dynamic expression on a screen back to the exact
 * (op, field) pair it reads. The graph + sync agents already
 * track screen→op edges at the manifest level; this agent goes
 * one level deeper — which TEXT FIELD on the screen reads which
 * SPECIFIC FIELD of which op.
 *
 * Output is high-resolution wiring data the playground (D.15)
 * and the prober agents (D.8-D.11) will use to confirm "this
 * exact rendered number actually came from this op call".
 *
 * Hard-path: only emit a `binding:found` when the source is
 * traced through useOp(...) destructuring to a specific field.
 * `binding:uncertain` for anything below 100% confidence.
 *
 * Cost control: claude -p calls are expensive. The agent picks
 * the 3 most-recently-changed screens per run (via file mtime),
 * NOT all 60. File changes routed via the watcher trigger
 * targeted re-runs over time.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import type { Agent } from '../types.ts';
import { BindingsFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_BASE = readFileSync(resolve(here, 'bindings.md'), 'utf8');

const PER_RUN_SCREENS = 3;

function pickRecentScreens(): string[] {
  if (!config.screensGlob) return [];
  const screensDir = resolve(config.targetPath, dirname(config.screensGlob));
  let entries: string[];
  try { entries = readdirSync(screensDir).filter((f) => f.endsWith('Screen.tsx')); }
  catch { return []; }
  return entries
    .map((f) => ({ f, m: statSync(resolve(screensDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, PER_RUN_SCREENS)
    .map((e) => `${dirname(config.screensGlob!)}/${e.f}`);
}

export const bindingsAgent: Agent = {
  name: 'bindings',
  description: 'Pins each JSX dynamic value on a screen to the exact op.field it reads. High-resolution wiring data.',
  routedFiles: [
    ...(config.screensGlob ? [config.screensGlob] : []),
    ...(config.contractsDir ? [`${config.contractsDir}/*.ts`] : []),
  ],
  intervalMs: 0,
  run: async () => {
    const screens = pickRecentScreens();
    if (screens.length === 0) {
      return [];
    }
    const prompt = `${PROMPT_BASE}

---

## Input — focus on these screens (newest-first by mtime)

${screens.map((s) => `- ${s}`).join('\n')}

`;
    const r = await runClaude({ prompt, timeoutMs: 180_000 });
    const raw = parseJsonArray<unknown>(r.text);
    if (raw === null) {
      if (r.text.trim().length === 0) return [];
      return [rejectedFinding('bindings', 'agent output was not a parseable JSON array', { textPreview: r.text.slice(0, 500) })];
    }
    return raw.slice(0, 20).map((item) => parseFinding('bindings', item, BindingsFindingSchema));
  },
};
