/* Curator agent — deterministic.
 *
 * The dedicated cross-verifier + write-back gate. Reads recent
 * findings from the memory index, applies per-kind cross-
 * verification rules to suppress false positives, and (when
 * `writeback.enabled` is true) appends the survivors to the user
 * repo's Concerns.md and idempotently inserts a one-line gate
 * into CLAUDE.md.
 *
 * This is the ONLY agent in the system that writes to the user's
 * repo. Two paths only — `<repo>/<concernsFile>` and
 * `<repo>/<claudeMdFile>` — never anything else.
 *
 * Hard-path:
 *   - default consent is OFF; nothing is written until the user
 *     flips writeback.enabled in dev-infra.config.json.
 *   - even with consent, every promotion goes through cross-
 *     verification rules. Anything below 100% factual stays
 *     private (emits a `curator:suppressed` info finding).
 *   - promotions are recorded in the SQLite `promotions` table so
 *     a finding can never be appended twice.
 *   - the CLAUDE.md gate insert is a single named line wrapped in
 *     a sentinel block so we can find + skip our own marker on
 *     subsequent runs.
 *
 * Cross-verification rules — see project_writeback_agent.md memory.
 *   secrets:*       always promote (zero tolerance).
 *   db:missing-rls  always promote (security floor).
 *   nav:broken-target  promote only if graph register has no
 *                      `screen:<target>` entity.
 *   drift:*         promote only if no overlapping `hardcoded:*`
 *                   finding cites the same file:line (suggests
 *                   double-flagging).
 *   health:down     promote only after ≥ 2 consecutive `health:down`
 *                   findings for that target (avoids transient
 *                   flap noise).
 *   schema-rejected skip — never promote (it's our own bug, not
 *                   the user's).
 *   info severity   skip — promotion floor is warn / error.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { isPromoted, query, recordPromotion } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';
import { parseFinding, rejectedFinding } from '../findings.ts';
import { CuratorFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT_PROMPT_BASE = readFileSync(resolve(here, 'curator-audit.md'), 'utf8');

// ─── helpers ──────────────────────────────────────────────────────────────

const CLAUDE_MD_SENTINEL_BEGIN = '<!-- nik-dev-infra:concerns-gate -->';
const CLAUDE_MD_SENTINEL_END   = '<!-- /nik-dev-infra:concerns-gate -->';

function gateBlock(): string {
  return `${CLAUDE_MD_SENTINEL_BEGIN}
## Concerns from nik-dev-infra

Before any code change, read [\`${config.concernsFile}\`](${config.concernsFile}) for issues
surfaced by nik-dev-infra. After editing any \`*Screen.tsx\`, save a current screenshot at
\`${config.screenshotsDir}/<ScreenName>.png\` so the dev-infra dashboard can render the live view.
${CLAUDE_MD_SENTINEL_END}
`;
}

function ensureClaudeMdGate(): { changed: boolean; reason?: string } {
  const target = resolve(config.targetPath, config.claudeMdFile);
  if (!existsSync(target)) {
    // Create a minimal CLAUDE.md with just our gate. User can expand later.
    writeFileSync(target, `# CLAUDE.md\n\n${gateBlock()}`);
    return { changed: true, reason: 'created' };
  }
  const existing = readFileSync(target, 'utf8');
  if (existing.includes(CLAUDE_MD_SENTINEL_BEGIN)) {
    // Replace our existing block in place — content may have evolved
    // (e.g. screenshotsDir changed). Idempotent for the same content.
    const re = new RegExp(
      `${CLAUDE_MD_SENTINEL_BEGIN.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?${CLAUDE_MD_SENTINEL_END.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`,
    );
    const next = existing.replace(re, gateBlock().trim());
    if (next === existing) return { changed: false };
    writeFileSync(target, next);
    return { changed: true, reason: 'updated' };
  }
  // No sentinel — append the block.
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  appendFileSync(target, `${sep}${gateBlock()}`);
  return { changed: true, reason: 'appended' };
}

function ensureConcernsHeader(): void {
  const target = resolve(config.targetPath, config.concernsFile);
  if (existsSync(target)) return;
  // Make sure the parent dir exists.
  const dir = dirname(target);
  if (!existsSync(dir)) {
    (require('node:fs') as typeof import('node:fs')).mkdirSync(dir, { recursive: true });
  }
  writeFileSync(target,
    `# Concerns\n\nUnresolved issues surfaced by nik-dev-infra. Newest at the bottom.\n\n` +
    `## Surfaced by nik-dev-infra\n\n`,
  );
}

function appendConcern(finding: Finding): void {
  ensureConcernsHeader();
  const target = resolve(config.targetPath, config.concernsFile);
  const ts = new Date(finding.at).toISOString();
  const fileRef = finding.file ? ` ([\`${finding.file}${finding.line ? `:${finding.line}` : ''}\`](${finding.file}${finding.line ? `#L${finding.line}` : ''}))` : '';
  const line = `- **${finding.severity.toUpperCase()}** · \`${finding.agent}/${finding.kind}\`${fileRef} — ${finding.summary}\n  <small>${ts} · finding ${finding.id}</small>\n`;
  appendFileSync(target, line);
}

// ─── cross-verification rules ─────────────────────────────────────────────

type Rule = (f: Finding) => { promote: boolean; reason: string };

function rule_always(): Rule {
  return () => ({ promote: true, reason: 'unconditional' });
}

function rule_skip(reason: string): Rule {
  return () => ({ promote: false, reason });
}

const rule_navBroken: Rule = (f) => {
  // Only promote if no register entity exists for the target screen.
  const target = (f.payload as { target?: string } | undefined)?.target;
  if (!target) return { promote: false, reason: 'no target in payload' };
  const has = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM register WHERE urn = ?`,
    [`screen:${target}`],
  )[0]?.n ?? 0;
  return has > 0
    ? { promote: false, reason: 'register has matching screen — likely a stale finding' }
    : { promote: true, reason: 'verified: no matching screen URN in register' };
};

const rule_driftCrossCheck: Rule = (f) => {
  // Suppress if a hardcoded finding cites the same file:line (likely
  // double-flagging).
  if (!f.file) return { promote: false, reason: 'drift finding has no file ref' };
  const overlaps = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM findings WHERE agent = 'hardcoded' AND file = ? AND line = ? AND at >= ?`,
    [f.file, f.line ?? null, f.at - 60 * 60 * 1000],
  )[0]?.n ?? 0;
  return overlaps > 0
    ? { promote: false, reason: 'overlapping hardcoded finding — likely double-flag' }
    : { promote: true, reason: 'verified: no overlapping hardcoded finding in last hour' };
};

const rule_healthDownStable: Rule = (f) => {
  // Promote only if the same target was also down in the previous health
  // run (i.e. ≥ 2 consecutive down findings for that target).
  const target = (f.payload as { target?: string } | undefined)?.target;
  if (!target) return { promote: false, reason: 'no target in payload' };
  const priorDown = query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM findings
       WHERE agent = 'health' AND kind = 'health:down' AND at < ? AND at >= ?
         AND payload_json LIKE ?`,
    [f.at, f.at - 5 * 60 * 1000, `%"target":"${target}"%`],
  )[0]?.n ?? 0;
  return priorDown >= 1
    ? { promote: true, reason: `verified: ${target} also down in prior run` }
    : { promote: false, reason: 'first-seen down — waiting for confirmation' };
};

const RULES: Record<string, Rule> = {
  // Secrets — always promote.
  'secrets:anthropic':    rule_always(),
  'secrets:openai':       rule_always(),
  'secrets:supabase-jwt': rule_always(),
  'secrets:aws-access':   rule_always(),
  'secrets:github-pat':   rule_always(),
  'secrets:github-app':   rule_always(),
  'secrets:google-api':   rule_always(),
  'secrets:slack':        rule_always(),
  'secrets:private-key':  rule_always(),
  // Database security floor.
  'db:missing-rls':       rule_always(),
  'db:type-mismatch':     rule_always(),
  // Drift / nav / health: require cross-verification.
  'drift:semantic':           rule_driftCrossCheck,
  'drift:dead-write':         rule_driftCrossCheck,
  'drift:missing-pagination': rule_driftCrossCheck,
  'drift:wrong-op':           rule_driftCrossCheck,
  'nav:broken-target':        rule_navBroken,
  'health:down':              rule_healthDownStable,
  // Schema-rejected and curator's own findings: never promote.
  'schema-rejected':            rule_skip('schema-rejected is our bug, not the user\'s'),
  'curator:promoted':           rule_skip('do not echo our own promotions'),
  'curator:suppressed':         rule_skip('do not echo our own suppressions'),
  'curator:write-disabled':     rule_skip('not actionable'),
  'curator:claudemd-updated':   rule_skip('not actionable'),
  'hooks:fired':                rule_skip('orchestrator dispatch noise'),
  // Memory-keeper / self / orchestrator findings — internal, don't promote.
  'memory:integrity-summary':   rule_skip('internal'),
  'memory:completeness':        rule_skip('internal'),
};

const DEFAULT_RULE: Rule = (f) => {
  // Severity floor: only warn / error get the default-promote treatment.
  if (f.severity === 'info') return { promote: false, reason: 'info severity — below promotion floor' };
  // Anything else from a deterministic agent gets through; LLM agents
  // need an explicit rule above (or we suppress to be safe).
  const llmAgents = new Set(['drift', 'navigation', 'hardcoded', 'database', 'concerns', 'sync', 'accessibility', 'bootstrap']);
  return llmAgents.has(f.agent)
    ? { promote: false, reason: `LLM-agent finding without an explicit rule — suppress until cross-verification rule lands` }
    : { promote: true, reason: 'deterministic agent + warn/error severity' };
};

const LOOKBACK_MS = 6 * 60 * 60 * 1000;            // last 6h
const PER_RUN_PROMOTE_CAP = 25;

export const curatorAgent: Agent = {
  name: 'curator',
  description: 'Cross-verifies findings + (when consent is on) appends to Concerns.md and inserts the CLAUDE.md gate.',
  routedFiles: [],
  intervalMs: 15 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    // Always emit one summary so the agent rail shows the curator as
    // alive. Real signal comes from promotion / suppression findings.
    let promotedCount = 0;
    let suppressedCount = 0;
    let skippedCount = 0;
    // Aggregate "would-promote" buckets so the off-path emits ONE digest
    // finding instead of one per candidate (no rail spam).
    const wouldPromoteByKind = new Map<string, number>();
    const suppressedByReason = new Map<string, number>();

    // Recent candidate findings.
    const candidates = query<{ id: string; agent: string; kind: string; severity: string; summary: string; file: string | null; line: number | null; at: number; payload_json: string | null }>(
      `SELECT id, agent, kind, severity, summary, file, line, at, payload_json
         FROM findings
        WHERE at >= ?
        ORDER BY at ASC`,
      [now - LOOKBACK_MS],
    );

    for (const row of candidates) {
      if (isPromoted(row.id)) { skippedCount++; continue; }

      const f: Finding = {
        id: row.id,
        agent: row.agent,
        kind: row.kind,
        severity: row.severity as Finding['severity'],
        summary: row.summary,
        at: row.at,
        ...(row.file ? { file: row.file } : {}),
        ...(row.line !== null ? { line: row.line } : {}),
        ...(row.payload_json ? { payload: JSON.parse(row.payload_json) as Record<string, unknown> } : {}),
      };

      const rule = RULES[row.kind] ?? DEFAULT_RULE;
      const verdict = rule(f);

      if (!verdict.promote) {
        suppressedCount++;
        // Aggregate suppression reasons rather than logging each — keep
        // the agent rail clean. The summary at the end ships a digest.
        const key = `${row.agent}/${row.kind}: ${verdict.reason}`;
        suppressedByReason.set(key, (suppressedByReason.get(key) ?? 0) + 1);
        continue;
      }

      if (promotedCount >= PER_RUN_PROMOTE_CAP) break;

      if (!config.writeback.enabled) {
        // Consent off — count by (agent,kind); ONE digest finding emitted
        // at the end instead of one per candidate. Keeps the rail quiet.
        const key = `${row.agent}/${row.kind}`;
        wouldPromoteByKind.set(key, (wouldPromoteByKind.get(key) ?? 0) + 1);
        continue;
      }

      // Consent on — write to Concerns.md.
      try {
        appendConcern(f);
        recordPromotion({
          findingId: f.id,
          agent: f.agent,
          kind: f.kind,
          severity: f.severity,
          summary: f.summary,
          ...(f.file ? { file: f.file } : {}),
          promotedTo: config.concernsFile,
        });
        promotedCount++;
        out.push({
          id: newId(),
          agent: 'curator',
          kind: 'curator:promoted',
          at: now,
          severity: 'info',
          summary: `promoted ${f.agent}/${f.kind} → ${config.concernsFile}`,
          payload: { findingId: f.id, reason: verdict.reason, file: f.file ?? null },
        });
      } catch (e) {
        out.push({
          id: newId(),
          agent: 'curator',
          kind: 'curator:write-failed',
          at: now,
          severity: 'error',
          summary: `failed to append to ${config.concernsFile}: ${(e as Error).message}`,
          payload: { findingId: f.id, error: (e as Error).message },
        });
      }
    }

    // CLAUDE.md gate maintenance.
    if (config.writeback.enabled && config.writeback.insertClaudeMdGate) {
      try {
        const r = ensureClaudeMdGate();
        if (r.changed) {
          out.push({
            id: newId(),
            agent: 'curator',
            kind: 'curator:claudemd-updated',
            at: now,
            severity: 'info',
            summary: `${r.reason ?? 'updated'} ${config.claudeMdFile} gate block`,
            payload: { reason: r.reason },
          });
        }
      } catch (e) {
        out.push({
          id: newId(),
          agent: 'curator',
          kind: 'curator:write-failed',
          at: now,
          severity: 'error',
          summary: `failed to update ${config.claudeMdFile}: ${(e as Error).message}`,
        });
      }
    }

    // Top-N digests
    const topWouldPromote = [...wouldPromoteByKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    const topSuppressedReasons = [...suppressedByReason.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    if (!config.writeback.enabled && wouldPromoteByKind.size > 0) {
      out.push({
        id: newId(),
        agent: 'curator',
        kind: 'curator:write-disabled',
        at: now,
        severity: 'info',
        summary: `${[...wouldPromoteByKind.values()].reduce((a, b) => a + b, 0)} candidates would promote — top: ${topWouldPromote.map(([k, n]) => `${k}×${n}`).join(', ')}`,
        payload: { byKind: Object.fromEntries(wouldPromoteByKind), writebackEnabled: false },
      });
    }

    if (suppressedByReason.size > 0) {
      out.push({
        id: newId(),
        agent: 'curator',
        kind: 'curator:suppressed',
        at: now,
        severity: 'info',
        summary: `${suppressedCount} suppressed across ${suppressedByReason.size} reason${suppressedByReason.size === 1 ? '' : 's'} — top: ${topSuppressedReasons.map(([k, n]) => `${k} ×${n}`).join(' · ').slice(0, 240)}`,
        payload: { byReason: Object.fromEntries(suppressedByReason) },
      });
    }

    // ── AUDIT PASS (D.5.5) ───────────────────────────────────────────────
    // The new primary curator job: read the user's existing Concerns.md
    // and judge each entry against the actual code. We never invent NEW
    // concerns here — that's the promote-pass above for security only.
    // Audit verdicts surface as findings; when writeback.enabled is on,
    // unaddressed entries get an in-place ⚠ annotation appended under
    // them (NOT a new bullet at the bottom).
    const concernsPath = resolve(config.targetPath, config.concernsFile);
    if (!existsSync(concernsPath)) {
      out.push({
        id: newId(),
        agent: 'curator',
        kind: 'curator:audit-no-concerns-file',
        at: now,
        severity: 'info',
        summary: `no ${config.concernsFile} in target — nothing to audit`,
      });
    } else {
      const concernsBody = readFileSync(concernsPath, 'utf8');
      if (concernsBody.trim().length === 0) {
        out.push({
          id: newId(),
          agent: 'curator',
          kind: 'curator:audit-no-concerns-file',
          at: now,
          severity: 'info',
          summary: `${config.concernsFile} is empty — nothing to audit`,
        });
      } else {
        const auditPrompt = `${AUDIT_PROMPT_BASE}

---

## Input — current contents of ${config.concernsFile}

\`\`\`markdown
${concernsBody.slice(0, 12_000)}
\`\`\`
`;
        try {
          const r = await runClaude({ prompt: auditPrompt, timeoutMs: 180_000 });
          const raw = parseJsonArray<unknown>(r.text);
          if (raw === null) {
            if (r.text.trim().length > 0) out.push(rejectedFinding('curator', 'audit output not a parseable JSON array', { textPreview: r.text.slice(0, 500) }));
          } else {
            for (const item of raw.slice(0, 30)) {
              out.push(parseFinding('curator', item, CuratorFindingSchema));
            }
          }
        } catch (e) {
          out.push({
            id: newId(),
            agent: 'curator',
            kind: 'curator:audit-uncertain',
            at: now,
            severity: 'info',
            summary: `audit pass failed: ${(e as Error).message}`,
            payload: { error: (e as Error).message },
          });
        }
      }
    }

    out.push({
      id: newId(),
      agent: 'curator',
      kind: 'curator:summary',
      at: now,
      severity: 'info',
      summary: `curator pass · ${promotedCount} promoted · ${suppressedCount} suppressed · ${skippedCount} already-promoted · writeback ${config.writeback.enabled ? 'ON' : 'off'}`,
      payload: {
        promoted: promotedCount,
        suppressed: suppressedCount,
        alreadyPromoted: skippedCount,
        writebackEnabled: config.writeback.enabled,
        claudeMdGate: config.writeback.insertClaudeMdGate,
      },
    });

    return out;
  },
};
