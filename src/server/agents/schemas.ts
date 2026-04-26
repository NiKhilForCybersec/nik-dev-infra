/* Per-agent Zod schemas for validating raw agent output (LLM or
 * deterministic) before it becomes a Finding. Each agent pins its
 * own `kind` enum so a malformed `kind: "drift"` from a drifty
 * prompt becomes a schema-rejected finding instead of leaking. */

import { z } from 'zod';

export const SeveritySchema = z.enum(['info', 'warn', 'error']);

const Base = z.object({
  severity: SeveritySchema,
  summary: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().nonnegative().optional(),
  suggestion: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
});

export const DriftFindingSchema = Base.extend({
  kind: z.enum([
    'drift:semantic',
    'drift:dead-write',
    'drift:missing-pagination',
    'drift:wrong-op',
  ]),
});

export const HardcodedFindingSchema = Base.extend({
  kind: z.enum([
    'hardcoded:sentence',
    'hardcoded:number',
    'hardcoded:time',
    'hardcoded:ratio',
  ]),
});

export const NavigationFindingSchema = Base.extend({
  kind: z.enum([
    'nav:broken-target',
    'nav:missing-route',
    'nav:wrong-target',
    'nav:stale-tile',
  ]),
});

export const RegistryFindingSchema = Base.extend({
  kind: z.enum([
    'registry:duplicate',
    'registry:summary',
  ]),
});

export const DatabaseFindingSchema = Base.extend({
  kind: z.enum([
    'db:column-mismatch',
    'db:type-mismatch',
    'db:missing-rls',
    'db:missing-index',
  ]),
});

export const HealthFindingSchema = Base.extend({
  kind: z.enum([
    'health:up',
    'health:degraded',
    'health:down',
    'health:summary',
    'health:no-targets',
  ]),
});

export const ConcernsFindingSchema = Base.extend({
  kind: z.enum([
    'concern:open',
    'concern:stale',
    'concern:unmapped',
  ]),
});

export const GraphFindingSchema = Base.extend({
  kind: z.enum([
    'graph:built',
    'graph:no-source',
  ]),
});

export const LlmCostFindingSchema = Base.extend({
  kind: z.enum([
    'llm:expensive-call',
    'llm:daily-summary',
    'llm:not-configured',
  ]),
});

export const SyncFindingSchema = Base.extend({
  kind: z.enum([
    'sync:different-op',
    'sync:live-vs-hardcoded',
    'sync:different-formula',
    'sync:stale-alias',
  ]),
});

export const AccessibilityFindingSchema = Base.extend({
  kind: z.enum([
    'a11y:icon-only-button',
    'a11y:color-only-state',
    'a11y:tap-target',
    'a11y:label-missing',
    'a11y:img-alt-missing',
    'a11y:keyboard-trap',
  ]),
});

export const BootstrapFindingSchema = Base.extend({
  kind: z.enum([
    'bootstrap:start',
    'bootstrap:complete',
    'bootstrap:no-source',
  ]),
});

export const OrchestratorFindingSchema = Base.extend({
  kind: z.enum([
    'hooks:fired',
  ]),
});

export const McpFindingSchema = Base.extend({
  kind: z.enum([
    'mcp:not-configured',
    'mcp:tool-added',
    'mcp:tool-removed',
    'mcp:server-down',
    'mcp:server-recovered',
    'mcp:summary',
  ]),
});

export const MemoryKeeperFindingSchema = Base.extend({
  kind: z.enum([
    'memory:orphan-fact-subject',
    'memory:orphan-fact-object',
    'memory:orphan-hook',
    'memory:orphan-wiki',
    'memory:low-confidence-facts',
    'memory:revisions-pruned',
    'memory:vacuum',
    'memory:vacuum-failed',
    'memory:completeness',
    'memory:integrity-summary',
  ]),
});

export const SecretsFindingSchema = Base.extend({
  kind: z.enum([
    'secrets:anthropic',
    'secrets:openai',
    'secrets:supabase-jwt',
    'secrets:aws-access',
    'secrets:github-pat',
    'secrets:github-app',
    'secrets:google-api',
    'secrets:slack',
    'secrets:private-key',
    'secrets:hex-32',
    'secrets:scan-summary',
    'secrets:no-source',
  ]),
});

export type RawFinding = z.infer<typeof Base>;

export const SCHEMA_BY_AGENT = {
  drift: DriftFindingSchema,
  hardcoded: HardcodedFindingSchema,
  navigation: NavigationFindingSchema,
  registry: RegistryFindingSchema,
  database: DatabaseFindingSchema,
  health: HealthFindingSchema,
  concerns: ConcernsFindingSchema,
  graph: GraphFindingSchema,
  'llm-cost': LlmCostFindingSchema,
  sync: SyncFindingSchema,
  secrets: SecretsFindingSchema,
  accessibility: AccessibilityFindingSchema,
  'memory-keeper': MemoryKeeperFindingSchema,
  mcp: McpFindingSchema,
  bootstrap: BootstrapFindingSchema,
  orchestrator: OrchestratorFindingSchema,
} as const;

export type AgentName = keyof typeof SCHEMA_BY_AGENT;
