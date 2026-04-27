/* Code-change-tracker agent — deterministic.
 *
 * Watches `git log` for commits since the last cycle + `git status`
 * for in-flight changes, and turns each into queryable memory:
 *
 *   - register entity per commit (kind: commit, urn commit:<sha>)
 *   - facts: (commit) modified <file> · (commit) authored_by <author>
 *   - per-file change-frequency aggregate (kind: file-activity,
 *     urn file-activity:<file>) updated each cycle with last_modified
 *     + change_count_30d
 *
 * Why this matters: lets the auto-fix-driver + test-coverage agent
 * see "what's been changing recently" without re-shelling git per
 * cycle. Lets MCP tool memory.code.findings answer "what touched
 * this file this week" off a single SQL query.
 *
 * Hard-path: only commits with at least one matched file are
 * registered (no empty/merge/tag commits). last-cycle pointer kept
 * in notes table so we don't re-process old commits.
 *
 * Cadence: 5 min interval; routedFiles empty (we drive ourselves
 * off git, not file-watcher events — saves a watcher subscription).
 */

import { execa } from 'execa';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, note, query, recall, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const CHANGE_FREQ_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;       // 30d for file-activity aggregates
const NOTE_KEY = 'last-commit-sha';

type CommitEntry = {
  sha: string;
  short: string;
  authoredAt: number;
  author: string;
  subject: string;
  files: string[];
};

