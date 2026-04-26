#!/usr/bin/env node
/* Capture a screenshot of every screen entity in the register and
 * drop them into <repo>/<screenshotsDir>/<ScreenName>.png.
 *
 * Strategy for state-driven SPAs (the Nik shape):
 *   1. Load the dev URL with the saved storageState (auth).
 *   2. Wait for the app to render.
 *   3. For HomeScreen: screenshot the initial render.
 *   4. For OTHER screens: navigate to the More tab, click a tile
 *      whose visible text matches the screen's label, screenshot.
 *      The tile-click strategy is intentionally simple — it works
 *      for screens reached from a flat tile catalog. Edit the
 *      `navigateTo` function below to add per-screen routes if
 *      your app has cases that don't match the default.
 *
 * Usage:
 *   npm i -D playwright                  # one-time
 *   npx playwright install chromium
 *   node scripts/screenshots-login.mjs   # one-time auth save
 *   node scripts/take-screenshots.mjs    # this script
 *
 * Env:
 *   DEV_URL                 default http://localhost:5173/
 *   SCREEN_VIEWPORT         default 390x844 (iPhone 14 Pro-ish)
 *   SCREENSHOTS_LIMIT       default unlimited; cap for testing
 *   SCREENSHOT_TIMEOUT_MS   per-screen, default 8000
 *   ONLY_SCREENS            comma-separated; capture just these
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const DATA_DIR = resolve(ROOT, 'data');
const AUTH_PATH = resolve(DATA_DIR, 'playwright-auth.json');
const CONFIG_PATH = resolve(ROOT, 'dev-infra.config.json');

const DEV_URL = process.env.DEV_URL ?? 'http://localhost:5173/';
const VIEWPORT = (() => {
  const v = process.env.SCREEN_VIEWPORT ?? '390x844';
  const [w, h] = v.split('x').map((n) => parseInt(n, 10));
  return { width: Number.isFinite(w) ? w : 390, height: Number.isFinite(h) ? h : 844 };
})();
const TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 8000);
const LIMIT = Number(process.env.SCREENSHOTS_LIMIT ?? 0);
const ONLY = (process.env.ONLY_SCREENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error(`[shots] playwright is not installed.\n  Run:\n    npm i -D playwright\n    npx playwright install chromium\n  Then re-run this script.`);
  process.exit(2);
}

// ── Resolve the watched repo's screenshots dir ────────────────────────────
function targetScreenshotsDir() {
  let cfg = { targetPath: process.env.NIK_PATH ?? `${process.env.HOME}/NIK`, screenshotsDir: 'docs/screenshots' };
  if (existsSync(CONFIG_PATH)) {
    try {
      const j = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (typeof j.targetPath === 'string') cfg.targetPath = j.targetPath.replace(/^~\//, `${process.env.HOME}/`);
      if (typeof j.screenshotsDir === 'string') cfg.screenshotsDir = j.screenshotsDir;
    } catch (e) { console.warn(`[shots] could not parse ${CONFIG_PATH}: ${e.message}`); }
  }
  return resolve(cfg.targetPath, cfg.screenshotsDir);
}

// ── Pull screen list from the running daemon, fall back to filesystem ─────
async function listScreens() {
  try {
    const r = await fetch('http://127.0.0.1:5175/api/register?kind=screen');
    if (r.ok) {
      const j = await r.json();
      return j.entities.map((e) => ({ urn: e.urn, name: e.label, file: e.file }));
    }
  } catch { /* daemon not running, fall through */ }
  // Fallback: scan filesystem.
  const fs = await import('node:fs');
  const screensDir = resolve(targetScreenshotsDir(), '../../web/src/screens');
  if (!existsSync(screensDir)) return [];
  return fs.readdirSync(screensDir)
    .filter((f) => f.endsWith('Screen.tsx'))
    .map((f) => ({ urn: `screen:${f.replace('.tsx', '')}`, name: f.replace('.tsx', ''), file: `web/src/screens/${f}` }));
}

// ── Per-screen navigation ─────────────────────────────────────────────────
// The default strategy works for screens reachable via a More-tab tile
// catalog: open the app, click 'More', then click a tile whose visible
// text matches the screen label. Override per-screen in this map for
// edge cases. Returns true if navigation succeeded.
const CUSTOM_NAV = {
  HomeScreen: async (page) => { await page.goto(DEV_URL, { waitUntil: 'networkidle' }); return true; },
  // Add more as you discover the app's nav surface.
};

async function navigateTo(page, screenName) {
  const custom = CUSTOM_NAV[screenName];
  if (custom) return custom(page);
  // Default: home → More tab → tile click.
  try {
    await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_MS });
    // Look for a 'More' link/button. Many apps label it 'More' or have an icon button.
    const more = page.getByText(/^more$/i).first();
    if (await more.isVisible({ timeout: 2000 }).catch(() => false)) {
      await more.click();
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
    }
    // Now find a tile with text matching the screen's display label.
    // Strip 'Screen' suffix and try common tile-label transforms.
    const candidates = [
      screenName.replace(/Screen$/, ''),                                 // 'Hydration'
      screenName.replace(/Screen$/, '').replace(/([a-z])([A-Z])/g, '$1 $2'), // 'Family Ops'
    ];
    for (const candidate of candidates) {
      const tile = page.getByText(new RegExp(`^${candidate}$`, 'i')).first();
      if (await tile.isVisible({ timeout: 1500 }).catch(() => false)) {
        await tile.click({ timeout: 2000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
        return true;
      }
    }
    return false;
  } catch (e) {
    console.warn(`[shots] nav to ${screenName} threw: ${e.message}`);
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
const outDir = targetScreenshotsDir();
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

let screens = await listScreens();
if (ONLY.length > 0) screens = screens.filter((s) => ONLY.includes(s.name));
if (LIMIT > 0) screens = screens.slice(0, LIMIT);

console.log(`[shots] target dir: ${outDir}`);
console.log(`[shots] screens to capture: ${screens.length}${ONLY.length > 0 ? ` (filtered)` : ''}`);

const browser = await chromium.launch({ headless: true });
const context = existsSync(AUTH_PATH)
  ? await browser.newContext({ storageState: AUTH_PATH, viewport: VIEWPORT })
  : await browser.newContext({ viewport: VIEWPORT });
const page = await context.newPage();

let captured = 0, skipped = 0;
const startedAt = Date.now();
for (const s of screens) {
  const out = resolve(outDir, `${s.name}.png`);
  process.stdout.write(`[shots] ${s.name.padEnd(30)} `);
  const ok = await navigateTo(page, s.name);
  if (!ok) { console.log('SKIP (no nav)'); skipped++; continue; }
  try {
    await page.screenshot({ path: out, fullPage: false });
    console.log(`OK · ${out.replace(outDir + '/', '')}`);
    captured++;
  } catch (e) {
    console.log(`FAIL · ${e.message}`);
    skipped++;
  }
}

await browser.close();
console.log(`[shots] done · ${captured} captured · ${skipped} skipped · ${Math.round((Date.now() - startedAt) / 1000)}s`);
process.exit(skipped > 0 && captured === 0 ? 1 : 0);
