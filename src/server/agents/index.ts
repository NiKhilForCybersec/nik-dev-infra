/* Agent registry. Adding a new agent = create the .ts + .md
 *  files in this dir + add an entry below. */

import { agentEnabled } from '../config.ts';
import type { Agent } from '../types.ts';
import { accessibilityAgent } from './accessibility.ts';
import { aiCoverageAgent } from './ai-coverage.ts';
import { bindingsAgent } from './bindings.ts';
import { bootstrapAgent } from './bootstrap.ts';
import { concernsAgent } from './concerns.ts';
import { curatorAgent } from './curator.ts';
import { databaseAgent } from './database.ts';
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
import { screenshotsAgent } from './screenshots.ts';
import { secretsAgent } from './secrets.ts';
import { selfAwarenessAgent } from './self-awareness.ts';
import { selfImproveAgent } from './self-improve.ts';
import { selfMonitorAgent } from './self-monitor.ts';
import { syncAgent } from './sync.ts';

/** Full registry. Order is the agent rail's display order. */
export const ALL_AGENTS: Agent[] = [
  registryAgent,        // deterministic — always works
  healthAgent,          // deterministic — pings external services
  graphAgent,           // deterministic — builds topology JSON
  llmCostAgent,         // deterministic — tails Supabase llm_calls table
  secretsAgent,         // deterministic — regex scan for committed secrets
  memoryKeeperAgent,    // deterministic — owner of the memory layer's integrity
  mcpAgent,             // deterministic — MCP server tool discovery
  proberAgent,          // deterministic — runtime endpoint reachability + p95
  screenshotsAgent,     // deterministic — watches screenshots folder + prunes
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
  selfImproveAgent,     // claude -p — proposes prompt diffs for problem agents
  curatorAgent,         // deterministic — cross-verifies + audits user concerns
];

/** Agents the daemon actually runs. Filtered by config.agentsToEnable —
 *  if null, all are enabled. Imports `AGENTS` get the filtered set. */
export const AGENTS: Agent[] = ALL_AGENTS.filter((a) => agentEnabled(a.name));
