# BRAIN — primary engineering reference

> ⚠️ **READ BEFORE TOUCHING ANY MEMORY/AGENT/UI CODE.**
> This is the single source of truth for the brain vision and the
> implementation plan it implies. Linker, brain-consolidator, activation
> primitive, decay loop, and BRAIN UI all derive from this doc. If a code
> change contradicts something here, update this doc first; don't drift.

## North star — "the breakthrough"

An **artificial brain** that:

- Runs 24/7 against a target repo, autonomously.
- Stores every confirmed claim about that repo as a *neuron* — a high-confidence cell with provenance, age, reinforcement count, and a decay curve.
- **Never hallucinates**: every neuron traces back to at least one of the 24 storage layers; nothing is allowed to exist in retrieval without a verifiable source.
- **Continuously learns**: facts strengthen when re-observed by independent agents, weaken when not, and are *invalidated* (not deleted) when contradicted — full history preserved for replay.
- **Activates on demand**: when a user or agent asks a question, relevant neurons fire via spreading activation; only neurons above a confidence floor enter the answer's context.
- **Stands out** because it's deterministic-first (no embedding-based fuzz), provenance-complete (W3C-PROV-equivalent without the formalism), multi-source-aware (a fact from 2+ agents is automatically stronger), and visible (the BRAIN UI shows neurons firing in real time).

This is not "RAG with a graph". It's a **persistent memory operating system** for a single project's living model — the same shape as Zep / Cognee / MemOS, distilled to the parts that pay off and skipping the parts that don't.

## The 24 storage layers (the substrate)

Every memory artifact lives in exactly one of these 24 surfaces. **No neuron without a source layer.** That's the hallucination floor.

### SQLite tables (13)

| # | Layer | Role | Status |
|---|---|---|---|
| 1 | `findings` | append-only event stream — every emit() lands here | ✅ live, 29 861 rows |
| 2 | `notes` | per-agent k/v scratchpad | ⚠ **dormant** — leverage point |
| 3 | `facts` | (subject, predicate, object) graph triples | ✅ 2 284 rows post-linker |
| 4 | `segments` | topical hierarchy | ✅ 45 rows |
| 5 | `register` | entity catalog → **the neurons themselves** | ✅ 757 rows |
| 6 | `hooks` | event subscriptions | ✅ 4 rows |
| 7 | `wiki_pages` | current synthesized prose per topic | ✅ 39 rows |
| 8 | `wiki_revisions` | claim-history append log | ✅ 320 rows |
| 9 | `agent_runs` | per-run telemetry | ✅ 6 393 rows |
| 10 | `agent_summaries` | per-agent consolidated view | ⚠ **dormant** — brain writes here |
| 11 | `promotions` | curator write-back provenance | ⚠ dormant — fills when consent flips |
| 12 | `code_files` | scanned source files + hashes | ✅ 175 rows |
| 13 | `approvals` | high-risk mutations queue | ⚠ **dormant** — brain writes here |

### File-backed (8)

| # | Layer | Role |
|---|---|---|
| 14 | `data/findings.jsonl` | today's append-only log (mirrors table 1) |
| 15 | `data/findings.YYYY-MM-DD.jsonl` | rotated daily archives |
| 16 | `data/graph.json` | topology snapshot from graph agent |
| 17 | `data/self-concerns.md` | dev-infra's own concerns |
| 18 | `data/test-account.json` | runtime sandbox state |
| 19 | `data/notebooks/<agent>.md` | per-agent narrative |
| 20 | `data/snapshots/memory.*.db` | periodic full DB backups |
| 21 | `data/wiki/<segment>/<topic>.md` | wiki markdown mirror |

### User-repo artifacts (3)

| # | Layer | Role |
|---|---|---|
| 22 | `<repo>/docs/Concerns.md` | birth source for `kind=concern` neurons |
| 23 | `<repo>/docs/Resolutions.md` | birth source for `kind=resolution` neurons |
| 24 | `<repo>/CLAUDE.md` | gate the curator writes back to once consolidated |

