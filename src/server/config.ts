/* Project-target configuration.
 *
 * Every path that used to be hardcoded to ~/NIK or to Nik's specific
 * directory layout now flows through this module. The daemon's other
 * pieces (watcher, agents, claude wrapper) read from `config` only —
 * not from process.env directly.
 *
 * Resolution order (highest priority first):
 *   1. `dev-infra.config.json` at the dev-infra repo root, if present
 *      — JSON is used so we can read it without an additional TS load
 *      step at boot.
 *   2. Environment variables (NIK_PATH, DEVINFRA_TARGET, etc.) — kept
 *      for back-compat with how the daemon used to be configured.
 *   3. Built-in defaults that point at ~/NIK with the Nik shape, so a
 *      fresh checkout still works against the original target.
 *
 * Validated with Zod at module load; any malformed config throws
 * loudly at boot rather than letting agents silently look at the
 * wrong paths.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '../..');
const CONFIG_FILE = resolve(REPO_ROOT, 'dev-infra.config.json');

const ConfigSchema = z.object({
  /** Absolute path to the watched repo. */
  targetPath: z.string().min(1),
  /** Human-friendly label for this target — shown in the dashboard header. */
  targetLabel: z.string().min(1),
  /** Globs (relative to targetPath) the file watcher subscribes to. */
  watchGlobs: z.array(z.string()).min(1),
  /** Directory of contract files (Zod ops/cmds), relative to targetPath. Null = no contracts layer. */
  contractsDir: z.string().nullable(),
  /** Glob for screen / page components, relative to targetPath. Null = no UI layer. */
  screensGlob: z.string().nullable(),
  /** Glob for screen-manifest sidecars, relative to targetPath. Null if not used. */
  manifestsGlob: z.string().nullable(),
  /** Glob for SQL migrations, relative to targetPath. Null if not used. */
  migrationsGlob: z.string().nullable(),
  /** Directories containing backend handlers (Supabase functions, Next API routes, Express, etc.). */
  backendDirs: z.array(z.string()),
  /** Globs containing frontend code to scan for fetch() calls + LLM SDK imports. */
  frontendGlobs: z.array(z.string()),
  /** MCP servers the dev-infra should introspect. Each is a JSON-RPC
   *  over HTTP endpoint that responds to the `tools/list` method. */
  mcpServers: z.array(z.object({
    name: z.string().min(1),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
  })),
  /** Write-back to the user's repo. OFF by default. When `enabled: true`,
   *  the curator agent may append cross-verified findings to the
   *  configured `concernsFile` and (if `insertClaudeMdGate`) idempotently
   *  insert a single instruction line into `claudeMdFile`. Writes are
   *  restricted to those two paths only — nothing else under the repo. */
  writeback: z.object({
    enabled: z.boolean(),
    insertClaudeMdGate: z.boolean(),
  }),
  /** Risk-class gate (per 12-patterns #10). Everything except
   *  write-prompt + write-user-repo runs freely. The two listed below
   *  are off by default; an agent in either class emits a `risk:gated`
   *  finding instead of executing until the operator flips the flag. */
  riskGate: z.object({
    /** Allow agents classified `write-prompt` to actually mutate
     *  dev-infra's own .md files. Default false — self-improve emits
     *  diffs as findings only. */
    allowWritePrompt: z.boolean(),
    /** Mirror of writeback.enabled for `write-user-repo` agents. Both
     *  must be true for any user-repo write. Belt-and-suspenders. */
    allowWriteUserRepo: z.boolean(),
  }),
  /** Per-agent budget caps (Phase 4.4 / 12-patterns adjacent). Prevents
   *  a runaway agent from burning the whole Claude Max budget in a
   *  loop. The orchestrator counts runs in the trailing 24h via the
   *  agent_runs table; if any agent exceeds its cap, the next run is
   *  skipped + `budget:exceeded` is emitted. Resets implicitly as old
   *  rows age out of the 24h window. */
  agentBudgets: z.object({
    /** Default cap on runs per 24h. Applied to any agent without an
     *  explicit override. Generous default — most agents on
     *  intervalMs=60s would run 1440x/day; cap at 2000 to leave
     *  headroom for file-change-driven re-runs. */
    defaultMaxRunsPerDay: z.number().int().positive(),
    /** Per-agent overrides. Cheap deterministic agents can stay high;
     *  expensive LLM agents (claude -p) should be lower. */
    overrides: z.record(z.number().int().positive()),
  }),
  /** Concerns markdown file, relative to targetPath. */
  concernsFile: z.string(),
  /** Resolutions markdown file (user's Claude logs claimed fixes here). */
  resolutionsFile: z.string(),
  /** CLAUDE.md file, relative to targetPath. */
  claudeMdFile: z.string(),
  /** Folder where the user's Claude Code session drops screenshots
   *  per screen — `<ScreenName>.png`. Watched by the screenshots agent,
   *  served via /api/screenshots/<urn>, surfaced in the playground
   *  side panel. */
  screenshotsDir: z.string(),
  /** Subset of agents to enable (by name). Null = all enabled. */
  agentsToEnable: z.array(z.string()).nullable(),
});

