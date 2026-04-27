/* Concerns-ingest agent — deterministic.
 *
 * Reads <repo>/<concernsFile> and turns each bullet into a first-
 * class memory entity (kind: concern), keyed on a stable text
 * fingerprint so re-runs upsert instead of duplicating. Emits
 * `(concern) targets (file)` facts when a fileRef is present in
 * the bullet, and `(concern) raised_in (segment)` when the bullet
 * lives under an obvious heading.
 *
 * Why a separate agent (vs. just letting the curator parse Concerns):
 * the curator AUDITS concerns (verifies they're real, flags stale).
 * This agent INGESTS them — every bullet becomes a queryable entity
 * the MCP server can return + the auto-fix-driver can target. It's
 * the bridge from human markdown → memory graph.
 *
 * Hard-path: only emits when the bullet has at least 30 chars of
 * stripped text (matches auto-fix-driver's minimum-viability gate).
 * Severity inferred from **ERROR** / **WARN** markers; defaults to
 * info.
 *
 * Cadence: 5min interval + routedFiles on Concerns.md (re-ingest
 * within seconds of a user edit).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, registerEntity } from '../memory.ts';
import type { Agent, Finding, Severity } from '../types.ts';

type ParsedBullet = {
  fingerprint: string;
  text: string;
  severity: Severity;
  fileRef: string | null;
  rawLineNo: number;
  parentHeading: string | null;
};

function fingerprint(text: string): string {
  // Same normalization the auto-fix-driver uses — strips timestamps,
  // finding ids, markdown decoration, whitespace. Consistent
  // fingerprint across the system.
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

function parseConcernsBody(body: string): ParsedBullet[] {
  const lines = body.split('\n');
  const out: ParsedBullet[] = [];
  let parentHeading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,6}\s+/.test(line)) {
      parentHeading = line.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }
    if (!line.startsWith('- ')) continue;
    const text = line.slice(2).trim();
    if (text.replace(/[*_`[\]()<>]/g, '').trim().length < 30) continue;
    let severity: Severity = 'info';
    if (/\*\*ERROR\*\*/i.test(text)) severity = 'error';
    else if (/\*\*WARN\*\*/i.test(text)) severity = 'warn';
    let fileRef: string | null = null;
    const m = text.match(/`([^`]+\.[a-zA-Z]+)(?::\d+)?`/);
    if (m) fileRef = m[1] ?? null;
    out.push({
      fingerprint: fingerprint(text),
      text,
      severity,
      fileRef,
      rawLineNo: i + 1,
      parentHeading,
    });
  }
  return out;
}

export const concernsIngestAgent: Agent = {
  name: 'concerns-ingest',
  description: 'Parses Concerns.md and registers each bullet as a first-class memory entity (kind: concern), keyed by stable fingerprint. Bridge from human markdown to the memory graph.',
  routedFiles: [config.concernsFile],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();
    const concernsPath = resolve(config.targetPath, config.concernsFile);
    if (!existsSync(concernsPath)) {
      return [{
        id: newId(),
        agent: 'concerns-ingest',
        kind: 'concerns-ingest:no-file',
        at: now,
        severity: 'info',
        summary: `${config.concernsFile} not present — nothing to ingest`,
      }];
    }
    let body: string;
    try { body = readFileSync(concernsPath, 'utf8'); }
    catch (e) {
      return [{
        id: newId(),
        agent: 'concerns-ingest',
        kind: 'concerns-ingest:read-failed',
        at: now,
        severity: 'warn',
        summary: `failed to read ${config.concernsFile}: ${(e as Error).message}`,
      }];
    }

    const bullets = parseConcernsBody(body);
    let registered = 0;
    let factsEmitted = 0;
    for (const b of bullets) {
      const urn = `concern:${b.fingerprint}`;
      const sevWeight: Record<Severity, number> = { info: 0.7, warn: 0.85, error: 1.0 };
      registerEntity({
        urn,
        kind: 'concern',
        label: b.text.slice(0, 120),
        ...(b.fileRef ? { file: b.fileRef } : {}),
        ...(b.parentHeading ? { segment: `concerns/${b.parentHeading.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}` } : {}),
        agent: 'concerns-ingest',
        confidence: sevWeight[b.severity],
        evidence: [`${config.concernsFile}:${b.rawLineNo}`, b.text.slice(0, 200)],
      });
      registered++;

      // Link concern → file when a fileRef is present.
      if (b.fileRef) {
        addFact({
          agent: 'concerns-ingest',
          subject: urn,
          predicate: 'targets',
          object: `file:${b.fileRef}`,
          evidence: [`${config.concernsFile}:${b.rawLineNo}`],
          confidence: 1.0,
        });
        factsEmitted++;
      }
      // Link concern → parent heading segment.
      if (b.parentHeading) {
        addFact({
          agent: 'concerns-ingest',
          subject: urn,
          predicate: 'raised_in',
          object: `section:${b.parentHeading.slice(0, 80)}`,
          evidence: [`${config.concernsFile}:${b.rawLineNo}`],
          confidence: 1.0,
        });
        factsEmitted++;
      }
    }

    out.push({
      id: newId(),
      agent: 'concerns-ingest',
      kind: 'concerns-ingest:summary',
      at: now,
      severity: 'info',
      summary: `${bullets.length} bullets parsed · ${registered} concerns registered · ${factsEmitted} facts emitted`,
      payload: {
        bullets: bullets.length,
        registered,
        factsEmitted,
        concernsFile: config.concernsFile,
      },
    });
    return out;
  },
};
