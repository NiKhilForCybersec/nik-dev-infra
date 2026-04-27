/* Resolutions-ingest agent — deterministic.
 *
 * Sister to concerns-ingest. Reads <repo>/<resolutionsFile> and
 * registers each resolution entry as a memory entity (kind:
 * resolution). Where possible, links resolution → concern via
 * fingerprint match (the user's Claude session typically quotes
 * the concern bullet when logging a fix).
 *
 * Format expected (per project_concerns_resolutions_pattern memory):
 *   ## YYYY-MM-DD — <one-line summary>
 *   - Addresses concern: "<quoted text>"
 *   - Files changed: <path>:<line>
 *   - Verification: <evidence>
 *
 * We don't enforce that exact shape — we just look for `## ` headings
 * and match concern fingerprints inside the body.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, query, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

type ParsedResolution = {
  fingerprint: string;
  heading: string;
  body: string;
  date: string | null;
  filesChanged: string[];
  rawLineNo: number;
};

function fingerprintText(text: string): string {
  // Match concerns-ingest's normalization so cross-references work.
  const norm = text
    .toLowerCase()
    .replace(/<small>[^<]*<\/small>/g, '')
    .replace(/finding [a-z0-9-]+/g, '')
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/gi, '')
    .replace(/[*_`[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function parseResolutionsBody(body: string): ParsedResolution[] {
  const lines = body.split('\n');
  const out: ParsedResolution[] = [];
  let current: ParsedResolution | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (current) out.push(current);
      const heading = headingMatch[1]!.trim();
      const dateMatch = heading.match(/^(\d{4}-\d{2}-\d{2})/);
      current = {
        // Fingerprint of the heading + date keeps each resolution
        // stable across re-runs even when the body grows.
        fingerprint: fingerprintText(heading),
        heading,
        body: '',
        date: dateMatch ? dateMatch[1]! : null,
        filesChanged: [],
        rawLineNo: i + 1,
      };
      continue;
    }
    if (!current) continue;
    current.body += line + '\n';
    // Pull file:line references out of any bullet for the
    // (resolution) modified (file) facts.
    const fileMatches = line.matchAll(/`([a-zA-Z0-9._\-/]+\.[a-zA-Z]+)(?::\d+)?`/g);
    for (const m of fileMatches) {
      if (m[1] && !current.filesChanged.includes(m[1])) current.filesChanged.push(m[1]);
    }
  }
  if (current) out.push(current);
  return out;
}

// Heuristic concern-link: scan the resolution body for a substring of
// any registered concern's text. Cheap because concern count is small
// (tens, not thousands).
function findLinkedConcerns(body: string): string[] {
  const concerns = query<{ urn: string; label: string }>(
    `SELECT urn, label FROM register WHERE agent = 'concerns-ingest' AND kind = 'concern'`,
  );
  const lower = body.toLowerCase();
  const linked: string[] = [];
  for (const c of concerns) {
    // Take the first 50 meaningful chars of the concern label and
    // look for it verbatim in the resolution body.
    const snippet = c.label.replace(/[*_`[\]()]/g, '').slice(0, 50).toLowerCase();
    if (snippet.length >= 30 && lower.includes(snippet)) {
      linked.push(c.urn);
    }
  }
  return linked;
}

export const resolutionsIngestAgent: Agent = {
  name: 'resolutions-ingest',
  description: 'Parses Resolutions.md and registers each entry as a memory entity (kind: resolution). Links to the concerns it addresses via fingerprint matching.',
  routedFiles: [config.resolutionsFile],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();
    const path = resolve(config.targetPath, config.resolutionsFile);
    if (!existsSync(path)) {
      return [{
        id: newId(),
        agent: 'resolutions-ingest',
        kind: 'resolutions-ingest:no-file',
        at: now,
        severity: 'info',
        summary: `${config.resolutionsFile} not present — nothing to ingest yet`,
      }];
    }
    let body: string;
    try { body = readFileSync(path, 'utf8'); }
    catch (e) {
      return [{
        id: newId(),
        agent: 'resolutions-ingest',
        kind: 'resolutions-ingest:read-failed',
        at: now,
        severity: 'warn',
        summary: `failed to read ${config.resolutionsFile}: ${(e as Error).message}`,
      }];
    }
    const resolutions = parseResolutionsBody(body);
    let registered = 0;
    let factsEmitted = 0;
    let linked = 0;
    for (const r of resolutions) {
      const urn = `resolution:${r.fingerprint}`;
      registerEntity({
        urn,
        kind: 'resolution',
        label: r.heading.slice(0, 120),
        agent: 'resolutions-ingest',
        confidence: 1.0,
        evidence: [`${config.resolutionsFile}:${r.rawLineNo}`, r.heading],
      });
      registered++;

      // Link resolution → files it touches.
      for (const file of r.filesChanged) {
        addFact({
          agent: 'resolutions-ingest',
          subject: urn,
          predicate: 'modified',
          object: `file:${file}`,
          evidence: [`${config.resolutionsFile}:${r.rawLineNo}`],
          confidence: 1.0,
        });
        factsEmitted++;
      }

      // Link resolution → concerns it addresses (heuristic substring match).
      const linkedConcerns = findLinkedConcerns(r.body);
      for (const concernUrn of linkedConcerns) {
        addFact({
          agent: 'resolutions-ingest',
          subject: urn,
          predicate: 'resolves',
          object: concernUrn,
          evidence: [`${config.resolutionsFile}:${r.rawLineNo}`],
          confidence: 0.85,    // heuristic match — not 100% confident the link is right
        });
        factsEmitted++;
        linked++;
      }
    }

    out.push({
      id: newId(),
      agent: 'resolutions-ingest',
      kind: 'resolutions-ingest:summary',
      at: now,
      severity: 'info',
      summary: `${resolutions.length} resolutions parsed · ${registered} registered · ${linked} concern-links · ${factsEmitted} facts`,
      payload: {
        resolutions: resolutions.length,
        registered,
        linked,
        factsEmitted,
        resolutionsFile: config.resolutionsFile,
      },
    });
    return out;
  },
};

