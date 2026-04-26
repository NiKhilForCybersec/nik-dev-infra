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
  /** Concerns markdown file, relative to targetPath. */
  concernsFile: z.string(),
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
  claudeMdFile: 'CLAUDE.md',
  screenshotsDir: 'docs/screenshots',
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
