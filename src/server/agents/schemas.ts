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

export type RawFinding = z.infer<typeof Base>;

export const SCHEMA_BY_AGENT = {
  drift: DriftFindingSchema,
  hardcoded: HardcodedFindingSchema,
  navigation: NavigationFindingSchema,
  registry: RegistryFindingSchema,
  database: DatabaseFindingSchema,
  health: HealthFindingSchema,
} as const;

export type AgentName = keyof typeof SCHEMA_BY_AGENT;
