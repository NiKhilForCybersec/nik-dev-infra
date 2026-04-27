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
    'graph:orphan-op',
    'graph:orphan-cmd',
    'graph:orphan-endpoint',
    'graph:orphan-llm-provider',
    'graph:silent-screen',
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

export const SelfAwarenessFindingSchema = Base.extend({
  kind: z.enum([
    'self:described',
  ]),
});

export const SelfMonitorFindingSchema = Base.extend({
  kind: z.enum([
    'self:agent-slow',
    'self:agent-failing',
    'self:prompt-broken',
    'self:agent-silent',
    'self:metrics-summary',
  ]),
});

export const SelfImproveFindingSchema = Base.extend({
  kind: z.enum([
    'self:prompt-diff-proposal',
    'self:no-improvements-needed',
    'self:agent-prompt-missing',
  ]),
});

export const DocIngestFindingSchema = Base.extend({
  kind: z.enum([
    'doc-ingest:summary',
    'doc-ingest:read-failed',
    'doc-ingest:no-docs',
  ]),
});


export const ProberFindingSchema = Base.extend({
  kind: z.enum([
    'prober:up',
    'prober:down',
    'prober:summary',
    'prober:skipped',
    'prober:no-endpoints',
  ]),
});

export const AiCoverageFindingSchema = Base.extend({
  kind: z.enum([
    'ai-coverage:write-not-affordable',
    'ai-coverage:command-not-affordable',
    'ai-coverage:read-only-screen',
    'ai-coverage:no-affordances-declared',
    'ai-coverage:summary',
  ]),
});

export const BindingsFindingSchema = Base.extend({
  kind: z.enum([
    'binding:found',
    'binding:dynamic',
    'binding:uncertain',
    'binding:no-source',
  ]),
});

export const CuratorFindingSchema = Base.extend({
  kind: z.enum([
    'curator:summary',
    'curator:promoted',
    'curator:suppressed',
    'curator:write-disabled',
    'curator:write-failed',
    'curator:claudemd-updated',
    // Audit-mode kinds (D.5.5) — verdicts on each existing Concerns.md entry
    'curator:concern-resolved',
    'curator:concern-unaddressed',
    'curator:concern-easy-pathed',
    'curator:concern-stale',
    'curator:concern-still-open',
    'curator:audit-uncertain',
    'curator:audit-no-concerns-file',
    // Resolutions.md audit (D.5.6) — verifies claimed fixes against code
    'curator:resolution-verified',
    'curator:resolution-cosmetic',
    'curator:resolution-unverifiable',
    'curator:resolution-orphaned',
    'curator:resolution-no-proof',
    'curator:resolution-regressed',
    'curator:audit-no-resolutions-file',
  ]),
});

export const AutoFixDriverFindingSchema = Base.extend({
  kind: z.enum([
    'auto-fix:loop-disabled',
    'auto-fix:dry-run-plan',
    'auto-fix:no-targets',
    'auto-fix:kill-switched',
    'auto-fix:dispatched',
    'auto-fix:cycle-complete',
    'auto-fix:cycle-failed',
    'auto-fix:budget-exceeded',
    'auto-fix:halted-failures',
    'auto-fix:dirty-tree',
    'auto-fix:no-concerns-file',
    'auto-fix:needs-clarification',
    'auto-fix:out-of-scope',
    'auto-fix:diff-recorded',
    'auto-fix:summary',
  ]),
});

export const CodebaseGraphFindingSchema = Base.extend({
  kind: z.enum([
    'codebase-graph:summary',
    'codebase-graph:no-source',
    'codebase-graph:tree-sitter-missing',
  ]),
});

export const ScreenProberFindingSchema = Base.extend({
  kind: z.enum([
    'screen-prober:run-complete',
    'screen-prober:run-failed',
    'screen-prober:precondition-failed',
    'screen-prober:dev-server-down',
    'screen-prober:not-applicable',
    'screen-prober:debounced',
  ]),
});

export const ScreenshotsFindingSchema = Base.extend({
  kind: z.enum([
    'screenshots:summary',
    'screenshots:none',
  ]),
});

export const ScreenValidatorFindingSchema = Base.extend({
  kind: z.enum([
    'capture:ok',
    'capture:blank',
    'capture:auth-wall',
    'capture:skeleton-loading',
    'capture:error-state',
    'capture:network-pending',
    'capture:scroll-required',
    'capture:no-capture',
    'capture:failed-nav',
    'capture:summary',
  ]),
});

export const SnapshotterFindingSchema = Base.extend({
  kind: z.enum([
    'snapshot:created',
    'snapshot:pruned',
    'snapshot:failed',
  ]),
});

export const OrchestratorFindingSchema = Base.extend({
  kind: z.enum([
    'hooks:fired',
    'risk:gated',
    'lifecycle:pre',
    'lifecycle:post',
    'lifecycle:error',
    'lifecycle:timeout',
    'budget:exceeded',
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
    'phase:bootstrapping',
    'phase:live-ready',
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
  screenshots: ScreenshotsFindingSchema,
  'screen-validator': ScreenValidatorFindingSchema,
  'screen-prober': ScreenProberFindingSchema,
  'codebase-graph': CodebaseGraphFindingSchema,
  'auto-fix-driver': AutoFixDriverFindingSchema,
  snapshotter: SnapshotterFindingSchema,
  curator: CuratorFindingSchema,
  bindings: BindingsFindingSchema,
  'ai-coverage': AiCoverageFindingSchema,
  prober: ProberFindingSchema,
  'self-awareness': SelfAwarenessFindingSchema,
  'self-monitor': SelfMonitorFindingSchema,
  'self-improve': SelfImproveFindingSchema,
  'doc-ingest': DocIngestFindingSchema,
} as const;

export type AgentName = keyof typeof SCHEMA_BY_AGENT;
