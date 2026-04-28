/* memnik-os observer integration (Phase 3.2 — additive, not yet wired).
 *
 * Pushes dev-infra findings into memnik-os as tier-2 observer envelopes
 * via @memnik-os/observer-sdk. Designed to coexist with the legacy WS
 * endpoint (memnik's old puller) — ALL existing finding paths are
 * unaffected. This module is harmless until imported.
 *
 * Hard guarantees:
 *   - No-op unless DEV_INFRA_MEMNIK_PUSH is truthy. Default off.
 *   - Never throws in pushFindingToMemnik / pushTransient / pushAttachment.
 *     Failures log + continue; SDK's local spool replays on reconnect.
 *   - The observer SDK auto-loads its bearer token from
 *     ~/.memnik-os/observers.json (mode 0600). We never read or copy it.
 *
 * Migration phase reference: corrected migration prompt § Phase 3.2.
 * Wiring (Phase 3.3) intentionally NOT done in this module — it lives
 * here as a self-contained library, called from one site once the
 * emission path is verified end-to-end.
 *
 * Token registration is a memnik-side action (already done on
 * 2026-04-28). Run the inverse from memnik to revoke: see
 * `memnik observers list` / `revoke` on that side.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Observer,
  type Family,
  type Kind,
  type Manifest,
  type ServerAck,
} from '@memnik-os/observer-sdk';
import type { Finding } from '../types.ts';

// Compliance report — when present, the manifest reports the report
// sha + passed_at to the bridge at handshake. The bridge uses these
// for the 90-day compliance recency check (stale report → downgrade
// to transient_only capability tier). Run `npm run compliance` to
// regenerate; the report itself is committed to the repo so the
// CI / deployed daemon both load the same one.
const COMPLIANCE_REPORT_PATH = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../compliance-reports/dev-infra.json');
})();

type ComplianceReport = {
  schema_version?: string;
  observer_id?: string;
  passed_overall?: boolean;
  ts_ms?: number;
  suite_version?: string;
  report_sha?: string;
};

function loadComplianceReport(): ComplianceReport | null {
  try {
    if (!existsSync(COMPLIANCE_REPORT_PATH)) return null;
    const r = JSON.parse(readFileSync(COMPLIANCE_REPORT_PATH, 'utf8')) as ComplianceReport;
    if (r.passed_overall !== true) return null;
    return r;
  } catch {
    return null;
  }
}

// memnik's SDK Family/Kind enums now match the DB CHECK constraint
// exactly (fixed in observer-sdk v0.0.0+ as of 2026-04-28). The local
// DbFamily/DbKind workarounds we used during the divergence are gone —
// the SDK's Family + Kind types are authoritative.
//
// Family ∈ 'people' | 'time' | 'place' | 'things' | 'ideas'
// Kind   ∈ 'identity' | 'preference' | 'project' | 'routine' | 'goal'
//        | 'constraint' | 'relationship' | 'strategy' | 'lesson'
//        | 'state' | 'boundary' | 'technical_decision' | 'risk'

// ─── env gate ────────────────────────────────────────────────────────

const PUSH_ENABLED = (() => {
  const v = (process.env.DEV_INFRA_MEMNIK_PUSH ?? '').toLowerCase().trim();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
})();

const OBSERVER_URL = process.env.MEMNIK_OBSERVER_URL ?? 'ws://127.0.0.1:5176/observer';
const OBSERVER_ID = 'dev-infra';

// ─── kind mapping (dev-infra finding → memnik (Family, Kind)) ────────
//
// Mapping per memnik's DB-validated family/kind contract. Every
// dev-infra finding maps to one of:
//   ideas  — design decisions / risks / lessons / open questions
//   things — artifacts (screenshots, captures) recorded as state
//   time   — events (lifecycle, telemetry, health checks) recorded as state
// Default is { ideas, state }.
//
// 'state' replaces the old 'event' / 'artifact' / 'note' values that
// were dropped from the Kind enum on 2026-04-28. The drop-folder and
// calendar reference observers in memnik now use the same { *, state }
// pattern for non-decision observations.

type KindMappingEntry = { family: Family; kind: Kind };

const FINDING_KIND_PREFIX_MAP: Array<[RegExp, KindMappingEntry]> = [
  // drift / structural / wiring — code design decisions
  [/^drift:/,                  { family: 'ideas',  kind: 'technical_decision' }],
  [/^nav:/,                    { family: 'ideas',  kind: 'technical_decision' }],
  [/^bindings:/,               { family: 'ideas',  kind: 'technical_decision' }],
  [/^db:/,                     { family: 'ideas',  kind: 'technical_decision' }],
  [/^hardcoded:/,              { family: 'ideas',  kind: 'technical_decision' }],
  [/^a11y:/,                   { family: 'ideas',  kind: 'technical_decision' }],
  [/^sync:/,                   { family: 'ideas',  kind: 'technical_decision' }],
  [/^ai-coverage:/,            { family: 'ideas',  kind: 'technical_decision' }],

  // concerns / resolutions — risks vs lessons learned
  [/^concern(s|s-ingest)?:/,   { family: 'ideas',  kind: 'risk'    }],
  [/^resolution(s|s-ingest)?:/,{ family: 'ideas',  kind: 'lesson'  }],

  // health / runtime telemetry — temporal state observations
  [/^health:/,                 { family: 'time',   kind: 'state' }],
  [/^prober:/,                 { family: 'time',   kind: 'state' }],
  [/^code-change:/,            { family: 'time',   kind: 'state' }],
  [/^screen-prober:/,          { family: 'time',   kind: 'state' }],
  [/^lifecycle:/,              { family: 'time',   kind: 'state' }],

  // visual artifacts — point-in-time state of a thing
  [/^screenshots:/,            { family: 'things', kind: 'state' }],
  [/^capture:/,                { family: 'things', kind: 'state' }],

  // graph / registry — structural facts about the codebase
  [/^graph:/,                  { family: 'ideas',  kind: 'technical_decision' }],
  [/^codebase-graph:/,         { family: 'ideas',  kind: 'technical_decision' }],
  [/^registry:/,               { family: 'ideas',  kind: 'technical_decision' }],
  [/^linker:/,                 { family: 'ideas',  kind: 'technical_decision' }],
];

function mapFindingKind(devInfraKind: string): KindMappingEntry {
  for (const [pattern, mapping] of FINDING_KIND_PREFIX_MAP) {
    if (pattern.test(devInfraKind)) return mapping;
  }
  return { family: 'ideas', kind: 'state' };
}

// ─── confidence mapping (severity → 0..1) ────────────────────────────

const SEVERITY_CONFIDENCE: Record<Finding['severity'], number> = {
  info: 0.6,
  warn: 0.75,
  error: 0.85,
};

// ─── singleton observer ──────────────────────────────────────────────

let observerInstance: Observer | null = null;
let startupPromise: Promise<Observer | null> | null = null;

// Push telemetry — exposed via memnikPushStatus() for /api/memnik/status.
const pushStats = {
  attempts: 0,
  acks: 0,
  errors: 0,
  resultCounts: {} as Record<string, number>,
  lastError: null as string | null,
  lastResult: null as string | null,
  eagerHandshakeOk: false,
};

function buildManifest(): Omit<Manifest, 'observer_id' | 'version' | 'schema_version'> & Partial<Pick<Manifest, 'version' | 'schema_version'>> {
  return {
    version: '0.1.0',
    capabilities: [
      'emit_segment',
      'emit_attachment',
      'emit_transient',
      'request_extraction',
      'retract_own',
    ],
    // dev-infra emits findings with kinds like 'drift:semantic'. The
    // mapping above resolves these to memnik (Family, Kind) per emit
    // call. The kind_mappings field below is a manifest-level hint for
    // memnik's bridge audit — the source-of-truth mapping happens in
    // mapFindingKind() at emit time.
    //
    // Values match memnik's DB CHECK + the SDK's now-correct enums.
    // 'screen' was 'project' before the SDK fix; now uses 'state'
    // (a screen is a snapshot of a UI's state in the things family).
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
    // Compliance attestation — present iff a passing report is on disk.
    // Stale reports (>90d) trigger a memnik-side capability downgrade.
    ...(() => {
      const r = loadComplianceReport();
      if (!r) return {};
      return {
        compliance_suite_version: r.suite_version,
        compliance_suite_passed_at: r.ts_ms,
        compliance_report_sha: r.report_sha,
      };
    })(),
  };
}

/** Lazy singleton — first caller bootstraps the Observer + WS connection.
 *  Subsequent callers reuse. Resolves to null when DEV_INFRA_MEMNIK_PUSH
 *  is off. NEVER rejects — failures return null so callers can use
 *  `if (!obs) return` without try/catch.
 *
 *  Resilience contract: the Observer instance is RETAINED even when the
 *  initial start() handshake fails (e.g. memnik bridge is down at boot).
 *  The SDK has its own reconnect-with-backoff loop that keeps trying;
 *  when it eventually establishes the WS, emit() works normally. While
 *  disconnected, emit() routes envelopes to the SDK's local spool and
 *  returns synthetic 'accepted' acks with `warning: 'spooled_offline'`.
 *  On reconnect, spooled envelopes replay; idempotency keys dedupe at
 *  the bridge.
 *
 *  We intentionally do NOT latch a `startupFailed` flag here. Latching
 *  would permanently disable push for the daemon's lifetime even after
 *  memnik returns — the opposite of the SDK's resilience design. */
