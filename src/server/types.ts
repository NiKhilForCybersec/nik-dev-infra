/* Core types — shared between daemon, agents, UI. */

export type Severity = 'info' | 'warn' | 'error';

export type Finding = {
  /** Unique id (timestamp + random suffix). */
  id: string;
  /** Agent that produced this finding. */
  agent: string;
  /** Brief category label (e.g. 'drift', 'hardcoded:number', 'nav:broken'). */
  kind: string;
  /** When the finding was emitted. */
  at: number;
  /** Severity for UI sorting. */
  severity: Severity;
  /** Single-line summary. */
  summary: string;
  /** Optional file path (relative to ~/NIK) the finding refers to. */
  file?: string;
  /** Optional line number. */
  line?: number;
  /** Optional remediation hint. */
  suggestion?: string;
  /** Free-form structured payload from the agent. */
  payload?: Record<string, unknown>;
};

export type AgentRun = {
  agent: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  findingCount: number;
  error?: string;
};

export type Agent = {
  /** Stable agent name (matches the directory file name). */
  name: string;
  /** What this agent is for — shown in the UI. */
  description: string;
  /** File globs (relative to NIK) that should trigger this agent.
   *  Empty array = trigger only on interval. */
  routedFiles: string[];
  /** How often to also run on interval (ms). 0 = never. */
  intervalMs: number;
  /** The actual runner. Returns 0+ findings. */
  run: () => Promise<Finding[]>;
};

export type SystemPhase = 'bootstrapping' | 'live';

/** Risk classification for every agent (per 12-patterns #10).
 *  - read:            pure read, no side effects anywhere
 *  - external-call:   outbound network requests (HTTP, DNS, etc.)
 *  - write-memory:    writes to our own data/ (memory.db, findings,
 *                     wiki, notebooks, graph.json) — baseline for any
 *                     agent that emits findings via emit()
 *  - write-prompt:    can write/propose-edit dev-infra's own
 *                     `src/server/agents/*.md` prompt files
 *  - write-user-repo: can write to the watched repo (curator,
 *                     consent-gated)
 *
 *  The orchestrator gates write-prompt + write-user-repo behind
 *  config.riskGate flags. Everything else runs freely. */
export type RiskClass = 'read' | 'external-call' | 'write-memory' | 'write-prompt' | 'write-user-repo';

export type ServerEvent =
  | { type: 'finding'; finding: Finding }
  | { type: 'run'; run: AgentRun }
  | {
      type: 'snapshot';
      findings: Finding[];
      runs: AgentRun[];
      agents: { name: string; description: string }[];
      target: { path: string; label: string };
      phase: SystemPhase;
    };
