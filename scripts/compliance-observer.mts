#!/usr/bin/env node
/**
 * compliance-observer.mts — minimal observer wrapper for
 * @memnik-os/observer-compliance scenarios.
 *
 * The compliance suite spawns this script per scenario, sets
 * MEMNIK_OBSERVER_URL to a mock-server URL, and drives the test
 * by exchanging WS frames with the spawned observer. This wrapper
 * mirrors dev-infra's production manifest but speaks ONLY the
 * Observer Protocol — no Fastify, no 35 agents, no sqlite.
 *
 * Usage (manual):
 *   MEMNIK_OBSERVER_URL=ws://127.0.0.1:5176/observer \
 *     npx tsx scripts/compliance-observer.mts
 *
 * Usage (compliance harness):
 *   npx @memnik-os/observer-compliance run \
 *     --observer-cmd "npx tsx scripts/compliance-observer.mts" \
 *     --report ./compliance-reports/dev-infra.json
 */

import { Observer } from '@memnik-os/observer-sdk';

const url = process.env['MEMNIK_OBSERVER_URL']
  ?? 'ws://127.0.0.1:5176/observer';

const obs = new Observer({
  observerId: 'dev-infra',
  url,
  manifest: {
    version: '0.1.0',
    capabilities: [
      'emit_segment', 'emit_attachment', 'emit_transient',
      'request_extraction', 'retract_own',
    ],
    // Mirror src/server/integrations/memnik_observer.ts manifest.
    // Values match the SDK's now-correct Family/Kind enums (no casts
    // needed since 2026-04-28 SDK fix).
    kind_mappings: {
      module:     { family: 'ideas',  kind: 'technical_decision' },
      function:   { family: 'ideas',  kind: 'technical_decision' },
      screen:     { family: 'things', kind: 'state'              },
      op:         { family: 'ideas',  kind: 'technical_decision' },
      concern:    { family: 'ideas',  kind: 'risk'               },
      resolution: { family: 'ideas',  kind: 'lesson'             },
    },
    max_emit_rate_per_min: 300,
    owner_contact: 'https://github.com/NiKhilForCybersec/nik-dev-infra',
  },
  log: (msg) => process.stderr.write(`[compliance-observer] ${msg}\n`),
});

await obs.start();
process.stderr.write('[compliance-observer] started\n');

// Emit a representative segment so scenarios that test idempotency
// replay / inference-classification have real activity to verify.
try {
  await obs.emit({
    type: 'segment',
    cell_urn: obs.urn('drift_test', 'compliance-seed'),
    idempotency_key: 'compliance-seed-1',
    payload: {
      text: '[compliance/drift:test] sample observation for compliance suite',
      scope: 'project:compliance',
      family: 'ideas' as Family,
      kind: 'technical_decision' as Kind,
      source_type: 'webhook',
      source_span: 'compliance-observer.mts:1',
      classification: 'inferred_segment',
      confidence: 0.7,
    },
  });
} catch (e) {
  // The compliance suite scenarios may close the WS mid-emit; that's fine.
  process.stderr.write(`[compliance-observer] seed emit: ${(e as Error).message}\n`);
}

// Stay alive until killed by the compliance harness.
const shutdown = async () => {
  process.stderr.write('[compliance-observer] shutting down\n');
  try { await obs.stop(); } catch { /* */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Keep the event loop alive without spinning.
setInterval(() => { /* heartbeat */ }, 60_000).unref?.();
