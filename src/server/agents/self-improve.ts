/* Self-improve agent — claude -p driven.
 *
 * Per project_self_monitoring memory: reads self-monitor findings
 * + each problem agent's .md prompt + that agent's last 50
 * findings, proposes a specific prompt edit. Diffs are NOT
 * auto-applied; they go into the dashboard as `self:prompt-diff-
 * proposal` findings for human approval (Phase 4.2 will add the
 * review queue UI).
 *
 * Hard-path: only proposes when the cause is clearly attributable
 * to the prompt (not the runner, not the schema). Vague "improve
 * X" diffs poison the queue; we'd rather emit zero proposals.
 *
 * Distinct from the meta-agent (Phase 4.1) which watches signal
 * in the user's repo. Self-improve watches our own behavior.
 *
 * Cost control: only runs when self-monitor has produced fresh
 * `self:prompt-broken` / `self:agent-failing` / `self:agent-silent`
 * findings in the last 24h. Daily cadence as a backstop.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonArray, runClaude } from '../claude.ts';
import { newId, parseFinding, rejectedFinding } from '../findings.ts';
import { query, recordApproval } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';
import { SelfImproveFindingSchema } from './schemas.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_BASE = readFileSync(resolve(here, 'self-improve.md'), 'utf8');

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECENT_FINDING_LIMIT = 50;

const TROUBLED_KINDS = new Set([
  'self:prompt-broken',
  'self:agent-failing',
  'self:agent-silent',
]);

export const selfImproveAgent: Agent = {
  name: 'self-improve',
  description: 'Reads self-monitor verdicts + each problem agent\'s prompt; proposes a targeted prompt diff for human approval.',
  routedFiles: [],
  intervalMs: 24 * 60 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    // Identify problem agents from recent self-monitor findings.
    const monitorFindings = query<{ kind: string; summary: string; payload_json: string | null }>(
      `SELECT kind, summary, payload_json FROM findings
        WHERE agent = 'self-monitor' AND at >= ? ORDER BY at DESC`,
      [now - LOOKBACK_MS],
    );
    const seenAgents = new Map<string, { kind: string; summary: string }>();
    for (const f of monitorFindings) {
      if (!TROUBLED_KINDS.has(f.kind)) continue;
      const payload = f.payload_json ? (JSON.parse(f.payload_json) as { agent?: string }) : {};
      const agentName = payload.agent;
      if (!agentName || seenAgents.has(agentName)) continue;
      seenAgents.set(agentName, { kind: f.kind, summary: f.summary });
    }

    if (seenAgents.size === 0) {
      out.push({
        id: newId(),
        agent: 'self-improve',
        kind: 'self:no-improvements-needed',
        at: now,
        severity: 'info',
        summary: 'no problem agents flagged by self-monitor in last 24h — all healthy',
      });
      return out;
    }

    // For each problem agent, gather its prompt + recent findings.
    const repoRoot = resolve(here, '../../..');
    type ProblemInput = {
      name: string;
      monitorFinding: string;
      currentPrompt: string;
      recentFindings: Array<{ kind: string; severity: string; summary: string }>;
    };
    const problems: ProblemInput[] = [];
    for (const [agentName, mon] of seenAgents) {
      const promptPath = resolve(repoRoot, 'src/server/agents', `${agentName}.md`);
      let currentPrompt = '';
      if (existsSync(promptPath)) {
        try { currentPrompt = readFileSync(promptPath, 'utf8'); } catch { /* */ }
      } else {
        // Deterministic agents legitimately have no prompt; only flag when
        // the agent name suggests it should be LLM-driven.
        out.push({
          id: newId(),
          agent: 'self-improve',
          kind: 'self:agent-prompt-missing',
          at: now,
          severity: 'info',
          summary: `${agentName} has no prompt file; cannot audit prompt-level fixes (probably deterministic)`,
        });
        continue;
      }
      const recent = query<{ kind: string; severity: string; summary: string }>(
        `SELECT kind, severity, summary FROM findings WHERE agent = ? ORDER BY at DESC LIMIT ?`,
        [agentName, RECENT_FINDING_LIMIT],
      );
      problems.push({ name: agentName, monitorFinding: `${mon.kind}: ${mon.summary}`, currentPrompt, recentFindings: recent });
    }

    if (problems.length === 0) return out;

    const prompt = `${PROMPT_BASE}

---

## Input — problem agents

${JSON.stringify(problems, null, 2).slice(0, 16_000)}
`;

    try {
      const r = await runClaude({ prompt, timeoutMs: 240_000 });
      const raw = parseJsonArray<unknown>(r.text);
      if (raw === null) {
        if (r.text.trim().length > 0) {
          out.push(rejectedFinding('self-improve', 'output not a parseable JSON array', { textPreview: r.text.slice(0, 500) }));
        }
      } else {
        for (const item of raw.slice(0, 5)) {
          const finding = parseFinding('self-improve', item, SelfImproveFindingSchema);
          out.push(finding);
          // For each prompt-diff proposal, also queue an approval row
          // so the user can apply the diff via the dashboard. Skipped for
          // the other kinds (no-improvements-needed, prompt-missing) —
          // those are informational, nothing to apply.
          if (finding.kind === 'self:prompt-diff-proposal' && finding.payload) {
            const p = finding.payload as { agent?: string; find?: string; replace?: string; rationale?: string };
            if (typeof p.agent === 'string' && typeof p.find === 'string' && typeof p.replace === 'string') {
              const promptPath = resolve(repoRoot, 'src/server/agents', `${p.agent}.md`);
              recordApproval({
                id: newId(),
                agent: 'self-improve',
                kind: 'self:prompt-diff-proposal',
                payload: {
                  targetAgent: p.agent,
                  promptPath,
                  promptPathRel: `src/server/agents/${p.agent}.md`,
                  find: p.find,
                  replace: p.replace,
                  rationale: p.rationale ?? null,
                  monitorFinding: seenAgents.get(p.agent)?.summary ?? null,
                  proposalSummary: finding.summary,
                },
              });
            }
          }
        }
      }
    } catch (e) {
      out.push({
        id: newId(),
        agent: 'self-improve',
        kind: 'self:no-improvements-needed',
        at: now,
        severity: 'info',
        summary: `self-improve pass failed: ${(e as Error).message}`,
      });
    }

    return out;
  },
};
