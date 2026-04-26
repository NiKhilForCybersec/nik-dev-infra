/* Doc-ingest agent — claude -p driven.
 *
 * Per project_canonical_vision: agents need product-intent context
 * to judge "does the code reflect what the project is supposed to
 * be?" This agent reads the watched repo's README + vision docs +
 * architecture docs and seeds a wiki page per source under the
 * `meta/intent` segment.
 *
 * Other agents (bootstrap, sync, drift, ai-coverage) can later
 * read those wiki pages via `wikiRead('meta/intent', ...)` to
 * cross-check code claims against the user's stated intent.
 *
 * Hard-path: only extracts what the doc says explicitly. The
 * prompt forbids inference / speculation; below 100% confidence
 * in what the doc states, the agent skips.
 *
 * Cost control: runs daily as a backstop, plus on doc file
 * changes via the watcher. ~10 doc files max per pass.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { newId, parseFinding, rejectedFinding } from '../findings.ts';
import { defineSegment, wikiUpsert } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';
import { DocIngestFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_BASE = readFileSync(resolve(here, 'doc-ingest.md'), 'utf8');

const DOC_FILES_PRIMARY = ['README.md', 'README', 'package.json'];
const DOC_DIR_PATTERNS = [/^vision/i, /^about/i, /^product/i, /^overview/i, /^architecture/i, /^design/i];

function findDocFiles(): string[] {
  const found: string[] = [];
  for (const f of DOC_FILES_PRIMARY) {
    const abs = resolve(config.targetPath, f);
    if (existsSync(abs)) try { if (statSync(abs).isFile()) found.push(f); } catch { /* */ }
  }
  const docsDir = resolve(config.targetPath, 'docs');
  if (existsSync(docsDir)) {
    let names: string[] = [];
    try { names = readdirSync(docsDir); } catch { /* */ }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const stem = name.replace(/\.md$/, '');
      if (DOC_DIR_PATTERNS.some((re) => re.test(stem))) {
        found.push(`docs/${name}`);
      }
    }
  }
  return found.slice(0, 10);
}

export const docIngestAgent: Agent = {
  name: 'doc-ingest',
  description: "Reads README + vision/architecture docs; extracts product intent into the meta/intent wiki segment.",
  routedFiles: [
    'README.md',
    'README',
    'docs/**/*.md',
    'package.json',
  ],
  intervalMs: 24 * 60 * 60 * 1000,
  run: async () => {
    const docs = findDocFiles();
    if (docs.length === 0) {
      return [{
        id: newId(),
        agent: 'doc-ingest',
        kind: 'doc-ingest:no-docs',
        at: Date.now(),
        severity: 'info',
        summary: 'no README / vision / architecture docs found in target',
      }];
    }

    defineSegment({ name: 'meta/intent', description: 'product intent extracted from the watched repo\'s docs', ownerAgent: 'doc-ingest' });

    // Build the prompt with each doc's content inlined (capped at 4 KB each
    // to keep the prompt size sane).
    const inputBlocks = docs.map((rel) => {
      const abs = resolve(config.targetPath, rel);
      let body = '';
      try { body = readFileSync(abs, 'utf8'); } catch { return null; }
      return `### ${rel}\n\`\`\`\n${body.slice(0, 4_000)}\n\`\`\`\n`;
    }).filter((x): x is string => x !== null);

    if (inputBlocks.length === 0) {
      return [{
        id: newId(),
        agent: 'doc-ingest',
        kind: 'doc-ingest:read-failed',
        at: Date.now(),
        severity: 'warn',
        summary: `found ${docs.length} doc files but none could be read`,
      }];
    }

    const prompt = `${PROMPT_BASE}

---

## Input — eligible docs

${inputBlocks.join('\n')}
`;

    const findings: Finding[] = [];
    try {
      const r = await runClaude({ prompt, timeoutMs: 180_000 });
      const raw = parseJsonArray<unknown>(r.text);
      if (raw === null) {
        if (r.text.trim().length > 0) findings.push(rejectedFinding('doc-ingest', 'output not a parseable JSON array', { textPreview: r.text.slice(0, 500) }));
      } else {
        for (const item of raw.slice(0, 10)) {
          const f = parseFinding('doc-ingest', item, DocIngestFindingSchema);
          findings.push(f);
          // If this is a successful summary with wiki content, write it.
          const p = f.payload as { wikiSegment?: string; wikiTopic?: string; wikiContent?: string; evidence?: string[] } | undefined;
          if (f.kind === 'doc-ingest:summary' && p?.wikiSegment === 'meta/intent' && typeof p.wikiTopic === 'string' && typeof p.wikiContent === 'string') {
            try {
              wikiUpsert({
                segment: 'meta/intent',
                topic: p.wikiTopic,
                content: p.wikiContent,
                agent: 'doc-ingest',
                confidence: 1.0,
                evidence: p.evidence ?? [],
              });
            } catch { /* swallow — caller already has the summary finding */ }
          }
        }
      }
    } catch (e) {
      findings.push({
        id: newId(),
        agent: 'doc-ingest',
        kind: 'doc-ingest:read-failed',
        at: Date.now(),
        severity: 'warn',
        summary: `doc-ingest pass failed: ${(e as Error).message}`,
      });
    }
    return findings;
  },
};