export async function getMemnikObserver(): Promise<Observer | null> {
  if (!PUSH_ENABLED) return null;
  if (observerInstance) return observerInstance;
  if (startupPromise) return startupPromise;

  // The IIFE catches its own errors and returns the Observer instance
  // even when start() rejects (timeout, refused, etc) — so the SDK's
  // background reconnect loop owns recovery. The instance is created
  // up-front so we can return a usable handle even before handshake.
  startupPromise = (async () => {
    const obs = new Observer({
      observerId: OBSERVER_ID,
      url: OBSERVER_URL,
      manifest: buildManifest(),
    });
    observerInstance = obs;            // retain immediately
    try {
      await obs.start();
      pushStats.eagerHandshakeOk = true;
      // eslint-disable-next-line no-console
      console.log('[memnik-observer] eager handshake accepted');
    } catch (e) {
      // start() failed — but the SDK's reconnect-with-backoff is still
      // running in the background. Return the instance anyway; emit()
      // will spool until reconnect.
      // eslint-disable-next-line no-console
      console.warn(`[memnik-observer] eager handshake failed (${(e as Error).message}); SDK will keep reconnecting; emit() will spool`);
    }
    return obs;
  })();

  return startupPromise;
}

/** Push one dev-infra Finding to memnik as a segment envelope. Never
 *  throws. No-op when push is disabled or memnik is unreachable.
 *  Returns the memnik ack on success; null on disabled / failure
 *  (failures land in the SDK's local spool for reconnect-replay). */
