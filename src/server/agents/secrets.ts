/* Secrets agent — deterministic.
 *
 * Greps every git-tracked file under ~/NIK/ for secret patterns
 * (Anthropic, OpenAI, Supabase service role JWTs, generic AKIA
 * keys, GitHub tokens, etc.). Emits one error finding per match.
 *
 * Tracked-only: untracked .env files are skipped (they should
 * never be committed but they can sit in the working tree). Hits
 * in test fixtures explicitly tagged `// secrets:allow` on the
 * same or previous line are skipped.
 */

import { execa } from 'execa';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.ts';
import { newId } from '../findings.ts';
import type { Agent, Finding } from '../types.ts';

type Pattern = { kind: string; label: string; re: RegExp; severity: 'warn' | 'error' };

const PATTERNS: Pattern[] = [
  { kind: 'secrets:anthropic',     label: 'Anthropic API key',          re: /sk-ant-[a-zA-Z0-9_\-]{20,}/g,             severity: 'error' },
  { kind: 'secrets:openai',        label: 'OpenAI project API key',     re: /sk-(?:proj-)?[a-zA-Z0-9_\-]{20,}/g,        severity: 'error' },
  { kind: 'secrets:supabase-jwt',  label: 'Supabase service role JWT',  re: /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, severity: 'error' },
  { kind: 'secrets:aws-access',    label: 'AWS access key id',          re: /\bAKIA[0-9A-Z]{16}\b/g,                    severity: 'error' },
  { kind: 'secrets:github-pat',    label: 'GitHub personal access tok', re: /\bghp_[A-Za-z0-9]{36}\b/g,                 severity: 'error' },
  { kind: 'secrets:github-app',    label: 'GitHub app token',           re: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g, severity: 'error' },
  { kind: 'secrets:google-api',    label: 'Google API key',             re: /\bAIza[0-9A-Za-z_\-]{35}\b/g,              severity: 'error' },
  { kind: 'secrets:slack',         label: 'Slack token',                re: /\bxox[abprs]-[A-Za-z0-9\-]{10,}/g,         severity: 'error' },
  { kind: 'secrets:private-key',   label: 'Private key block',          re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, severity: 'error' },
  { kind: 'secrets:hex-32',        label: 'Suspicious 32+ hex literal', re: /\b[a-f0-9]{32,}\b/g,                       severity: 'warn' },
];

/** Files we don't bother scanning. */
const IGNORED_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'pdf', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'ico', 'lock', 'zip', 'tar', 'gz']);
/** Skip files larger than this — secrets in giant files are usually false positives. */
const MAX_BYTES = 512 * 1024;

async function listTrackedFiles(): Promise<string[]> {
  try {
    const r = await execa('git', ['ls-files'], { cwd: config.targetPath });
    return r.stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function shouldSkip(rel: string): boolean {
  const ext = rel.split('.').pop()?.toLowerCase() ?? '';
  return IGNORED_EXT.has(ext) || rel.includes('node_modules/') || rel.includes('/dist/');
}

function lineOf(text: string, idx: number): { line: number; src: string } {
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < idx; i++) {
    if (text[i] === '\n') { line++; lastNl = i; }
  }
  const nextNl = text.indexOf('\n', idx);
  const src = text.slice(lastNl + 1, nextNl === -1 ? text.length : nextNl);
  return { line, src };
}

/** Some patterns (especially the hex-32 fallback) match strings inside obvious
 *  fixture-y contexts. If the same line or the line above it contains the
 *  comment `secrets:allow`, treat the hit as intentional and skip. */
function isAllowed(text: string, idx: number): boolean {
  const before = text.slice(Math.max(0, idx - 200), idx);
  return /secrets:allow/.test(before.split('\n').slice(-2).join('\n'));
}

export const secretsAgent: Agent = {
  name: 'secrets',
  description: 'Greps every tracked file under ~/NIK/ for committed API keys / private keys; errors on each hit.',
  routedFiles: [
    'web/src/**/*.{ts,tsx}',
    'supabase/**/*.{sql,ts}',
    'docs/**/*.md',
    'packages/**/*.{ts,tsx}',
    '.env*',
  ],
  // Hourly sweep as a backstop — file watcher catches edits, but a stale
  // committed secret needs a periodic full pass.
  intervalMs: 60 * 60 * 1000,
  run: async () => {
    const tracked = await listTrackedFiles();
    if (tracked.length === 0) {
      return [{
        id: newId(),
        agent: 'secrets',
        kind: 'secrets:no-source',
        at: Date.now(),
        severity: 'info',
        summary: `target path not a git repo: ${config.targetPath}`,
      }];
    }

    const findings: Finding[] = [];
    let scanned = 0;
    let skipped = 0;

    for (const rel of tracked) {
      if (shouldSkip(rel)) { skipped++; continue; }
      const abs = resolve(config.targetPath, rel);
      let body: string;
      try {
        const buf = readFileSync(abs);
        if (buf.length > MAX_BYTES) { skipped++; continue; }
        body = buf.toString('utf8');
      } catch { continue; }
      scanned++;

      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = p.re.exec(body)) !== null) {
          if (isAllowed(body, m.index)) continue;
          const { line, src } = lineOf(body, m.index);
          findings.push({
            id: newId(),
            agent: 'secrets',
            kind: p.kind,
            at: Date.now(),
            severity: p.severity,
            summary: `${p.label} in tracked file — rotate immediately`,
            file: rel,
            line,
            suggestion: 'remove from git history (BFG / git-filter-repo), rotate the key, move to env / secrets manager',
            payload: { match: m[0].slice(0, 12) + '…', pattern: p.kind, lineSrc: src.slice(0, 200) },
          });
          if (findings.length >= 50) break;
        }
        if (findings.length >= 50) break;
      }
      if (findings.length >= 50) break;
    }

    findings.push({
      id: newId(),
      agent: 'secrets',
      kind: 'secrets:scan-summary',
      at: Date.now(),
      severity: findings.some((f) => f.severity === 'error') ? 'error' : 'info',
      summary: `scanned ${scanned} tracked files (skipped ${skipped}) · ${findings.length} hit${findings.length === 1 ? '' : 's'}`,
      payload: { scanned, skipped, hits: findings.length },
    });

    return findings;
  },
};
