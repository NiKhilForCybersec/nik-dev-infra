/* Agent registry. Adding a new agent = create the .ts + .md
 *  files in this dir + add an entry below. */

import { agentEnabled } from '../config.ts';
import type { Agent, RiskClass } from '../types.ts';
import { accessibilityAgent } from './accessibility.ts';
import { aiCoverageAgent } from './ai-coverage.ts';
import { autoFixDriverAgent } from './auto-fix-driver.ts';
import { codeChangeTrackerAgent } from './code-change-tracker.ts';
import { codebaseGraphAgent } from './codebase-graph.ts';
import { concernsIngestAgent } from './concerns-ingest.ts';
import { intentExtractorAgent } from './intent-extractor.ts';
import { linkerAgent } from './linker.ts';
import { resolutionsIngestAgent } from './resolutions-ingest.ts';
import { testCoverageAgent } from './test-coverage.ts';
import { bindingsAgent } from './bindings.ts';
import { bootstrapAgent } from './bootstrap.ts';
import { concernsAgent } from './concerns.ts';
import { curatorAgent } from './curator.ts';
import { databaseAgent } from './database.ts';
import { docIngestAgent } from './doc-ingest.ts';
import { driftAgent } from './drift.ts';
import { graphAgent } from './graph.ts';
import { hardcodedAgent } from './hardcoded.ts';
import { healthAgent } from './health.ts';
import { llmCostAgent } from './llm-cost.ts';
import { mcpAgent } from './mcp.ts';
import { memoryKeeperAgent } from './memory-keeper.ts';
import { navigationAgent } from './navigation.ts';
import { proberAgent } from './prober.ts';
import { registryAgent } from './registry.ts';
import { screenProberAgent } from './screen-prober.ts';
import { screenValidatorAgent } from './screen-validator.ts';
import { screenshotsAgent } from './screenshots.ts';
import { secretsAgent } from './secrets.ts';
import { selfAwarenessAgent } from './self-awareness.ts';
import { selfImproveAgent } from './self-improve.ts';
import { selfMonitorAgent } from './self-monitor.ts';
import { snapshotterAgent } from './snapshotter.ts';
import { syncAgent } from './sync.ts';

/** Full registry. Order is the agent rail's display order. */
export const ALL_AGENTS: Agent[] = [
  registryAgent,        // deterministic — always works
  healthAgent,          // deterministic — pings external services
  graphAgent,           // deterministic — builds topology JSON
  codebaseGraphAgent,   // deterministic — Tree-sitter AST extraction (user-repo knowledge graph phase 1)
  intentExtractorAgent, // claude -p — per-module intent summary (knowledge graph phase 2)
  testCoverageAgent,    // deterministic — exports without test coverage become Concerns.md gaps
  concernsIngestAgent,  // deterministic — Concerns.md bullets → memory entities (kind: concern)
  resolutionsIngestAgent, // deterministic — Resolutions.md entries → memory entities (kind: resolution); links to concerns
  codeChangeTrackerAgent, // deterministic — git log + git status → commit + file-activity entities + facts
  linkerAgent,          // deterministic — coordination layer: bridges pseudo-URN dead-ends + registers wiki cells + links commits↔concerns
  llmCostAgent,         // deterministic — tails Supabase llm_calls table
  secretsAgent,         // deterministic — regex scan for committed secrets
  memoryKeeperAgent,    // deterministic — owner of the memory layer's integrity
  mcpAgent,             // deterministic — MCP server tool discovery
  proberAgent,          // deterministic — runtime endpoint reachability + p95
  screenshotsAgent,     // deterministic — watches screenshots folder + prunes
  screenValidatorAgent, // deterministic — Layer-1 validation of every capture (sidecar + 7 checks)
  screenProberAgent,    // deterministic — spawns Playwright capture script (active capturer)
  snapshotterAgent,     // deterministic — atomic memory.db backups every 6h
  selfAwarenessAgent,   // deterministic — dev-infra describes itself in memory
  selfMonitorAgent,     // deterministic — per-agent latency / error / schema-rej metrics
  driftAgent,           // claude -p
  navigationAgent,      // claude -p
  hardcodedAgent,       // claude -p
  databaseAgent,        // claude -p (high reasoning; rare runs)
  concernsAgent,        // claude -p (small) — reads docs/Concerns.md
  syncAgent,            // claude -p — cross-screen value consistency
  accessibilityAgent,   // claude -p — WCAG-leaning quick wins
  bindingsAgent,        // claude -p — JSX field → op.field high-res wiring
  aiCoverageAgent,      // claude -p — every manual write/cmd needs an aiAffordance
  bootstrapAgent,       // claude -p — manual / one-shot project model build
  docIngestAgent,       // claude -p — reads README + vision docs into meta/intent wiki
  selfImproveAgent,     // claude -p — proposes prompt diffs for problem agents
  curatorAgent,         // deterministic — cross-verifies + audits user concerns
  autoFixDriverAgent,   // deterministic selector + claude -p dispatcher (opt-in continuous-dev loop)
];