export async function pushFindingToMemnik(
  finding: Finding,
  opts: { repo?: string } = {},
): Promise<ServerAck | null> {
  if (!PUSH_ENABLED) return null;
  const obs = await getMemnikObserver();
  if (!obs) return null;

  pushStats.attempts++;

  const { family, kind } = mapFindingKind(finding.kind);
  const summary = finding.suggestion
    ? `${finding.summary} — suggestion: ${finding.suggestion}`
    : finding.summary;

  try {
    // The SDK's URN minter expects the kind to be a valid identifier.
    // dev-infra finding-kinds contain ':' (e.g. "drift:semantic") which
    // is reserved as the namespace separator in the URN scheme. Replace
    // ':' with '_' for URN minting; the original kind text is preserved
    // in the segment body via the [agent/kind] prefix.
    const urnKind = finding.kind.replace(/[^a-zA-Z0-9_-]/g, '_');
    const ack = await obs.emit({
      type: 'segment',
      cell_urn: obs.urn(urnKind, finding.id),
      idempotency_key: `df-finding-${finding.id}`,
      payload: {
        text: `[${finding.agent}/${finding.kind}] ${summary}`,
        scope: `project:${opts.repo ?? 'default'}`,
        family,
        kind,
        source_type: 'webhook',
        source_span: finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : undefined,
        classification: 'inferred_segment',
        confidence: SEVERITY_CONFIDENCE[finding.severity] ?? 0.7,
      },
    });
    pushStats.acks++;
    pushStats.lastResult = ack.result;
    pushStats.resultCounts[ack.result] = (pushStats.resultCounts[ack.result] ?? 0) + 1;
    if (ack.result === 'rejected_invariant' || ack.result === 'quarantined') {
      // eslint-disable-next-line no-console
      console.warn(`[memnik-observer] ${ack.result} for ${finding.id}: ${ack.invariant ?? ack.warning ?? '(no detail)'}`);
    }
    return ack;
  } catch (e) {
    pushStats.errors++;
    const msg = (e as Error).message;
    pushStats.lastError = msg;
    // eslint-disable-next-line no-console
    console.warn(`[memnik-observer] emit failed (id=${finding.id}): ${msg}`);
    return null;
  }
}

