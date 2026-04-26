/* Memory-keeper agent — deterministic.
 *
 * Owner of the persistent memory layer's integrity. Every 10 minutes
 * it scans all six memory tables (findings, notes, facts, segments,
 * register, hooks, wiki_pages, wiki_revisions) for:
 *
 *   - integrity violations: orphan facts (subject/object URN not
 *     in the register), wiki pages for non-existent segments,
 *     hooks pointing to disabled / unknown agents, low-confidence
 *     facts (hard-path: should be 1.0).
 *   - completeness: how close the model is to "100%-confident".
 *     Reported as percentages per dimension (entities w/ evidence,
 *     segments w/ wiki, screens w/ at least one outbound edge).
 *   - bloat: wiki_revisions per topic capped at 100; older rows
 *     pruned. Periodic VACUUM (daily) compacts the file.
 *
 * Hard-path: every issue is one finding with the exact URN /
 * (segment, topic) / hook id, never a vague "memory looks weird".
 * The keeper never auto-fixes integrity issues silently — it
 * surfaces them. The only autonomous action is bounded pruning of
 * wiki_revisions and SQLite VACUUM.
 *
 * Memory-keeper is itself the owner_agent for the `meta/memory`
 * segment (defined on first run).
 */

import { newId } from '../findings.ts';
import {
  defineSegment,
  getPhase,
  listHooks,
  listSegments,
  memoryStats,
  pruneRevisions,
  query,
  setPhase,
  vacuum,
  wikiList,
} from '../memory.ts';
import type { Agent, Finding } from '../types.ts';
// NOTE: avoid a static import of ALL_AGENTS — that creates a TDZ cycle
// (index.ts imports this file, this file imports index.ts). The agent
// list is loaded inside run() via dynamic import, which executes after
// the module graph is fully initialized.

const REVISIONS_KEEP = 100;
const VACUUM_EVERY_MS = 24 * 60 * 60 * 1000;
let lastVacuumAt = 0;
let bootstrapped = false;

function ensureSegments(): void {
  if (bootstrapped) return;
  defineSegment({ name: 'meta',         description: 'meta-system: memory, scheduling, agent ownership', ownerAgent: 'memory-keeper' });
  defineSegment({ name: 'meta/memory',  description: 'persistent memory layer integrity + pruning',      ownerAgent: 'memory-keeper' });
  bootstrapped = true;
}