/** Agents the daemon actually runs. Filtered by config.agentsToEnable —
 *  if null, all are enabled. Imports `AGENTS` get the filtered set. */
export const AGENTS: Agent[] = ALL_AGENTS.filter((a) => agentEnabled(a.name));

/** Per-agent risk class (per 12-patterns #10). Source of truth for the
 *  orchestrator's risk gate. Adding a new agent without an entry here
 *  causes a fail-fast at boot — see assertion below. */
export const RISK_CLASS_BY_AGENT: Record<string, RiskClass> = {
  // pure read — no side effects, no findings emitted
  // (none currently — every agent emits findings = write-memory)

  // external-call — outbound HTTP / probes
  health:        'external-call',
  'llm-cost':    'external-call',
  mcp:           'external-call',
  prober:        'external-call',

  // write-memory — emits findings + may write to our data/
  registry:        'write-memory',
  graph:           'write-memory',
  'codebase-graph':'write-memory',
  'intent-extractor':'write-memory',
  'test-coverage': 'write-memory',
  'concerns-ingest': 'write-memory',
  'resolutions-ingest': 'write-memory',
  'code-change-tracker': 'write-memory',
  linker:          'write-memory',
  secrets:         'write-memory',
  'memory-keeper': 'write-memory',
  screenshots:     'write-user-repo',  // unlinkSync of PNGs in <repo>/docs/screenshots — gated by riskGate.allowWriteUserRepo
  'screen-validator':'write-memory',   // pure read of PNGs + sidecars; emits findings only
  'screen-prober': 'external-call',    // spawns Playwright; outbound HTTP to dev server. PNG writes go to a generated-artifact folder, not source — same shape as test logs.
  snapshotter:     'write-memory',     // writes to data/snapshots/, prunes own archives
  'self-awareness':'write-memory',
  'self-monitor':  'write-memory',
  drift:           'write-memory',
  navigation:      'write-memory',
  hardcoded:       'write-memory',
  database:        'write-memory',
  concerns:        'write-memory',
  sync:            'write-memory',
  accessibility:   'write-memory',
  bindings:        'write-memory',
  'ai-coverage':   'write-memory',
  bootstrap:       'write-memory',
  'doc-ingest':    'write-memory',

  // write-prompt — can edit dev-infra's own .md files (gated)
  'self-improve':  'write-prompt',

  // write-user-repo — can edit Concerns.md / CLAUDE.md (gated)
  curator:         'write-user-repo',
  // auto-fix-driver dispatches `claude -p` with Edit/Write tools INTO the
  // user's repo. Highest-trust class. Gated by writeback.enabled +
  // riskGate.allowWriteUserRepo at the orchestrator level AND
  // autoFixLoop.enabled inside the agent itself. All three required.
  'auto-fix-driver': 'write-user-repo',
};

// Boot-time fail-fast: every shipped agent must have a riskClass.
for (const a of ALL_AGENTS) {
  if (!RISK_CLASS_BY_AGENT[a.name]) {
    throw new Error(`[risk] agent "${a.name}" has no riskClass entry in RISK_CLASS_BY_AGENT — add one before booting`);
  }
}
