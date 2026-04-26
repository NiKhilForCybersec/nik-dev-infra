/* Agent registry. Adding a new agent = create the .ts + .md
 *  files in this dir + add an entry below. */

import type { Agent } from '../types.ts';
import { accessibilityAgent } from './accessibility.ts';
import { concernsAgent } from './concerns.ts';
import { databaseAgent } from './database.ts';
import { driftAgent } from './drift.ts';
import { graphAgent } from './graph.ts';
import { hardcodedAgent } from './hardcoded.ts';
import { healthAgent } from './health.ts';
import { llmCostAgent } from './llm-cost.ts';
import { navigationAgent } from './navigation.ts';
import { registryAgent } from './registry.ts';
import { secretsAgent } from './secrets.ts';
import { syncAgent } from './sync.ts';

export const AGENTS: Agent[] = [
  registryAgent,        // deterministic — always works
  healthAgent,          // deterministic — pings external services
  graphAgent,           // deterministic — builds topology JSON
  llmCostAgent,         // deterministic — tails Supabase llm_calls table
  secretsAgent,         // deterministic — regex scan for committed secrets
  driftAgent,           // claude -p
  navigationAgent,      // claude -p
  hardcodedAgent,       // claude -p
  databaseAgent,        // claude -p (high reasoning; rare runs)
  concernsAgent,        // claude -p (small) — reads docs/Concerns.md
  syncAgent,            // claude -p — cross-screen value consistency
  accessibilityAgent,   // claude -p — WCAG-leaning quick wins
];
