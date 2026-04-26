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
// Default 15s — SPAs with persistent websockets / polling never reach
// networkidle, and the legacy 8s was tripping page.goto. We use
// `domcontentloaded` for navigation events + a fixed settle wait
// inside bypassAuthIfPresent + per-step `waitForLoadState('networkidle')`
// with `.catch(() => {})` so a never-idle network doesn't fail the run.
const TIMEOUT_MS = Number(process.env.SCREENSHOT_TIMEOUT_MS ?? 15000);
const LIMIT = Number(process.env.SCREENSHOTS_LIMIT ?? 0);
const ONLY = (process.env.ONLY_SCREENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const FULL_PAGE = process.env.SCREENSHOT_FULL_PAGE === '1' || process.env.SCREENSHOT_FULL_PAGE === 'true';

/** Tile-label aliases for cases where the screen's class name doesn't match
 *  the tile text in the More-tab catalog. Keyed on the screen class name
 *  (e.g. `BucketlistScreen`); value is the visible tile label. The default
 *  navigation strategy tries these first, then falls back to the
 *  case-split + literal patterns. Add entries here as you discover
 *  more in your app. */
const SCREEN_ALIASES = {
  BucketlistScreen:  'Bucket List',
  CircleScreen:      'Family Circle',
  DoctorsScreen:     'Care Team',
  KidsScreen:        'Kids View',
  TimecapsuleScreen: 'Time Capsule',
  SideprojectsScreen:'Side Projects',
  FamilyOpsScreen:   'Family Ops',
};

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

/** If the app renders an auth gate first (login screen with a
 *  "Continue as demo user" / "Sign in" / "Skip" affordance), click it
 *  once so subsequent screen captures see the actual app. The function
 *  is idempotent — safe to call before every screen since clicking
 *  nothing is a no-op. Returns true if a button was clicked. */
async function bypassAuthIfPresent(page) {
  const candidates = [
    /^continue as demo user$/i,
    /^continue as guest$/i,
    /^skip$/i,
    /^try without account$/i,
    /^try the demo$/i,
  ];
  for (const re of candidates) {
    try {
      const btn = page.getByText(re).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        // Wait for the auth chrome to actually leave the DOM. Without
        // this we screenshot the "Signing in..." spinner mid-transition.
        await page.waitForFunction(
          () => {
            const text = document.body.innerText || '';
            return !/sign in|signing in|create account|continue as demo user|continue with google/i.test(text);
          },
          { timeout: 8000 },
        ).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
        // Settle render after auth — networkidle can fire before the SPA
        // has actually committed the post-auth view. 2.5s is well under
        // a noticeable wait, well over React commit + lazy-suspense.
        await page.waitForTimeout(2500);
        return true;
      }
    } catch { /* */ }
  }
  return false;
}

// ── Per-screen navigation ─────────────────────────────────────────────────
// The default strategy works for screens reachable via a More-tab tile
// catalog: open the app, click 'More', then click a tile whose visible
// text matches the screen label. Override per-screen in this map for
// edge cases. Returns true if navigation succeeded.
const CUSTOM_NAV = {
  HomeScreen: async (page) => {
    await page.goto(DEV_URL, { waitUntil: 'networkidle' });
    await bypassAuthIfPresent(page);
    return true;
  },
  // Add more as you discover the app's nav surface.
};