function getLastTrackedSha(): string | null {
  const v = recall<string>('code-change-tracker', NOTE_KEY);
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function setLastTrackedSha(sha: string): void {
  note('code-change-tracker', NOTE_KEY, sha);
}

async function listNewCommits(sinceSha: string | null, limit = 50): Promise<CommitEntry[]> {
  // git log --pretty=format with separator. -z for null delimiters
  // would be safer but harder to parse without a streaming reader.
  // SEPARATOR token is unlikely to appear in commit messages.
  const SEP = '<<<DEVINFRA-COMMIT-SEP>>>';
  const FIELD = '<<<F>>>';
  const range = sinceSha ? `${sinceSha}..HEAD` : 'HEAD';
  let stdout = '';
  try {
    const r = await execa(
      'git',
      ['log', range, `--pretty=format:%H${FIELD}%h${FIELD}%aI${FIELD}%an${FIELD}%s${SEP}`, '--name-only', `-n`, String(limit)],
      { cwd: config.targetPath, timeout: 15_000 },
    );
    stdout = r.stdout;
  } catch (e) {
    // Non-git repo, bad sinceSha (force-push), or git not installed.
    // Return empty so the agent emits a no-changes cycle instead of crashing.
    if (sinceSha) {
      // Range was bad — clear the pointer so next cycle starts fresh.
      setLastTrackedSha('');
    }
    throw e;
  }

  if (stdout.trim().length === 0) return [];
  const out: CommitEntry[] = [];
  for (const block of stdout.split(SEP)) {
    const trimmed = block.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [headerLine, ...fileLines] = trimmed.split('\n');
    if (!headerLine) continue;
    const [sha, short, authoredAt, author, ...subjectParts] = headerLine.split(FIELD);
    if (!sha || !short || !authoredAt) continue;
    const files = fileLines.map((l) => l.trim()).filter(Boolean);
    if (files.length === 0) continue;        // skip merge / empty commits
    out.push({
      sha,
      short,
      authoredAt: new Date(authoredAt).getTime(),
      author: author ?? 'unknown',
      subject: subjectParts.join(FIELD).trim(),
      files,
    });
  }
  return out;
}

async function listInFlightChanges(): Promise<string[]> {
  try {
    const r = await execa('git', ['status', '--porcelain'], { cwd: config.targetPath, timeout: 10_000 });
    if (r.stdout.trim().length === 0) return [];
    return r.stdout.trim().split('\n').map((l) => l.slice(3)).filter(Boolean);
  } catch { return []; }
}

export const codeChangeTrackerAgent: Agent = {
  name: 'code-change-tracker',
  description: 'Watches git log for new commits + git status for in-flight changes; registers each commit + per-file change-frequency aggregates as memory entities.',
  routedFiles: [],
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const out: Finding[] = [];
    const now = Date.now();

    let sinceSha: string | null = null;
    try { sinceSha = getLastTrackedSha(); } catch { /* */ }

    let commits: CommitEntry[] = [];
    try { commits = await listNewCommits(sinceSha || null); }
    catch (e) {
      return [{
        id: newId(),
        agent: 'code-change-tracker',
        kind: 'code-change:git-error',
        at: now,
        severity: 'info',
        summary: `git log failed (${(e as Error).message.slice(0, 100)}) — repo may not be a git checkout`,
      }];
    }

    let registered = 0;
    let factsEmitted = 0;
    const touchedFiles = new Set<string>();

    for (const c of commits) {
      const urn = `commit:${c.sha}`;
      registerEntity({
        urn,
        kind: 'commit',
        label: `${c.short} · ${c.subject.slice(0, 80)}`,
        agent: 'code-change-tracker',
        confidence: 1.0,
        evidence: [c.sha],
      });
      registered++;

      // Author edge.
      addFact({
        agent: 'code-change-tracker',
        subject: urn,
        predicate: 'authored_by',
        object: `author:${c.author}`,
        evidence: [c.sha],
        confidence: 1.0,
      });
      factsEmitted++;

      // File edges.
      for (const file of c.files) {
        addFact({
          agent: 'code-change-tracker',
          subject: urn,
          predicate: 'modified',
          object: `file:${file}`,
          evidence: [c.sha],
          confidence: 1.0,
        });
        factsEmitted++;
        touchedFiles.add(file);
      }
    }

    // Update per-file activity aggregates for everything touched this
    // cycle. The aggregate is a register entity whose evidence array
    // grows with the recent SHAs — bounded so the row doesn't blow up.
    const inFlight = await listInFlightChanges();
    for (const file of inFlight) touchedFiles.add(file);

    let activityRowsUpdated = 0;
    for (const file of touchedFiles) {
      // Count touches in the last 30d via the facts table.
      const cutoff = now - CHANGE_FREQ_WINDOW_MS;
      const r = query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM facts
           WHERE agent = 'code-change-tracker' AND predicate = 'modified' AND object = ? AND at >= ?`,
        [`file:${file}`, cutoff],
      )[0];
      const count30d = r?.n ?? 0;
      const isInFlight = inFlight.includes(file);

      registerEntity({
        urn: `file-activity:${file}`,
        kind: 'file-activity',
        label: `${file} · ${count30d} change${count30d === 1 ? '' : 's'} in 30d${isInFlight ? ' · in-flight' : ''}`,
        file,
        agent: 'code-change-tracker',
        confidence: 1.0,
        evidence: [`change-count: ${count30d}`, ...(isInFlight ? ['in-flight in working tree'] : [])],
      });
      activityRowsUpdated++;
    }

    // Persist the new high-water-mark sha so next cycle starts from
    // here (not the beginning of git history).
    if (commits.length > 0) {
      try { setLastTrackedSha(commits[0]!.sha); } catch { /* */ }
    }

    out.push({
      id: newId(),
      agent: 'code-change-tracker',
      kind: 'code-change:summary',
      at: now,
      severity: 'info',
      summary: `${commits.length} new commit${commits.length === 1 ? '' : 's'} · ${touchedFiles.size} files touched · ${inFlight.length} in-flight · ${factsEmitted} facts · ${activityRowsUpdated} activity rows`,
      payload: {
        commits: commits.length,
        filesTouched: touchedFiles.size,
        inFlight: inFlight.length,
        factsEmitted,
        activityRowsUpdated,
        sinceSha: sinceSha || null,
        latestSha: commits[0]?.sha ?? null,
      },
    });
    return out;
  },
};
