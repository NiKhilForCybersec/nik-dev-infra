#!/usr/bin/env node
/* One-time auth bootstrap for take-screenshots.mjs.
 *
 * Opens a headed Playwright browser at the configured dev URL, lets
 * you log into the watched app by hand, then on Enter dumps the
 * cookies + localStorage as data/playwright-auth.json. The capture
 * script reuses that JSON so every screenshot run inherits the
 * session — no re-login per run.
 *
 * Usage (from repo root):
 *   npm i -D playwright            # one-time; ~50 MB npm + 170 MB Chromium
 *   npx playwright install chromium
 *   node scripts/screenshots-login.mjs
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
const DATA_DIR = resolve(ROOT, 'data');
const AUTH_PATH = resolve(DATA_DIR, 'playwright-auth.json');

const DEV_URL = process.env.DEV_URL ?? 'http://localhost:5173/';

let chromium;
try { ({ chromium } = await import('playwright')); }
catch {
  console.error(`[login] playwright is not installed.\n  Run:\n    npm i -D playwright\n    npx playwright install chromium\n  Then re-run this script.`);
  process.exit(2);
}

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

console.log(`[login] opening ${DEV_URL} in a headed browser`);
console.log(`[login] log in by hand, then press <Enter> in this terminal to save the session`);

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(DEV_URL, { waitUntil: 'domcontentloaded' });

// Wait for stdin <Enter>.
process.stdin.resume();
await new Promise((resolveOk) => process.stdin.once('data', resolveOk));

await context.storageState({ path: AUTH_PATH });
console.log(`[login] saved storageState to ${AUTH_PATH}`);
await browser.close();
process.exit(0);