**4 layers are dormant** (`notes`, `agent_summaries`, `promotions`, `approvals`). Lighting them up is part of the plan, not waste.

## How each layer feeds the brain

| Lifecycle stage | Layers involved | Mechanism |
|---|---|---|
| **Birth** | 1 → 3, 5 | agent emits finding (1) → if deterministic 1.0 confidence, addFact() commits to facts (3) → registerEntity() adds anchor URN to register (5) |
| **Topology** | 4, 6, 21 | segment placement (4); event hooks (6); wiki markdown mirror (21) |
| **Synthesis** | 7, 8, 19 | wiki_pages (7) is the current synthesized prose; wiki_revisions (8) is claim history; notebooks (19) hold the agent's own narrative |
| **Reinforcement** | 1, 9, 12 | re-emission counts in findings (1); agent_runs (9) timestamps last-verified; code_files (12) confirms artifact still present |
| **Decay** | 5, 8, 20 | invalidated_at on register (5); revision churn signal in (8); rollback via snapshots (20) |
| **Cross-source agreement** | 1, 3, 5 | distinct agents in source_agents on register (5); reinforcement_count on facts (3) |
| **Provenance** | 2, 5, 22, 23, 24 | every neuron points back to at least one of 22/23/24 OR a layer-12 file OR a layer-1 finding |
| **Approval** | 13 | brain queues high-risk demotions/promotions to approvals (13); user reviews before write |
| **Per-agent view** | 10 | brain writes each agent's top-N strongest neurons to agent_summaries (10) |
| **Write-back** | 11, 22, 23, 24 | curator promotes consolidated, multi-source neurons → promotions (11) → user repo files (22, 24) |

## The neuron — schema

A neuron is a `register` row plus its `facts` edges. We add the lifecycle columns researched against Zep / Cognee / Mem0:

```sql
ALTER TABLE register ADD COLUMN importance         REAL    DEFAULT 0.7;
ALTER TABLE register ADD COLUMN recall_count       INTEGER DEFAULT 0;
ALTER TABLE register ADD COLUMN observation_count  INTEGER DEFAULT 1;
ALTER TABLE register ADD COLUMN source_agents      TEXT;        -- JSON array
ALTER TABLE register ADD COLUMN last_accessed_at   INTEGER;
ALTER TABLE register ADD COLUMN last_reinforced_at INTEGER;
ALTER TABLE register ADD COLUMN invalidated_at     INTEGER;     -- NULL = active (Zep pattern)

ALTER TABLE facts ADD COLUMN reinforcement_count INTEGER DEFAULT 1;
ALTER TABLE facts ADD COLUMN last_reinforced_at  INTEGER;
ALTER TABLE facts ADD COLUMN invalidated_at      INTEGER;

CREATE INDEX idx_register_importance ON register(importance DESC);
CREATE INDEX idx_register_active     ON register(invalidated_at) WHERE invalidated_at IS NULL;
```

**Strength formula** (Mem0 / YourMemory, validated in production):

```
strength = importance
         × exp(−decay_rate × hours_since_last_reinforced)
         × (1 + recall_count × 0.2)
         × (1 + max(0, distinct_sources − 1) × 0.15)
```