export type DevInfraConfig = z.infer<typeof ConfigSchema>;

const NIK_DEFAULT_TARGET = process.env.NIK_PATH ?? resolve(homedir(), 'NIK');

const DEFAULT_CONFIG: DevInfraConfig = {
  targetPath: process.env.DEVINFRA_TARGET ?? NIK_DEFAULT_TARGET,
  targetLabel: process.env.DEVINFRA_LABEL ?? 'Nik',
  watchGlobs: [
    'web/src/**/*.{ts,tsx}',
    'web/public/*',
    'supabase/migrations/*.sql',
    'docs/**/*.md',
    'packages/**/*.{ts,tsx}',
  ],
  contractsDir: 'web/src/contracts',
  screensGlob: 'web/src/screens/*Screen.tsx',
  manifestsGlob: 'web/src/screens/*.manifest.ts',
  migrationsGlob: 'supabase/migrations/*.sql',
  backendDirs: ['supabase/functions', 'app/api', 'pages/api', 'src/api', 'src/server', 'server'],
  frontendGlobs: ['web/src/**/*.{ts,tsx}', 'src/**/*.{ts,tsx}'],
  mcpServers: [],
  concernsFile: 'docs/Concerns.md',
  resolutionsFile: 'docs/Resolutions.md',
  claudeMdFile: 'CLAUDE.md',
  screenshotsDir: 'docs/screenshots',
  writeback: { enabled: false, insertClaudeMdGate: false },
  riskGate: { allowWritePrompt: false, allowWriteUserRepo: false },
  agentBudgets: {
    defaultMaxRunsPerDay: 2000,
    overrides: {
      // LLM-driven agents — cap lower; ~1 run / 5 min sustained.
      drift: 300, navigation: 300, hardcoded: 300, database: 200,
      sync: 150, accessibility: 150, bindings: 200, 'ai-coverage': 150,
      bootstrap: 100, 'doc-ingest': 100, concerns: 100,
      'self-improve': 30, curator: 200,
    },
  },
  agentsToEnable: null,
};

function loadFromFile(): Partial<DevInfraConfig> | null {
  if (!existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Partial<DevInfraConfig>;
    return raw;
  } catch (e) {
    throw new Error(`[config] failed to parse ${CONFIG_FILE}: ${(e as Error).message}`);
  }
}

function mergeAndValidate(): DevInfraConfig {
  const fileLayer = loadFromFile() ?? {};
  const merged = { ...DEFAULT_CONFIG, ...fileLayer };
  // Resolve targetPath to absolute (allow ~/, relative to CWD, or absolute).
  let target = merged.targetPath;
  if (target.startsWith('~/')) target = resolve(homedir(), target.slice(2));
  if (!isAbsolute(target)) target = resolve(process.cwd(), target);
  merged.targetPath = target;

  const r = ConfigSchema.safeParse(merged);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`[config] dev-infra.config.json failed validation: ${issues}`);
  }
  return r.data;
}

export const config: DevInfraConfig = mergeAndValidate();

/** Convenience: resolve a glob/path relative to the watched repo. */
export function inTarget(rel: string): string {
  return resolve(config.targetPath, rel);
}

/** Whether an agent is enabled per the agentsToEnable filter. */
export function agentEnabled(name: string): boolean {
  return config.agentsToEnable === null || config.agentsToEnable.includes(name);
}

console.log(`[config] target=${config.targetPath} (label="${config.targetLabel}") · ${config.agentsToEnable ? config.agentsToEnable.length + ' agents' : 'all agents'}`);
