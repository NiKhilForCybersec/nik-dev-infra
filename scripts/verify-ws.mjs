#!/usr/bin/env node
/* Phase 2.4 verifier — confirms the live broadcast chain.
 *
 * Connects to ws://127.0.0.1:5175/ws, expects a snapshot,
 * then waits for a live `run` or `finding` event. The registry
 * agent runs every 60s, so this should land within ~70s of
 * connecting (and immediately if the daemon just started, since
 * boot runs all agents).
 *
 * Usage:
 *   npm start        # in another terminal
 *   node scripts/verify-ws.mjs
 *
 * Exit 0 = chain works. Exit 1 = no live event.
 */

// Uses the global WebSocket built into Node 21+. No extra dep.

const URL = process.env.WS_URL ?? 'ws://127.0.0.1:5175/ws';
const TIMEOUT_MS = Number(process.env.WS_TIMEOUT ?? 75_000);

const t0 = Date.now();
let snapshotSeen = false;
let liveSeen = false;

console.log(`[verify] connecting to ${URL} (timeout ${TIMEOUT_MS / 1000}s)`);
const ws = new WebSocket(URL);

ws.addEventListener('open', () => {
  console.log(`[verify] connected in ${Date.now() - t0}ms`);
});

ws.addEventListener('message', (event) => {
  let msg;
  try { msg = JSON.parse(event.data.toString()); }
  catch { console.warn('[verify] non-JSON frame'); return; }

  if (msg.type === 'snapshot') {
    snapshotSeen = true;
    console.log(`[verify] ✓ snapshot · ${msg.findings?.length ?? 0} findings, ${msg.runs?.length ?? 0} runs, ${msg.agents?.length ?? 0} agents`);
  } else if (msg.type === 'finding') {
    liveSeen = true;
    console.log(`[verify] ✓ live finding · ${msg.finding.agent}/${msg.finding.kind} after ${Date.now() - t0}ms`);
    finish(0);
  } else if (msg.type === 'run') {
    liveSeen = true;
    console.log(`[verify] ✓ live run · ${msg.run.agent} (${msg.run.ok ? 'ok' : 'fail'}) after ${Date.now() - t0}ms`);
    finish(0);
  }
});

ws.addEventListener('error', () => {
  console.error('[verify] socket error');
  finish(2);
});

ws.addEventListener('close', () => {
  if (!liveSeen) {
    console.error('[verify] socket closed before any live event');
    finish(1);
  }
});

const timer = setTimeout(() => {
  console.error(`[verify] ✗ no live event in ${TIMEOUT_MS}ms (snapshot=${snapshotSeen})`);
  finish(1);
}, TIMEOUT_MS);

function finish(code) {
  clearTimeout(timer);
  try { ws.close(); } catch { /* */ }
  process.exit(code);
}
