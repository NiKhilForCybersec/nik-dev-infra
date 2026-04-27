#!/usr/bin/env node
/* nik-dev-infra · setup wizard
 *
 * Interactive (or flag-driven) bootstrap for `dev-infra.config.json`.
 * Auto-detects the watched repo's stack (Vite / Next / Remix / etc.)
 * + screen / backend / migration globs, prompts for confirmation,
 * writes the config into THIS repo's root.
 *
 * Hard-path: if detection is ambiguous (multiple frameworks, multiple
 * candidate screen dirs), prompt the user — never silently pick. The
 * setup is one-time and getting it wrong wastes hours of confusing
 * "why isn't my agent running on file X" debugging.
 *
 * Usage:
 *   node scripts/init.mjs                                    # interactive
 *   node scripts/init.mjs --target ~/MyApp --label MyApp    # non-interactive
 *   node scripts/init.mjs --detect-only ~/MyApp              # dry-run, print only
 *   node scripts/init.mjs --help
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline/promises';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..');
const CONFIG_FILE = resolve(REPO_ROOT, 'dev-infra.config.json');

// ─── arg parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--help' || a === '-h') { flags.help = true; continue; }
  if (a === '--detect-only') { flags.detectOnly = args[i + 1]; i++; continue; }
  if (a === '--target') { flags.target = args[i + 1]; i++; continue; }
  if (a === '--label') { flags.label = args[i + 1]; i++; continue; }
  if (a === '--non-interactive' || a === '-y') { flags.nonInteractive = true; continue; }
  console.warn(`[init] unknown arg: ${a}`);
}

if (flags.help) {
  console.log(`nik-dev-infra · setup wizard

usage:
  node scripts/init.mjs                              interactive wizard
  node scripts/init.mjs --target <path> [--label N]  detect + write (still prompts unless -y)
  node scripts/init.mjs --target <path> -y           detect + write, no prompts
  node scripts/init.mjs --detect-only <path>         show detected config, don't write
  node scripts/init.mjs --help                       this message
`);
  process.exit(0);
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (!isAbsolute(p)) return resolve(process.cwd(), p);
  return p;
}

// ─── detection ──────────────────────────────────────────────────────────────

function detect(targetPath) {
  const target = expandPath(targetPath);
  if (!existsSync(target)) throw new Error(`target path doesn't exist: ${target}`);
  // Walk a small set of likely package.json locations — many real repos
  // are workspaces where deps live in subdirs (e.g. NIK's web/package.json).
  const pkgCandidates = [
    'package.json',
    'web/package.json',
    'app/package.json',
    'apps/web/package.json',
    'packages/web/package.json',
    'frontend/package.json',
    'client/package.json',
  ];
  let pkg = null;
  let pkgPath = null;
  const allDeps = {};
  for (const rel of pkgCandidates) {
    const p = resolve(target, rel);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      Object.assign(allDeps, j.dependencies ?? {}, j.devDependencies ?? {});
      if (!pkg) { pkg = j; pkgPath = p; }
    } catch { /* */ }
  }

  const has = (name) => name in allDeps;
  // Config-file fallback for framework detection (catches stacks where deps
  // live in workspaces we didn't enumerate).
  const fileExistsAtTop = (rel) => existsSync(resolve(target, rel))
    || existsSync(resolve(target, 'web', rel))
    || existsSync(resolve(target, 'apps/web', rel));
  const dirExists = (rel) => {
    try { return statSync(resolve(target, rel)).isDirectory(); }
    catch { return false; }
  };
  const fileExists = (rel) => existsSync(resolve(target, rel));
  const findScreenFiles = (rel) => {
    if (!dirExists(rel)) return 0;
    try {
      return readdirSync(resolve(target, rel))
        .filter((n) => /Screen\.(tsx|jsx)$/.test(n)).length;
    } catch { return 0; }
  };

  const hasViteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'].some(fileExistsAtTop);
  const hasNextConfig = ['next.config.ts', 'next.config.js', 'next.config.mjs'].some(fileExistsAtTop);
  const hasRemixConfig = ['remix.config.ts', 'remix.config.js'].some(fileExistsAtTop);
  const hasSvelteConfig = ['svelte.config.ts', 'svelte.config.js'].some(fileExistsAtTop);

  const framework = (has('next') || hasNextConfig) ? 'next'
    : (has('@remix-run/react') || hasRemixConfig) ? 'remix'
    : (has('@sveltejs/kit') || hasSvelteConfig) ? 'sveltekit'
    : (has('vite') || hasViteConfig) && has('react') ? 'vite-react'
    : (has('vite') || hasViteConfig) && has('vue') ? 'vite-vue'
    : (has('vite') || hasViteConfig) ? 'vite'
    : has('expo') ? 'expo'
    : has('react-native') ? 'react-native'
    : has('react') ? 'react'
    : 'unknown';

  // Screens glob — try common locations + count *Screen files. Pick the dir
  // with the most matches; fall back to a permissive multi-glob if nothing
  // hits cleanly.
  const screenCandidates = [
    'web/src/screens',
    'src/screens',
    'app/screens',
    'screens',
    'src/pages',
    'app',         // Next.js app dir uses page.tsx not *Screen.tsx; would be 0
  ];
  const screenScores = screenCandidates
    .map((rel) => ({ rel, count: findScreenFiles(rel) }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);
  const screensGlob = screenScores.length > 0
    ? `${screenScores[0].rel}/*Screen.{tsx,jsx}`
    : (framework === 'next' ? 'app/**/page.{tsx,jsx}' : null);

  const contractsDir = ['web/src/contracts', 'src/contracts', 'contracts'].find(dirExists) ?? null;
  const manifestsGlob = screensGlob ? screensGlob.replace('*Screen.{tsx,jsx}', '*.manifest.ts') : null;

  const migrationsGlob = ['supabase/migrations', 'prisma/migrations', 'migrations', 'db/migrations']
    .find(dirExists);

  const backendDirs = [
    'supabase/functions',
    'app/api',
    'pages/api',
    'src/api',
    'src/server',
    'server',
    'backend',
  ].filter(dirExists);

  const frontendGlobs = [];
  if (dirExists('web/src')) frontendGlobs.push('web/src/**/*.{ts,tsx,js,jsx}');
  if (dirExists('src')) frontendGlobs.push('src/**/*.{ts,tsx,js,jsx}');
  if (dirExists('app') && framework === 'next') frontendGlobs.push('app/**/*.{ts,tsx,js,jsx}');
  if (frontendGlobs.length === 0) frontendGlobs.push('**/*.{ts,tsx,js,jsx}');

  const watchGlobs = [];
  if (frontendGlobs.length > 0) watchGlobs.push(...frontendGlobs);
  if (migrationsGlob) watchGlobs.push(`${migrationsGlob}/*.sql`);
  if (dirExists('docs')) watchGlobs.push('docs/**/*.md');

  const screenshotsDir = dirExists('docs/screenshots') || dirExists('docs') ? 'docs/screenshots' : 'docs/screenshots';
  const concernsFile = fileExists('docs/Concerns.md') ? 'docs/Concerns.md'
    : fileExists('CONCERNS.md') ? 'CONCERNS.md'
    : 'docs/Concerns.md';
  const resolutionsFile = fileExists('docs/Resolutions.md') ? 'docs/Resolutions.md'
    : fileExists('RESOLUTIONS.md') ? 'RESOLUTIONS.md'
    : 'docs/Resolutions.md';
  const claudeMdFile = fileExists('CLAUDE.md') ? 'CLAUDE.md' : 'CLAUDE.md';

  const labelGuess = pkg?.name ?? target.split('/').filter(Boolean).pop() ?? 'project';

  return {
    target,
    label: labelGuess,
    framework,
    pkg,
    detected: {
      screensGlob,
      contractsDir,
      manifestsGlob,
      migrationsGlob: migrationsGlob ? `${migrationsGlob}/*.sql` : null,
      backendDirs,
      frontendGlobs,
      watchGlobs,
      screenshotsDir,
      concernsFile,
      resolutionsFile,
      claudeMdFile,
    },
    notes: {
      screenScores,
      hasClaudeMd: fileExists('CLAUDE.md'),
      hasConcerns: fileExists(concernsFile),
      hasResolutions: fileExists(resolutionsFile),
    },
  };
}