/** Push a batch of transient events (e.g. partial-WAL decoded events,
 *  fast-changing telemetry that doesn't deserve a durable cell). The
 *  bridge summarises per (observer, hour) into the confirmation queue. */
export async function pushTransientToMemnik(
  events: Array<{ ts_ms: number; kind: string; data: unknown }>,
  windowMs = 60_000,
): Promise<ServerAck | null> {
  if (!PUSH_ENABLED) return null;
  if (events.length === 0) return null;
  const obs = await getMemnikObserver();
  if (!obs) return null;

  try {
    return await obs.emit({
      type: 'transient',
      payload: { events, window_ms: windowMs },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[memnik-observer] transient emit failed: ${(e as Error).message}`);
    return null;
  }
}

/** Push a binary attachment (screenshot, agent output, etc). memnik
 *  reads from disk via CAS — pass an absolute filesystem_path. */
export async function pushAttachmentToMemnik(opts: {
  sha256: string;
  filesystemPath: string;
  byteSize: number;
  mimeType: string;
  originalFilename?: string;
  caption?: string;
}): Promise<ServerAck | null> {
  if (!PUSH_ENABLED) return null;
  const obs = await getMemnikObserver();
  if (!obs) return null;

  try {
    return await obs.emit({
      type: 'attachment',
      cell_urn: obs.urn('file', opts.sha256),
      payload: {
        mime_type: opts.mimeType,
        byte_size: opts.byteSize,
        sha256: opts.sha256,
        filesystem_path: opts.filesystemPath,
        original_filename: opts.originalFilename,
        caption: opts.caption,
        privacy_label: 'project_private',
        cloud_allowed: false,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[memnik-observer] attachment emit failed: ${(e as Error).message}`);
    return null;
  }
}

/** Cleanly disconnect on shutdown. Drains spool first. */
export async function stopMemnikObserver(): Promise<void> {
  if (!observerInstance) return;
  try {
    await observerInstance.stop();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[memnik-observer] stop failed: ${(e as Error).message}`);
  } finally {
    observerInstance = null;
    startupPromise = null;
  }
}

/** Diagnostics: how many envelopes are queued in the local spool? */
export function memnikSpoolDepth(): number {
  return observerInstance?.spoolDepth() ?? 0;
}

/** Diagnostics: is push currently enabled, did the eager handshake
 *  succeed at boot, and what's the per-process telemetry?
 *
 *  Note on `connected`: the SDK doesn't expose its WS readyState
 *  publicly, so this field reflects "Observer instance exists" — i.e.
 *  push is configured and lazily-or-eagerly bootstrapped. Real-time
 *  connectedness is best inferred from `spoolDepth` (0 = drained,
 *  >0 = currently offline) plus `pushAttempts` vs `pushAcks` divergence.
 *  `eagerHandshakeOk` records whether the initial start() succeeded. */
export function memnikPushStatus(): {
  enabled: boolean;
  connected: boolean;
  eagerHandshakeOk: boolean;
  spoolDepth: number;
  observerId: string;
  url: string;
  pushAttempts: number;
  pushAcks: number;
  pushErrors: number;
  resultCounts: Record<string, number>;
  lastResult: string | null;
  lastError: string | null;
} {
  return {
    enabled: PUSH_ENABLED,
    connected: observerInstance !== null,
    eagerHandshakeOk: pushStats.eagerHandshakeOk,
    spoolDepth: memnikSpoolDepth(),
    observerId: OBSERVER_ID,
    url: OBSERVER_URL,
    pushAttempts: pushStats.attempts,
    pushAcks: pushStats.acks,
    pushErrors: pushStats.errors,
    resultCounts: { ...pushStats.resultCounts },
    lastResult: pushStats.lastResult,
    lastError: pushStats.lastError,
  };
}
