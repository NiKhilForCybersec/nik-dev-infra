/* Wrapper around `claude -p` (Claude Code CLI in non-interactive mode).
 *
 * Each agent call spawns a fresh Claude Code session, with the Nik
 * project at ~/NIK added via --add-dir so agents can Read / Grep
 * the codebase. Output is requested as JSON so we can parse + Zod-
 * validate it. Cost is covered by the Claude Max subscription.
 *
 * If `claude` isn't on PATH (developer hasn't installed Claude Code),
 * we surface a clear error rather than silently failing.
 *
 * `runClaudeAPI` is the parallel direct-SDK path (per
 * project_claude_cli_overhead memory). High-throughput extraction
 * agents can opt in via `useApi: true` to skip the ~50s CLI bootstrap
 * and hit the model in ~5s. Requires ANTHROPIC_API_KEY env var; falls
 * back to the CLI path with a clear error when missing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { execa, ExecaError } from 'execa';
import { config } from './config.ts';

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

// Lazy-init so the daemon doesn't fail to boot when ANTHROPIC_API_KEY
// is unset (CLI-only deployments are still fully functional).
let sdkClient: Anthropic | null | undefined;
function getSdk(): Anthropic | null {
  if (sdkClient !== undefined) return sdkClient;
  if (!process.env.ANTHROPIC_API_KEY) {
    sdkClient = null;
    return null;
  }
  sdkClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return sdkClient;
}

/** Re-exported for back-compat; new code should read `config.targetPath`. */
const NIK_PATH = config.targetPath;

export type ClaudeRunOptions = {
  /** The prompt to send. */
  prompt: string;
  /** Hard timeout in ms. Default 90s. */
  timeoutMs?: number;
  /** Extra dirs to grant read access to (besides ~/NIK which is always added). */
  extraDirs?: string[];
  /** Per-call tool whitelist (12-patterns #9). Defaults to a strict
   *  read-only set: ['Read', 'Grep', 'Glob']. Agents that emit findings
   *  via Zod-validated JSON output don't need Write/Edit access — the
   *  deterministic runner does writes. Locking the surface this small
   *  closes the prompt-injection → arbitrary-Write vector. Agents that
   *  legitimately need a wider surface MUST opt in explicitly. */
  allowedTools?: string[];
  /** Optional rolling summary of what this agent has previously concluded
   *  (12-patterns #5). When provided, prepended to the prompt as a
   *  "PREVIOUSLY CONCLUDED" block so the agent doesn't re-derive state on
   *  every run. Typically sourced via memory.getSummary(agentName). */
  priorSummary?: string;
  /** Working directory for the spawned `claude` process. Defaults to the
   *  dev-infra repo root (claude reads --add-dir to know which project to
   *  operate against). The auto-fix driver overrides this to the user's
   *  repo so write-tools (Edit / Write) land their edits in the right
   *  place rather than in dev-infra's own source. */
  cwd?: string;
  /** Override the model. When unset, uses whatever the user's Claude Code
   *  CLI is configured for (typically opus). Agents doing structured
   *  high-volume extraction (intent-extractor) pin to haiku for ~3×
   *  speed + lower cost; reasoning-heavy agents leave it default. */
  model?: string;
  /** Use the direct Anthropic SDK path instead of `claude -p`. Skips
   *  the ~50s CLI bootstrap — sub-5s round trip on haiku. Caller must
   *  set ANTHROPIC_API_KEY. Tools (Edit/Write/etc) are NOT available
   *  on this path; only text in / text out. Use for high-throughput
   *  structured extraction agents (intent-extractor, future test-
   *  coverage LLM-fallback). */
  useApi?: boolean;
  /** When useApi is true, max tokens for the response. Default 2048
   *  matches the size of structured-extraction outputs. */
  maxTokens?: number;
};

/** Default tool whitelist passed to every claude -p call. All current
 *  agents are read-only against the watched repo; emits flow through
 *  Node-side runner code, not through claude tools. */
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Grep', 'Glob'];

export type ClaudeRunResult = {
  /** Final assistant text. Often a JSON string the caller parses. */
  text: string;
  /** Wall-clock in ms. */
  durationMs: number;
  /** Best-effort token usage if the SDK surfaced it. */
  usage?: { input?: number; output?: number };
};

/** Run a one-shot Claude Code prompt non-interactively.
 *  Throws on timeout, non-zero exit, or claude binary missing.
 *  When `useApi: true`, dispatches via the Anthropic SDK instead of
 *  spawning the CLI — sub-5s typical round trip vs. ~50s CLI cold
 *  start. SDK path returns ONLY text; no tools available. */
export async function runClaude(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  if (opts.useApi) return runClaudeAPI(opts);
  const startedAt = Date.now();
  const allowed = opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  // Prepend rolling summary if the caller has one; the agent uses it as
  // "what I previously concluded" context so it doesn't re-derive state.
  const fullPrompt = opts.priorSummary
    ? `## PREVIOUSLY CONCLUDED (auto-summary, may be stale — verify before relying)\n\n${opts.priorSummary}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  const args = [
    '-p', fullPrompt,
    '--output-format', 'json',
    '--add-dir', config.targetPath,
    '--allowed-tools', allowed.join(','),
  ];
  if (opts.model) args.push('--model', opts.model);
  for (const d of opts.extraDirs ?? []) args.push('--add-dir', d);

  try {
    const r = await execa(CLAUDE_BIN, args, {
      timeout: opts.timeoutMs ?? 90_000,
      reject: true,
      stripFinalNewline: true,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
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

/** SDK path — direct Anthropic API call. Used by high-throughput
 *  agents that don't need CLI tools (Read/Edit/Write/etc). Saves the
 *  ~50s CLI bootstrap per call. */
async function runClaudeAPI(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const startedAt = Date.now();
  const sdk = getSdk();
  if (!sdk) {
    throw new Error(
      `runClaude useApi=true requires ANTHROPIC_API_KEY env var. ` +
      `Set it or drop useApi to fall back to the CLI path.`,
    );
  }
  // Default to haiku on the SDK path — same calibration as the CLI
  // intent-extractor (haiku is comparable quality for structured
  // extraction at ~12× lower cost).
  const model = opts.model ?? 'claude-haiku-4-5';
  const fullPrompt = opts.priorSummary
    ? `## PREVIOUSLY CONCLUDED (auto-summary, may be stale — verify before relying)\n\n${opts.priorSummary}\n\n---\n\n${opts.prompt}`
    : opts.prompt;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
  try {
    const r = await sdk.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      messages: [{ role: 'user', content: fullPrompt }],
    }, { signal: ctrl.signal });
    const text = r.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return {
      text,
      durationMs: Date.now() - startedAt,
      usage: { input: r.usage.input_tokens, output: r.usage.output_tokens },
    };
  } catch (e) {
    const err = e as Error & { status?: number; type?: string };
    if (ctrl.signal.aborted) {
      throw new Error(`Anthropic SDK timed out after ${opts.timeoutMs ?? 60_000}ms`);
    }
    throw new Error(`Anthropic SDK call failed: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}`);
  } finally {
    clearTimeout(timer);
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