function summarize(d) {
  const { target, label, framework, detected, notes } = d;
  const line = (k, v) => console.log(`  ${k.padEnd(18)} ${v ?? '(not detected)'}`);
  console.log(`\nDetected for ${target} (${label}):`);
  line('framework', framework);
  line('screensGlob', detected.screensGlob);
  line('contractsDir', detected.contractsDir);
  line('manifestsGlob', detected.manifestsGlob);
  line('migrationsGlob', detected.migrationsGlob);
  line('backendDirs', detected.backendDirs.length ? detected.backendDirs.join(', ') : null);
  line('frontendGlobs', detected.frontendGlobs.join(', '));
  line('screenshotsDir', detected.screenshotsDir);
  line('concernsFile', `${detected.concernsFile} ${notes.hasConcerns ? '(exists)' : '(will be created)'}`);
  line('resolutionsFile', `${detected.resolutionsFile} ${notes.hasResolutions ? '(exists)' : '(created on first fix)'}`);
  line('claudeMdFile', `${detected.claudeMdFile} ${notes.hasClaudeMd ? '(exists)' : '(will be created when curator gate enabled)'}`);
  if (notes.screenScores.length > 1) {
    console.log(`\n  ⚠ Multiple screen dirs found:`);
    for (const s of notes.screenScores) console.log(`    ${s.rel} → ${s.count} *Screen file(s)`);
    console.log(`    Picked the highest count. Override below if needed.`);
  }
  if (!detected.screensGlob) {
    console.log(`\n  ⚠ No screensGlob detected — the screen-validator + screens gallery will sit idle until you set one.`);
  }
}