async function navigateTo(page, screenName) {
  const custom = CUSTOM_NAV[screenName];
  if (custom) return { ok: await custom(page), strategy: `custom:${screenName}` };
  // Default: home → More tab → tile click.
  try {
    await page.goto(DEV_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    await bypassAuthIfPresent(page);
    // Look for a 'More' link/button. Many apps label it 'More' or have an icon button.
    const more = page.getByText(/^more$/i).first();
    if (await more.isVisible({ timeout: 2000 }).catch(() => false)) {
      await more.click();
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
    }
    // Tile label candidates, in priority order:
    //   1. Explicit alias if registered.
    //   2. Strip 'Screen' suffix.
    //   3. Case-split (e.g. 'FamilyOps' → 'Family Ops').
    const stem = screenName.replace(/Screen$/, '');
    const candidates = [
      SCREEN_ALIASES[screenName],
      stem,
      stem.replace(/([a-z])([A-Z])/g, '$1 $2'),
    ].filter(Boolean);
    const seen = new Set();
    // Tiles can be below-the-fold; isVisible() only returns true for
    // elements in the DOM and not display:none — but it ALSO requires
    // the element to be in the visible viewport. Tiles further down in
    // the More-tab tile catalog flunk that check even though they're
    // perfectly clickable. Skip the visibility precheck — click()
    // itself auto-scrolls the target into view + waits for actionable.
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Two-strategy match: first try exact-text (anchored regex), then
      // fall back to substring (tile button often wraps the label + a
      // subtitle in the same accessible name, e.g. "Care Team Doctors ·
      // history · insurance" — anchored ^ ... $ never matches that).
      const exact = page.getByText(new RegExp(`^${escaped}$`, 'i')).first();
      const partial = page.getByText(new RegExp(escaped, 'i')).first();
      for (const target of [exact, partial]) {
        try {
          await target.click({ timeout: 3000 });
          await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS }).catch(() => {});
          return { ok: true, strategy: `tile-click:More:${candidate}` };
        } catch { /* try the next */ }
      }
    }
    return { ok: false, strategy: `tile-not-found:${candidates.join('|')}` };
  } catch (e) {
    console.warn(`[shots] nav to ${screenName} threw: ${e.message}`);
    return { ok: false, strategy: `nav-error:${e.message.slice(0, 80)}` };
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

// Track per-page console + network so the sidecar has signal beyond the
// pixels. Cleared between screens.
let consoleErrors = [];
let pendingRequests = new Set();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
page.on('request', (r) => pendingRequests.add(r.url()));
page.on('requestfinished', (r) => pendingRequests.delete(r.url()));
page.on('requestfailed', (r) => pendingRequests.delete(r.url()));

async function writeSidecar(screenName, opts) {
  const fs = await import('node:fs');
  const meta = {
    url: page.url(),
    viewport: VIEWPORT,
    capturedAt: new Date().toISOString(),
    elapsedMs: opts.elapsedMs,
    navStrategyUsed: opts.strategy,
    fullPage: !!FULL_PAGE,
    sizeBytes: opts.sizeBytes ?? null,
    consoleErrors: consoleErrors.slice(),
    pendingNetworkAtCapture: [...pendingRequests],
    domSnapshot: opts.dom?.slice(0, 200_000) ?? null,
    scrollHeight: opts.scrollHeight ?? null,
    imagesIncomplete: opts.imagesIncomplete ?? null,
  };
  fs.writeFileSync(resolve(outDir, `${screenName}.meta.json`), JSON.stringify(meta, null, 2));
}

let captured = 0, skipped = 0;
const startedAt = Date.now();
for (const s of screens) {
  consoleErrors = [];
  pendingRequests = new Set();
  const out = resolve(outDir, `${s.name}.png`);
  const screenStart = Date.now();
  process.stdout.write(`[shots] ${s.name.padEnd(30)} `);
  const navResult = await navigateTo(page, s.name);
  if (!navResult.ok) {
    console.log(`SKIP (${navResult.strategy})`);
    skipped++;
    await writeSidecar(s.name, { elapsedMs: Date.now() - screenStart, strategy: navResult.strategy });
    continue;
  }
  try {
    // Sidecar signal collection BEFORE screenshot (DOM is the truth at
    // this moment in time; wait until after for image-decoded check).
    const dom = await page.content().catch(() => null);
    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => null);
    const imagesIncomplete = await page.evaluate(() => [...document.images].filter((img) => !img.complete || img.naturalWidth === 0).length).catch(() => null);

    await page.screenshot({ path: out, fullPage: FULL_PAGE });
    const sizeBytes = (await import('node:fs')).statSync(out).size;
    await writeSidecar(s.name, {
      elapsedMs: Date.now() - screenStart,
      strategy: navResult.strategy,
      sizeBytes, dom, scrollHeight, imagesIncomplete,
    });
    console.log(`OK · ${(sizeBytes / 1024).toFixed(0)}k · ${navResult.strategy}`);
    captured++;
  } catch (e) {
    console.log(`FAIL · ${e.message}`);
    skipped++;
    await writeSidecar(s.name, { elapsedMs: Date.now() - screenStart, strategy: `screenshot-error:${e.message.slice(0, 80)}` });
  }
}

await browser.close();
console.log(`[shots] done · ${captured} captured · ${skipped} skipped · ${Math.round((Date.now() - startedAt) / 1000)}s · fullPage=${FULL_PAGE}`);
process.exit(skipped > 0 && captured === 0 ? 1 : 0);
