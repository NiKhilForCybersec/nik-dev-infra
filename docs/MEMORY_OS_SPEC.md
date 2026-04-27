# Memory OS — handoff spec for `~/nik-memory-os/`

> **What this is.** A self-contained architectural spec produced from the dev-infra Claude session, intended to seed the build in the `~/nik-memory-os/` Claude session. Drop this file into that repo as `docs/SPEC.md` (or rename) and start building from it. Edge-case catalog (research-in-progress) will be appended in a sibling doc; not blocking the start.

> **What this is NOT.** A plan for `nik-dev-infra`. dev-infra is one of the OS's eventual *consumers*, not where the OS gets built.

## North star

A pluggable **memory operating system** with its own agents. Plug it into a target (personal assistant, code repo, email, calendar, vault) and the OS:

1. Observes the target via target-specific **connector agents** (the OS's own).
2. Lands raw observations into a universal **24-layer storage substrate**.
3. Consolidates findings into **cells** (neurons) with provenance, decay, and multi-source agreement.
4. Exposes the brain back through an **MCP server** so any consumer (Nik, Claude Code, an agent) can ask questions.

The OS is target-independent. The connectors are target-specific.

## Architecture

```
        +-------------------------+
        |   CONNECTED TARGET      |    app · repo · notes · email · calendar
        +-----------+-------------+
                    |
                    | observed by
                    v
        +-------------------------+
        |   CONNECTOR AGENTS      |    target-specific sensors / watchers
        +-----------+-------------+
                    |
                    | emit raw events / findings
                    v
        +-------------------------+
        |   MEMORY SUBSTRATE      |    6 zones / 24 tables
        |                         |    raw · structured · wiki · trust ·
        |                         |    learning · run
        +-----------+-------------+
                    |
                    | processed by
                    v
        +-------------------------+
        |   CORE MEMORY AGENTS    |    link · merge · verify · conflict ·
        |                         |    decay · reinforce · promote
        +-----------+-------------+
                    |
                    | promote stable memories to
                    v
        +-------------------------+
        |   CELLS                 |    high-confidence · evidence-backed ·
        |                         |    activatable neurons
        +-----------+-------------+
                    |
                    | governed by
                    v
        +-------------------------+
        |   POLICY + PERMISSION   |    scopes · consent · privacy · audit
        +-----------+-------------+
                    |
                    | exposed through
                    v
        +-------------------------+
        |   MCP SERVER            |    activate · recall · explain · confirm
        +-----------+-------------+
                    |
                    | consumed by
                    v
        +-------------------------+
        |   CONSUMERS             |    Nik app · Claude Code · agents · workflows
        +-------------------------+
```

### The 6 substrate zones

The 24 tables/files cluster into 6 functional zones. Same physical layout; different mental model:

| Zone | What lives here | Tables / files |
|---|---|---|
| **Raw** | append-only event streams; the unfiltered observation log | `findings`, `findings.jsonl`, daily archives |
| **Structured** | the canonical entity catalog + graph | `register` (cells), `facts` (edges), `segments`, `hooks`, `graph.json` |
| **Wiki** | synthesised prose + history | `wiki_pages`, `wiki_revisions`, `notebooks/`, `wiki/*.md` |
| **Trust** | provenance, evidence, conflicts, source-independence | `provenance`, `conflicts`, `source_agents` arrays on cells/edges |
| **Learning** | telemetry, summaries, promotion log, backups | `agent_runs`, `agent_summaries`, `promotions`, `snapshots/` |
| **Run** | operational state, approvals, target artefacts | `notes`, `code_files` / `source_files`, `approvals`, target docs |

Every zone has invariants the consolidator enforces: Raw is append-only; Structured stays referentially intact (no orphan edges); Wiki revisions never shrink; Trust grows monotonically; Learning rotates / prunes; Run is target-specific and policy-gated.

## The two pillar systems

### Reliability pillars (the OS contract)

The OS guarantees these on every cell and every retrieval. Implementation references:

1. **Provenance** — every cell carries `source_layers[]` and `source_refs[]` pointing into the substrate. The activation primitive **refuses to return a cell with no provenance.**
2. **Decay** — unreinforced cells weaken via `invalidated_at` (Zep pattern: never delete, only invalidate). Strength formula: `importance × exp(−decay × hrs_since_reinforced) × (1 + recall × 0.2) × (1 + max(0, sources−1) × 0.15)`.
3. **Multi-source agreement** — `source_agents` JSON array; importance lifts when ≥2 *independent* observers confirm. Independence check is enforced by the consolidator (two connectors emitting from the same underlying data source ≠ independent).
4. **Conflict surfacing** — when sources disagree on a fact's truth, the consolidator opens a `conflicts` row instead of overwriting. Both cells stay live; retrieval surfaces both with the conflict marker.
5. **Sparse activation** — bounded BFS (depth=2, decay=0.7, ≤ k=20). Confidence-gated. Side effect: bumps `recall_count` and `last_accessed_at` on every returned cell — retrieval is reinforcement.

### Knowledge pillars (universal cell vocabulary)

Every connected target maps its data into five universal cell families:

1. **People** — `person`, `relationship`, `contact`
2. **Time** — `event`, `plan`, `deadline`, `recurrence`, `commit`, `chat-turn`
3. **Place** — `location`, `venue`, `route`, `repo-path`
4. **Things** — `file`, `module`, `doc`, `asset`, `screenshot`, `email`, `voice-memo`
5. **Ideas** — `decision`, `preference`, `principle`, `concern`, `note`, `wiki`

Every connector declares which families + concrete kinds it produces. The OS maintains the universal vocabulary; connectors translate domain-specific data into it.

## The 24-layer substrate (universal)

The 24 layers are **roles**, not file paths. Each role is filled by a target-appropriate surface. For dev-infra, role 22 is `<repo>/docs/Concerns.md`. For Nik, role 22 might be `app:notes-table`. Same role, different surface.

| # | Role | Storage | Universal name |
|---|---|---|---|
| 1 | Event stream | SQLite table | `findings` |
| 2 | Per-agent k/v | SQLite table | `notes` |
| 3 | Triple store | SQLite table | `facts` |
| 4 | Hierarchy | SQLite table | `segments` |
| 5 | Cell catalog | SQLite table | `register` (the cells) |
| 6 | Subscriptions | SQLite table | `hooks` |
| 7 | Synthesised prose | SQLite table | `wiki_pages` |
| 8 | Claim history | SQLite table | `wiki_revisions` |
| 9 | Run telemetry | SQLite table | `agent_runs` |
| 10 | Per-agent rollup | SQLite table | `agent_summaries` |
| 11 | Promotion log | SQLite table | `promotions` |
| 12 | Source-artifact index | SQLite table | `source_files` |
| 13 | Approval queue | SQLite table | `approvals` |
| 14 | Live append log | File | `findings.jsonl` |
| 15 | Daily archive | File | `findings.YYYY-MM-DD.jsonl` |
| 16 | Topology snapshot | File | `graph.json` |
| 17 | Self-concerns | File | `self-concerns.md` |
| 18 | Sandbox state | File | `runtime.json` |
| 19 | Per-agent narrative | File | `notebooks/<agent>.md` |
| 20 | DB backups | File | `snapshots/*.db` |
| 21 | Wiki mirror | File | `wiki/<segment>/<topic>.md` |
| 22 | Target's primary doc | Target artifact | varies (`Concerns.md` / `notes.db` / …) |
| 23 | Target's resolution log | Target artifact | varies (`Resolutions.md` / `actions.db` / …) |
| 24 | Target's behaviour gate | Target artifact | varies (`CLAUDE.md` / app config / …) |

## Cell schema (canonical)

```sql
CREATE TABLE cells (
  urn                 TEXT PRIMARY KEY,         -- stable, readable id
  kind                TEXT NOT NULL,            -- person | event | module | …
  family              TEXT NOT NULL,            -- people | time | place | things | ideas
  label               TEXT NOT NULL,
  segment             TEXT,                     -- topical hierarchy
  body                TEXT,                     -- main content
  importance          REAL NOT NULL DEFAULT 0.7,
  recall_count        INTEGER NOT NULL DEFAULT 0,
  observation_count   INTEGER NOT NULL DEFAULT 1,
  source_layers       TEXT NOT NULL,            -- JSON array of layer ids
  source_agents       TEXT NOT NULL,            -- JSON array of agent names
  created_at          INTEGER NOT NULL,
  last_accessed_at    INTEGER,
  last_reinforced_at  INTEGER NOT NULL,
  invalidated_at      INTEGER,                  -- NULL = active (Zep pattern)
  invalidation_reason TEXT,
  evidence_json       TEXT
);

CREATE TABLE edges (
  src                 TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  dst                 TEXT NOT NULL,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  source_agents       TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  last_reinforced_at  INTEGER NOT NULL,
  invalidated_at      INTEGER,
  evidence_json       TEXT,
  UNIQUE(src, predicate, dst)
);

CREATE TABLE provenance (
  cell_urn      TEXT NOT NULL,
  source_layer  TEXT NOT NULL,                  -- 'chat:<session>' | 'calendar:<event-id>' | 'file:<path>' | …
  source_ref    TEXT NOT NULL,                  -- specific ref in that layer
  observed_at   INTEGER NOT NULL,
  agent         TEXT NOT NULL,
  excerpt       TEXT,
  PRIMARY KEY (cell_urn, source_layer, source_ref)
);

CREATE TABLE conflicts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  cell_a_urn       TEXT,
  cell_b_urn       TEXT,
  predicate        TEXT,
  description      TEXT NOT NULL,
  detected_at      INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolution       TEXT
);
```

`addCell()` must reject anything with empty `source_layers`. Provenance is structural, not advisory.

## Connector contract

```typescript
interface Connector {
  name: string;
  routedSurfaces: string[];               // what it watches (paths, urls, db tables)
  intervalMs: number;                     // 0 = event-driven
  describe(): {
    families: ('people'|'time'|'place'|'things'|'ideas')[];
    kinds: string[];
    independence: 'first-party' | string; // independence group — sources sharing
                                          // a group don't count as multi-source
  };
  observe(): Promise<Finding[]>;
}

type Finding = {
  agent: string;
  kind: string;
  at: number;
  proposedCell: {
    urn?: string;                         // if known; else OS canonicalises
    kind: string;
    family: string;
    label: string;
    body?: string;
    evidence: string[];
  };
  proposedEdges?: { predicate: string; dst: string }[];
  sourceLayer: string;                    // which layer this came from
  sourceRef: string;                      // specific identifier in that layer
};
```

Connectors **never** write directly to cells. They emit findings; the consolidator promotes findings → cells, applying multi-source rules + conflict detection.

## Day-1 connectors (ship with OS)

- `chat` — any chat surface (Nik chat, Slack, Discord)
- `file` — any file system + git repo
- `calendar` — CalDAV / Google / iCal
- `email` — IMAP / Gmail API
- `code-repo` — git + AST (the dev-infra-style code watcher, refactored as a connector)
- `voice` — STT-fed transcripts

## Core agents (universal, ship with OS)

| Agent | Cadence | Reads | Writes |
|---|---|---|---|
| `linker` | 5 min | facts, register, wiki | facts, register |
| `consolidator` (the brain) | 6 hr | all 24 layers | register, wiki, agent_summaries, approvals, conflicts |
| `conflict-detector` | 15 min | facts, cells | conflicts |
| `self-monitor` | 5 min | agent_runs, findings | agent_summaries |
| `snapshotter` | 6 hr | DB | snapshots |

## Policy + permission layer

Every cell + every retrieval passes through this layer. Sits between the brain and the MCP server. Five responsibilities:

1. **Authentication** — which consumer is asking? (Nik chat session, Claude Code session, autonomous agent, dashboard) Each gets a stable consumer-id.
2. **Authorization** — does this consumer have access to this cell? Cells carry a `sensitivity_label` (`public` / `private` / `health` / `financial`); consumers carry `granted_scopes`. Activation filters at this layer, not at the SQL layer — so policy decisions are auditable.
3. **Sensitivity gating** — health/financial/intimate cells are excluded by default; require explicit per-consumer grant. Connector consent flows live here too: an `email` connector requires per-folder consent, a `voice` connector requires per-source consent.
4. **Audit log** — every retrieval is logged with `(consumer-id, query, cells_returned, sensitivity_levels, at)`. Read-only by default; tamper-evident hash chain optional.
5. **Right to be forgotten** — tombstone records (not hard delete). Cells marked `tombstoned_at` are excluded from every retrieval; provenance traces preserved for audit; original content cleared from indexes.

Without this layer, the OS is a memory leak waiting to happen for any personal-assistant target. With it, the OS can be deployed against sensitive data with a defensible answer to "where did this go and who saw it".

## MCP tool surface (consumer interface)

```
memory.cells.activate({question, depth=2, minStrength=0.1, k=20})
   → { cortex: [...], activated: [...], history: [...], conflicts: [...] }

memory.recall({query, k=20, minConfidence=0.5})
   → { results: [{layer, ref, excerpt, cell_urn?}] }

memory.note({text, scope?, kind?})
   → { cell_urn, importance }

memory.explain({answer, anchor_cells?})
   → { cells_supporting: [...], cells_contradicting: [...], confidence: 0.0-1.0 }
   // given an answer (or a draft response), returns the cells that
   // grounded it. Citation API. Verifies the "never claim without
   // provenance" property at the consumer side.

memory.confirm({urn, agent, evidence?})
   → { cell_urn, importance_after, recall_count_after }
   // explicit positive feedback: the consumer (often the user) confirms
   // a cell is still true. Reinforces strength + bumps recall_count.
   // First-class user-feedback signal, not a side effect of retrieval.

memory.entities.get({urn})
memory.entities.list({kind?, family?, segment?, limit?})

memory.facts.find({subject?, predicate?, object?, limit?})

memory.conflicts.list({status: "open" | "all"})
memory.conflicts.resolve({id, resolution})            // approval-gated

memory.cells.invalidate({urn, reason})                 // approval-gated
memory.cells.tombstone({urn, reason})                  // policy-gated; right-to-be-forgotten

memory.connectors.list()
memory.connectors.health()
memory.audit.log({since?, consumer_id?})               // policy layer audit trail
```

## Smallest useful slice (week-1 milestone)

One connector, one consumer, end-to-end:

- **Connector:** `chat` watching Nik's chat history
- **Storage:** SQLite at `~/.nik-memory/memory.db` (default, configurable)
- **Core agents:** `linker` + `consolidator` (skip conflict-detector v1)
- **MCP server:** stdio, exposes `memory.cells.activate` + `memory.note`
- **Consumer:** Nik chat session calls activate before responding; gets cells + provenance as context

**Daily-use test:** ask Nik "what did I tell you about X yesterday?" — does it return the right cells with citations?

If yes after a week of real use, expand to a second connector. If no, fix activation before adding scope.

## What doesn't ship in v1

- Embeddings + community summaries (defer until activation feels weak)
- Sigma.js BRAIN UI replacement (react-force-graph-2d is fine for v1)
- Local SLM / LoRA training (Phase 4; only after wiki cells are rich)
- Cross-project cell sharing (Phase 3)
- Web UI for memory inspection (CLI + MCP-introspection is enough v1)

## What `nik-dev-infra` does after this exists

1. Stops adding to its own `src/server/memory.ts`
2. Refactors its 28 agents as the OS's `code-repo` connector
3. dev-infra's dashboard becomes a *consumer* of the OS via MCP
4. Single source of truth: `~/nik-memory-os/` is the canonical memory layer

## Open architectural questions (decide before week-1 build)

1. **Storage location** — `~/.nik-memory/` (per-user) vs `~/nik-memory-os/data/` (per-checkout)? Personal-assistant case prefers per-user; dev-tool case prefers per-checkout. Suggest: per-user default, per-checkout override env var.
2. **Process model** — single MCP daemon serves all consumers, or one per consumer? Single daemon is simpler; concurrency is the cost.
3. **Connector lifecycle** — connectors run inside the OS daemon, or as separate processes? Inside is simpler v1; out-of-process is needed for sandbox / privacy isolation later.
4. **Independence groups** — how does the OS *verify* that two connectors are truly independent? Simplest: trust the `describe().independence` self-declaration. Stronger: hash the source data, detect overlap.

## Edge-case catalog

A separate doc (`MEMORY_OS_PITFALLS.md`) is being researched and will be appended. Topics: memory drift, multi-source pitfalls, decay tuning, activation pitfalls, connector contract drift, conflict resolution, privacy, LLM-observer hallucination, eval drift, operational failures.

## Where this is built

`~/nik-memory-os/` (separate Claude Code session). This dev-infra session does not build it.