function buildConfig(d, overrides = {}) {
  const cfg = {
    targetPath: overrides.targetPath ?? d.target,
    targetLabel: overrides.label ?? d.label,
    watchGlobs: d.detected.watchGlobs,
    contractsDir: d.detected.contractsDir,
    screensGlob: d.detected.screensGlob,
    manifestsGlob: d.detected.manifestsGlob,
    migrationsGlob: d.detected.migrationsGlob,
    backendDirs: d.detected.backendDirs,
    frontendGlobs: d.detected.frontendGlobs,
    mcpServers: [],
    concernsFile: d.detected.concernsFile,
    resolutionsFile: d.detected.resolutionsFile,
    claudeMdFile: d.detected.claudeMdFile,
    screenshotsDir: d.detected.screenshotsDir,
    writeback: { enabled: false, insertClaudeMdGate: false },
    riskGate: { allowWritePrompt: false, allowWriteUserRepo: false },
    agentBudgets: {
      defaultMaxRunsPerDay: 2000,
      overrides: {
        drift: 300, navigation: 300, hardcoded: 300, database: 200,
        sync: 150, accessibility: 150, bindings: 200, 'ai-coverage': 150,
        bootstrap: 100, 'doc-ingest': 100, concerns: 100,
        'self-improve': 30, curator: 200,
      },
    },
    agentsToEnable: null,
    autoFixLoop: {
      enabled: false,
      dryRun: true,
      maxCyclesPerDay: 1,
      maxConsecutiveFailures: 3,
      killSwitchFile: '.dev-infra-pause',
      scopes: ['docs/**', '*.md', '*.json'],
    },
  };
  return cfg;
}

function writeConfig(cfg) {
  // Preserve existing file's other fields if it exists (so re-running init
  // doesn't blow away manual tweaks like custom mcpServers or
  // riskGate / writeback toggles).
  let merged = cfg;
  if (existsSync(CONFIG_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      merged = { ...existing, ...cfg };
      // Deep-merge a couple of well-known nested objects so the user's
      // toggles aren't clobbered.
      if (existing.writeback) merged.writeback = { ...cfg.writeback, ...existing.writeback };
      if (existing.riskGate) merged.riskGate = { ...cfg.riskGate, ...existing.riskGate };
      if (existing.autoFixLoop) merged.autoFixLoop = { ...cfg.autoFixLoop, ...existing.autoFixLoop };
    } catch { /* malformed — overwrite */ }
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n');
  return CONFIG_FILE;
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (flags.detectOnly) {
    const d = detect(flags.detectOnly);
    summarize(d);
    console.log(`\n(detect-only — config NOT written)`);
    return;
  }

  let targetPath = flags.target;
  let label = flags.label;

  if (!targetPath) {
    if (flags.nonInteractive) {
      console.error(`[init] --target is required in non-interactive mode`);
      process.exit(2);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    targetPath = (await rl.question(`Path to the watched repo (e.g. ~/MyApp): `)).trim();
    rl.close();
  }
  if (!targetPath) { console.error(`[init] target path is required`); process.exit(2); }

  const d = detect(targetPath);
  if (label) d.label = label;
  summarize(d);

  if (!flags.nonInteractive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const labelOverride = (await rl.question(`\nLabel for the dashboard [${d.label}]: `)).trim();
    if (labelOverride) d.label = labelOverride;
    if (d.notes.screenScores.length > 1 || !d.detected.screensGlob) {
      const screensOverride = (await rl.question(`screensGlob [${d.detected.screensGlob ?? '(none)'}]: `)).trim();
      if (screensOverride) d.detected.screensGlob = screensOverride;
    }
    const confirm = (await rl.question(`\nWrite config to ${CONFIG_FILE}? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (confirm === 'n' || confirm === 'no') {
      console.log(`[init] aborted — no file written`);
      return;
    }
  }

  const cfg = buildConfig(d);
  const path = writeConfig(cfg);
  console.log(`\n✓ wrote ${path}`);
  console.log(`\nNext:`);
  console.log(`  npm install`);
  console.log(`  npm start             # daemon on :5175, dashboard on :5174`);
  if (d.detected.screensGlob) {
    console.log(`  npm i -D playwright   # for screen-prober (optional but recommended)`);
    console.log(`  npx playwright install chromium`);
    console.log(`  npm run screenshots:login   # one-time auth seed`);
  }
}

main().catch((e) => {
  console.error(`[init] ${e.message}`);
  process.exit(1);
});
