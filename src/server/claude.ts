/* Wrapper around `claude -p` (Claude Code CLI in non-interactive mode).
 *
 * Each agent call spawns a fresh Claude Code session, with the Nik
 * project at ~/NIK added via --add-dir so agents can Read / Grep
 * the codebase. Output is requested as JSON so we can parse + Zod-
 * validate it. Cost is covered by the Claude Max subscription.
 *
 * If `claude` isn't on PATH (developer hasn't installed Claude Code),
 * we surface a clear error rather than silently failing.
 */

import { execa, ExecaError } from 'execa';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const NIK_PATH = process.env.NIK_PATH ?? resolve(homedir(), 'NIK');
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

export type ClaudeRunOptions = {
  /** The prompt to send. */
  prompt: string;
  /** Hard timeout in ms. Default 90s. */
  timeoutMs?: number;
  /** Extra dirs to grant read access to (besides ~/NIK which is always added). */
  extraDirs?: string[];
};

export type ClaudeRunResult = {
  /** Final assistant text. Often a JSON string the caller parses. */
  text: string;
  /** Wall-clock in ms. */
  durationMs: number;
  /** Best-effort token usage if the SDK surfaced it. */
  usage?: { input?: number; output?: number };
};

/** Run a one-shot Claude Code prompt non-interactively.
 *  Throws on timeout, non-zero exit, or claude binary missing. */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const startedAt = Date.now();
  const args = [
    '-p', opts.prompt,
    '--output-format', 'json',
    '--add-dir', NIK_PATH,
  ];
  for (const d of opts.extraDirs ?? []) args.push('--add-dir', d);

  try {
    const r = await execa(CLAUDE_BIN, args, {
      timeout: opts.timeoutMs ?? 90_000,
      reject: true,
      stripFinalNewline: true,
    });
    // Claude Code's --output-format json emits a single JSON object on stdout
    // with a `result` field containing the assistant's final text.
    let text = r.stdout;
    let usage: ClaudeRunResult['usage'] | undefined;
    try {
      const parsed = JSON.parse(r.stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (typeof parsed.result === 'string') text = parsed.result;
      if (parsed.usage) usage = { input: parsed.usage.input_tokens, output: parsed.usage.output_tokens };
    } catch { /* fall through with raw stdout */ }
    return { text, durationMs: Date.now() - startedAt, usage };
  } catch (e) {
    const err = e as ExecaError;
    if (err.code === 'ENOENT') {
      throw new Error(`'${CLAUDE_BIN}' not on PATH — install Claude Code (https://docs.claude.com/en/docs/claude-code) or set CLAUDE_BIN`);
    }
    if (err.timedOut) throw new Error(`claude -p timed out after ${opts.timeoutMs ?? 90_000}ms`);
    throw new Error(`claude -p failed (exit ${err.exitCode}): ${err.stderr || err.shortMessage || err.message}`);
  }
}

/** Pull a JSON array out of a text blob — Claude often wraps JSON
 *  in fenced code blocks or prose. Returns null if no parseable JSON found. */
export function parseJsonArray<T>(text: string): T[] | null {
  // Try fenced ```json block first
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate: string = (fenceMatch && fenceMatch[1]) ? fenceMatch[1] : text;
  // Find the first [ ... ] in the candidate
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const arr = JSON.parse(candidate.slice(start, end + 1));
    return Array.isArray(arr) ? (arr as T[]) : null;
  } catch {
    return null;
  }
}

export { NIK_PATH };