**Tunings** — start at:
- decay_rate = 0.15 (between Zep's 0.1 and YourMemory's 0.2)
- stale_threshold = 0.05 → mark `invalidated_at`, keep row for replay
- min_strength_for_retrieval = 0.1 (research recommends 0.65, we start permissive)
- min_strength_for_writeback = 0.75 (matches Mem0's auto-decision floor)

**Behavior changes in `addFact` / `registerEntity`:**
- Duplicate fact → bump `reinforcement_count`, update `last_reinforced_at`. Don't silently reject.
- Repeated `registerEntity` call from a *different* agent → append agent to `source_agents`, bump `observation_count`, raise `importance = clamp(0.5 + 0.15 × distinct_sources, 0, 1)`. Multi-source agreement is automatic.

## The activation primitive

```
memory.cells.activate({question, depth=2, minStrength=0.1, k=20})
```

Implementation (deterministic, recursive CTE in SQLite — no embeddings v1):

1. **Anchor:** match `question` against `register.urn` (substring) and `register.label` (case-insensitive). Top-K by `strength`.
2. **Spread:** BFS via facts table for `depth` hops; multiply activation by 0.7 per hop; drop edges below `minStrength`.
3. **Score:** every reached neuron's final activation = max-over-paths(seed_strength × 0.7^hops × edge_reinforcement_weight).
4. **Gate:** drop neurons with `invalidated_at != NULL` OR `strength < minStrength`.
5. **Pack:** return `{neurons: [...], facts: [...], wiki: [...], provenance: {layers_touched: [...]}}`.

Side effect: bump `recall_count` and `last_accessed_at` on every returned neuron. Retrieval *is* reinforcement.

## The brain consolidator agent

Runs every 6h. **Reads all 24 layers, writes to 4** (`register`, `wiki_pages`, `agent_summaries`, `approvals`).

Per cycle:

1. **Re-verify** sample of N neurons by re-querying the source layer (kind=module → re-AST the file in layer 12; kind=concern → re-parse layer 22; kind=screen → re-check layer 19's screenshots).
2. **Decay** — recompute strength for every active neuron; mark `invalidated_at` when below stale threshold.
3. **Reinforce** — for any source layer that still attests, bump `last_reinforced_at` (no duplicate fact emission needed).
4. **Merge aliases** — when two neurons share ≥80% of their fact edges, queue an `approvals` entry "merge A → B".
5. **Per-agent rollup** — write each agent's top-20 strongest neurons into `agent_summaries`.
6. **Demotion alerts** — if a neuron's `importance` drops > 0.3 in one pass, queue an `approvals` entry "review demotion".

Distinct from `memory-keeper` (integrity audit only) and `curator` (write-back gate only). The brain is the *living* layer — it learns.

## Autonomous loop

The brain is one agent inside the existing orchestrator. It runs on its own cadence, no human in the loop:

```
[orchestrator @ every 6h]
   └─→ brain.run()
        ├─ readAllLayers()                # all 24
        ├─ decayPass()                    # invalidate stale, never delete
        ├─ reinforcePass()                # bump last_reinforced_at where source still attests
        ├─ mergeProposals()               # → approvals
        ├─ perAgentRollup()               # → agent_summaries
        └─ healthSummary()                # → finding (kind=brain:cycle-complete)

[orchestrator @ every 5min]
   └─→ linker.run()                       # already shipped — keeps graph connected

[on every fact write]
   └─→ memory.addFact() reinforces on dup # silent → no-op cost
```

The "no limitations" property comes from:
- **Storage layers are append-friendly** (findings, facts, wiki_revisions) — we never run out of history.
- **Decay is multiplicative, not destructive** — a stale neuron is `invalidated_at`-stamped, still queryable for replay / temporal queries.
- **Spreading activation is bounded by depth + threshold** — graph size doesn't blow up retrieval time; recursive CTE handles ~10k neurons easily.
- **Approval queue is the safety valve** — anything risky surfaces to the user; nothing destructive is fully autonomous.

## What the BRAIN UI shows (post-Phase 1)

Color and size encode the **living state** of every neuron:

- **Color** = importance heatmap (green = 1.0 → red = 0.05)
- **Size** = current strength (post-decay, post-reinforcement)
- **Edge thickness** = reinforcement_count
- **Edge color** = recency (bright = recently reinforced; faded = old)
- **Pulse** = currently activated by a query (real-time spreading-activation visualization)

We stay on react-force-graph-2d for now. Sigma.js migration is Phase 2 (only when we exceed ~2000 visible nodes).

## Phase plan (concrete, dated)

### Phase 1 — schema + activation (this week)
- [ ] `ALTER TABLE` migration for the 8 new columns above (additive, backward-compatible)
- [ ] `addFact` upsert-on-duplicate with reinforcement bump
- [ ] `registerEntity` source-merge with multi-source importance recompute
- [ ] `memory.cells.activate` MCP tool (recursive CTE, no embeddings)
- [ ] `brain` consolidator agent (decay + reinforce + agent_summaries + approvals)
- [ ] Wire `agent_summaries` and `approvals` into dashboard

### Phase 2 — semantic richness (when we feel the pain)
- [ ] Embeddings on register.label + wiki content (sqlite-vec or pgvector)
- [ ] GraphRAG-style community detection (Louvain) + per-community summaries → `wiki_pages`
- [ ] Sigma.js BRAIN UI replacement (only when 2000+ visible nodes hurts FPS)
- [ ] Temporal queries: "what did the brain believe at time T" via `invalidated_at` filtering

### Phase 3 — across-project (the real moat)
- [ ] Cross-project neuron sharing (a generic "React error-boundary best-practice" learned in repo A applies to repo B)
- [ ] User feedback loop: a thumbs-down on a neuron-backed answer demotes the neuron
- [ ] Brain serves the user's own Claude session via MCP — every question they ask gets context from their persistent brain

## What we explicitly skip

- ❌ **Embedding-based fuzzy retrieval (v1)** — deterministic graph BFS is the doctrine; embeddings later when needed
- ❌ **Full MemOS adoption** — too heavyweight; borrow 3-layer mental model (Interface / Operation / Infrastructure), not code
- ❌ **Neo4j migration** — SQLite + recursive CTEs handle our scale; no rebuild
- ❌ **W3C PROV formalism** — `source_agents TEXT (JSON)` + `last_reinforced_at INTEGER` does the same job in 2 columns
- ❌ **3D BRAIN UI** — Obsidian is 2D; alive feel comes from animation + heatmap, not depth
- ❌ **Letta tier model** (core / archival) — our neurons aren't bound to a context window; the activation primitive handles relevance

## Open tunings (to revisit at month 3)

- decay_rate (start 0.15)
- stale_threshold (start 0.05)
- min_strength_for_retrieval (start 0.1, target 0.65)
- min_strength_for_writeback (start 0.75)
- multi-source agreement bonus (start +15% per extra agent)
- brain cycle cadence (start 6h)

## Source research

- Zep / Graphiti — bi-temporal facts: https://arxiv.org/abs/2501.13956 · https://github.com/getzep/graphiti
- Cognee Memify — usage-driven reweighting: https://github.com/topoteretes/cognee
- Mem0 / YourMemory — Ebbinghaus decay schema: https://github.com/sachitrafa/YourMemory
- MemOS — 3-layer architecture: https://arxiv.org/abs/2507.03724 · https://github.com/MemTensor/MemOS
- Microsoft GraphRAG — community summaries: https://github.com/microsoft/graphrag
- LightRAG — dual-level retrieval: https://arxiv.org/abs/2410.05779 · https://github.com/HKUDS/LightRAG
- HippoRAG / spreading activation in LLM agent context
- VeriTrail — provenance + hallucination detection: https://www.microsoft.com/en-us/research/blog/veritrail-detecting-hallucination-and-tracing-provenance-in-multi-step-ai-workflows/

## How to keep this doc honest

- Every memory/agent/UI PR must update this doc if it touches lifecycle, schema, activation, or layer wiring.
- A code change that contradicts a section here is treated as a regression — update the doc *first*, then merge the change.
- The `linker` and `brain` agents read this doc only to know which layers to touch — never to discover new layers. Adding a 25th layer means updating this doc and the orchestrator together.