export const memoryKeeperAgent: Agent = {
  name: 'memory-keeper',
  description: 'Owns the memory layer: integrity, completeness, pruning. Catches orphan facts/hooks/wiki and stale rows.',
  routedFiles: [],                       // memory-only; not driven by file changes
  intervalMs: 10 * 60 * 1000,
  run: async () => {
    ensureSegments();
    const findings: Finding[] = [];
    const { ALL_AGENTS } = await import('./index.ts');
    const knownAgents = new Set(ALL_AGENTS.map((a) => a.name));

    // ── 1. Orphan facts: subject or object URN not in register ───────────
    // Gate orphan flagging on phase: during bootstrap the register is
    // still being populated, so transient orphans are normal noise.
    // Once the system is live, orphans are real drift signal.
    const phaseNow = getPhase();
    const orphanSubjects = phaseNow === 'live' ? query<{ subject: string; n: number }>(`
      SELECT subject, COUNT(*) AS n FROM facts
      WHERE subject NOT IN (SELECT urn FROM register)
      GROUP BY subject
      ORDER BY n DESC
      LIMIT 5
    `) : [];
    for (const row of orphanSubjects) {
      findings.push({
        id: newId(),
        agent: 'memory-keeper',
        kind: 'memory:orphan-fact-subject',
        at: Date.now(),
        severity: 'warn',
        summary: `${row.n} fact${row.n === 1 ? '' : 's'} reference unknown subject URN ${row.subject}`,
        payload: { subject: row.subject, count: row.n },
      });
    }

    const orphanObjects = phaseNow === 'live' ? query<{ object: string; n: number }>(`
      SELECT object, COUNT(*) AS n FROM facts
      WHERE object NOT IN (SELECT urn FROM register)
      GROUP BY object
      ORDER BY n DESC
      LIMIT 5
    `) : [];
    for (const row of orphanObjects) {
      findings.push({
        id: newId(),
        agent: 'memory-keeper',
        kind: 'memory:orphan-fact-object',
        at: Date.now(),
        severity: 'warn',
        summary: `${row.n} fact${row.n === 1 ? '' : 's'} point to unknown object URN ${row.object}`,
        payload: { object: row.object, count: row.n },
      });
    }

    // ── 2. Hooks pointing to non-existent agents ─────────────────────────
    for (const h of listHooks()) {
      if (!knownAgents.has(h.agent)) {
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'memory:orphan-hook',
          at: Date.now(),
          severity: 'warn',
          summary: `hook #${h.id} (${h.segment}/${h.event}) routes to unknown agent "${h.agent}"`,
          payload: { hookId: h.id, segment: h.segment, event: h.event, agent: h.agent },
        });
      }
    }

    // ── 3. Wiki pages for non-existent segments ──────────────────────────
    const segNames = new Set(listSegments().map((s) => s.name));
    for (const w of wikiList()) {
      if (!segNames.has(w.segment)) {
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'memory:orphan-wiki',
          at: Date.now(),
          severity: 'warn',
          summary: `wiki page ${w.segment}/${w.topic} has no matching segment row`,
          payload: { segment: w.segment, topic: w.topic, agent: w.agent },
        });
      }
    }

    // ── 4. Low-confidence facts (hard-path: should always be 1.0) ────────
    const low = query<{ n: number }>(`SELECT COUNT(*) AS n FROM facts WHERE confidence < 1.0`)[0]?.n ?? 0;
    if (low > 0) {
      findings.push({
        id: newId(),
        agent: 'memory-keeper',
        kind: 'memory:low-confidence-facts',
        at: Date.now(),
        severity: 'info',
        summary: `${low} fact${low === 1 ? ' is' : 's are'} below 1.0 confidence — investigate or upgrade evidence`,
        payload: { count: low },
      });
    }

    // ── 5. Bloat: cap wiki_revisions per topic ───────────────────────────
    const overflowing = query<{ segment: string; topic: string; n: number }>(`
      SELECT segment, topic, COUNT(*) AS n FROM wiki_revisions
      GROUP BY segment, topic
      HAVING n > ?
    `, [REVISIONS_KEEP]);
    let prunedTotal = 0;
    for (const row of overflowing) {
      prunedTotal += pruneRevisions(row.segment, row.topic, REVISIONS_KEEP);
    }
    if (prunedTotal > 0) {
      findings.push({
        id: newId(),
        agent: 'memory-keeper',
        kind: 'memory:revisions-pruned',
        at: Date.now(),
        severity: 'info',
        summary: `pruned ${prunedTotal} stale wiki_revisions row${prunedTotal === 1 ? '' : 's'} (kept newest ${REVISIONS_KEEP} per topic)`,
        payload: { pruned: prunedTotal, keepN: REVISIONS_KEEP, topics: overflowing.length },
      });
    }

    // ── 6. Daily VACUUM ──────────────────────────────────────────────────
    const now = Date.now();
    if (now - lastVacuumAt >= VACUUM_EVERY_MS) {
      lastVacuumAt = now;
      const before = memoryStats().sizeBytes;
      try {
        vacuum();
        const after = memoryStats().sizeBytes;
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'memory:vacuum',
          at: now,
          severity: 'info',
          summary: `compacted memory.db ${before} → ${after} bytes`,
          payload: { beforeBytes: before, afterBytes: after, reclaimed: Math.max(0, before - after) },
        });
      } catch (e) {
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'memory:vacuum-failed',
          at: now,
          severity: 'warn',
          summary: `VACUUM failed: ${(e as Error).message}`,
        });
      }
    }

    // ── 7. Completeness scorecard ────────────────────────────────────────
    const screensTotal     = query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE kind = 'screen'`)[0]?.n ?? 0;
    const screensWithEdges = query<{ n: number }>(`
      SELECT COUNT(DISTINCT subject) AS n FROM facts
      WHERE subject IN (SELECT urn FROM register WHERE kind = 'screen')
    `)[0]?.n ?? 0;
    const entitiesTotal    = query<{ n: number }>(`SELECT COUNT(*) AS n FROM register`)[0]?.n ?? 0;
    const entitiesWithEv   = query<{ n: number }>(`SELECT COUNT(*) AS n FROM register WHERE evidence_json IS NOT NULL`)[0]?.n ?? 0;
    const segmentsTotal    = query<{ n: number }>(`SELECT COUNT(*) AS n FROM segments`)[0]?.n ?? 0;
    const segmentsWithWiki = query<{ n: number }>(`SELECT COUNT(DISTINCT segment) AS n FROM wiki_pages WHERE segment IN (SELECT name FROM segments)`)[0]?.n ?? 0;

    const pct = (a: number, b: number) => (b === 0 ? 0 : Math.round((a / b) * 100));
    const score = {
      screensWithEdges_pct: pct(screensWithEdges, screensTotal),
      entitiesWithEvidence_pct: pct(entitiesWithEv, entitiesTotal),
      segmentsWithWiki_pct: pct(segmentsWithWiki, segmentsTotal),
    };
    const overall = Math.round((score.screensWithEdges_pct + score.entitiesWithEvidence_pct + score.segmentsWithWiki_pct) / 3);

    findings.push({
      id: newId(),
      agent: 'memory-keeper',
      kind: 'memory:completeness',
      at: now,
      severity: overall >= 80 ? 'info' : 'warn',
      summary: `model completeness: ${overall}% (screens-with-edges ${score.screensWithEdges_pct}% · entities-with-evidence ${score.entitiesWithEvidence_pct}% · segments-with-wiki ${score.segmentsWithWiki_pct}%)`,
      payload: {
        overall_pct: overall,
        screens: { total: screensTotal, withEdges: screensWithEdges },
        entities: { total: entitiesTotal, withEvidence: entitiesWithEv },
        segments: { total: segmentsTotal, withWiki: segmentsWithWiki },
      },
    });

    // Phase gate (D.17): flip bootstrapping → live when the model is
    // mature enough. Hard-path thresholds: ≥ 95% completeness AND ≥ 5
    // segments AND ≥ 5 wiki pages. Once flipped, the system enters live
    // monitoring mode; the curator's audit pass + write-back become
    // active. We never flip BACK to bootstrapping automatically — that's
    // a manual operator decision (clear data/memory.db).
    const stats = memoryStats();
    const phase = getPhase();
    if (phase === 'bootstrapping') {
      const ready = overall >= 95 && segmentsTotal >= 5 && stats.wikiPages >= 5;
      if (ready) {
        setPhase('live');
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'phase:live-ready',
          at: now,
          severity: 'info',
          summary: `bootstrap complete · model at ${overall}% completeness with ${segmentsTotal} segments + ${stats.wikiPages} wiki pages — flipping to live mode`,
          payload: { overall_pct: overall, segments: segmentsTotal, wikiPages: stats.wikiPages },
        });
      } else {
        findings.push({
          id: newId(),
          agent: 'memory-keeper',
          kind: 'phase:bootstrapping',
          at: now,
          severity: 'info',
          summary: `bootstrapping · ${overall}% complete · ${segmentsTotal} segments · ${stats.wikiPages} wiki pages (need ≥95% + ≥5 + ≥5 to flip live)`,
          payload: { overall_pct: overall, segments: segmentsTotal, wikiPages: stats.wikiPages },
        });
      }
    }

    // ── 8. Integrity summary at the end ──────────────────────────────────
    findings.push({
      id: newId(),
      agent: 'memory-keeper',
      kind: 'memory:integrity-summary',
      at: now,
      severity: 'info',
      summary: `memory: ${stats.findings}f · ${stats.facts} facts · ${stats.entities} entities · ${stats.segments} segs · ${stats.hooks} hooks · ${stats.wikiPages} wiki pages · ${(stats.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
      payload: stats,
    });

    return findings;
  },
};
