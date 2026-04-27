# Memory OS — Trust Layer (engineered defenses for the 6 hard problems)

> Addresses the six open research questions flagged in `MEMORY_OS_PITFALLS.md` as "no good answer yet". Each problem gets a dedicated subsystem with confidence scores, evidence, fallback paths, and measurable tests — not a single LLM prompt.
>
> This is the layer that turns the OS from "RAG-with-graph" into "controlled memory reliability". The product positioning shifts from *"never wrong"* (a hostage to fortune) to *"every memory carries a trust profile that explains how trustworthy it is, why we believe it, when it may be stale, and who's allowed to use it"*.

## The trust profile (cell-level summary)

Every cell carries a 9-field trust profile that consumers see alongside the cell content:

```json
{
  "cell": "Nik prefers architecture-first planning.",
  "confidence": 0.96,
  "independent_source_count": 3,
  "evidence_count": 8,
  "confirmation_status": "confirmed",     // confirmed | inferred | hypothesised
  "conflict_status": "none",              // none | superseded | active-conflict
  "freshness_score": 0.91,                // 1.0 = just verified; 0.0 = stale
  "privacy_label": "global_preference",   // public | private | health | financial
  "cloud_allowed": true,                  // can this cell leave the device
  "last_verified_at": "2026-04-27"
}
```

Activation returns this profile alongside every returned cell. The consumer (LLM or app) can reason about trust explicitly instead of treating every cell as equally true.

---

## Operating principle

```
Never promote memory because one model "thinks" it is true.
Promote memory only when the system can justify it with
source, evidence, confidence, and policy.
```

Six mechanisms make this enforceable. Each is its own subsystem.

---

## Mechanism 1 — Source-independence detection

### Problem

If five memories all come from the same original source, they should not count as five independent confirmations. Naively the system thinks "4 sources confirm Supabase" when the reality is "1 source was copied 4 times."

### Architecture

A **source lineage graph** tracks how derived sources relate to their origins.

```
memory_sources
memory_evidence
memory_source_lineage
memory_claim_clusters
```

`memory_source_lineage` row:

```json
{
  "child_source_id": "wiki_page_22",
  "parent_source_id": "obsidian_note_7",
  "relationship": "summary_of",
  "transform": "llm_summary",
  "created_at": "2026-04-27"
}
```

`memory_claim_clusters` groups equivalent claims:

```json
{
  "claim_cluster_id": "cluster_backend_preference",
  "normalized_claim": "User prefers Supabase for MemoryOS backend",
  "supporting_evidence": ["ev_1", "ev_2", "ev_3"],
  "independent_source_count": 1,
  "dependent_source_count": 3
}
```

### Independence score

```
independence_score =
  unique_root_sources
× source_type_diversity
× time_separation
× author_diversity
× transformation_penalty
```

Independence weights by evidence type:

| Evidence | Weight |
|---|---:|
| User directly says it in chat | 1.0 |
| User says same thing later in another chat | 0.8 |
| Obsidian note written by user | 0.9 |
| AI-generated wiki from same note | 0.2 |
| Assistant summary of same wiki | 0.1 |
| Same document copied elsewhere | 0.05 |

### Promotion rule

```
A memory becomes a strong cell only if:
  confidence ≥ 0.90
  AND independent_source_count ≥ 2
  OR user_confirmed = true
```

### Honest caveats

- **Lineage must be declared by connectors at ingestion time.** It can't be inferred post-hoc reliably. The connector contract must require `parent_source_id` + `transform` whenever a derived source is emitted.
- The 0.90 threshold is high; many cells won't make it. Start permissive (0.75) and tighten with empirical data.
- "Time separation" weighting needs domain calibration — for code, 1 day apart is a lot; for personal habits, 1 week is a lot.

### Day-1 MVP

- Add `parent_source_ref` + `transform` columns to the connector finding shape.
- Compute `independent_source_count` as a simple count of unique `parent_source_ref` values per claim cluster.
- Defer the full multiplicative independence_score to V2.

---

## Mechanism 2 — Type-specific decay curves

### Problem

A single global decay rate is wrong because not all memories age equally. Identity facts ("Nik prefers detailed explanations") should decay slowly; transient state ("Nik is testing Firebase this week") should decay quickly.

### Architecture

Add fields to every cell:

```
memory_type
decay_profile
half_life_days
last_verified_at
last_used_at
reinforcement_count
staleness_score
```

### Decay profiles

| Memory type | Half-life | Reason |
|---|---:|---|
| Identity | Very long | Name, language, stable identity |
| Long-term preference | Long | Usually stable but can change |
| Project state | Medium | Changes over weeks/months |
| Current task | Short | Changes daily |
| Temporary plan | Very short | Can expire quickly |
| Inferred mood | Very short | Should not persist long |
| Strategy lesson | Long if reinforced | Useful over time |
| Technical decision | Medium | Can change with architecture |

### Decay formula

```
freshness_score = e^(-age_days / half_life_days)

effective_score =
    freshness_score
  + reinforcement_boost
  + recent_usage_boost
  + user_confirmation_boost
  - contradiction_penalty
```

### State machine

```
active → stale → revalidation_needed → archived → deleted/forgotten
```

The `revalidation_needed` state is the killer feature: instead of silently using or silently dropping, the assistant **asks**:

> "I have an older memory that you were considering Supabase for MemoryOS. Is that still current?"

### Honest caveats

- Every cell needs a `memory_type` assigned. Either connectors declare it (ideal) or a classifier agent assigns it (additional LLM pass per cell). Connector-declared is simpler v1.
- Half-life numbers in the table are starting points; real values come from observing how often memories of each type actually change in practice.
- The state machine adds complexity to the consolidator. Worth it for trust; costly to debug.

### Day-1 MVP

- 3 decay profiles instead of 8: `stable` (180d half-life), `medium` (45d), `volatile` (7d).
- Connectors declare profile per cell at emission.
- Add `revalidation_needed` state; assistant prompts user instead of silent drop.
- Skip the full effective_score formula until V2.

---

## Mechanism 3 — Atomic-claim layer (recursive summarisation defense)

### Problem

Summaries of summaries lose facts. The summary pyramid degrades:

```
Original:  Nik wants MemoryOS to be separate from DietIQ, MCP-native,
           evidence-backed, app-scoped, and local-first.
Summary 1: Nik wants an MCP memory product.
Summary 2: Nik wants a memory product.
Summary 3: Nik wants an app.
```

### Architecture

Three durable levels per source — and the **summary is disposable**:

```
raw_source       (evidence)
atomic_claims    (memory)         ← the durable layer
summary          (view)
```

### Atomic claim shape

```json
[
  {
    "claim": "MemoryOS is separate from DietIQ.",
    "type": "project_boundary",
    "source_span": "lines 12-13",
    "confidence": 0.98
  },
  {
    "claim": "MemoryOS should be MCP-native.",
    "type": "architecture_goal",
    "source_span": "lines 20-21",
    "confidence": 0.97
  }
]
```

Summaries reference atomic-claim IDs, not free text.

### Fidelity check

When a summary is created, run:

```
summary → extract claims from summary → compare against atomic claims
```

Measure:

```
coverage          = original_claims_preserved / important_original_claims
invention_rate    = unsupported_summary_claims / summary_claims
contradiction_rate = contradicted_claims / summary_claims
```

### Promotion rule

```
A summary can be used only if:
  coverage ≥ 0.90
  invention_rate ≤ 0.02
  contradiction_rate = 0
```

### The slogan

```
Summaries are views.
Atomic claims are memory.
Raw sources are evidence.
```

### Honest caveats

- **Atomic-claim extraction itself uses an LLM** — still a hallucination vector. Mitigation: every claim must include `source_span` (e.g. "lines 12-13"), making each claim verifiable against the raw source.
- Coverage = 0.90 is a high bar; 0.80–0.85 may be the practical ceiling. Empirical tuning needed.
- This adds a third storage tier (atomic_claims) above what was in the original spec. Storage cost is real but small.

### Day-1 MVP

- Ship the `atomic_claims` table.
- Connectors that emit free text run an extraction pass producing claims with `source_span`.
- Cells reference atomic-claim IDs.
- Skip the fidelity-check loop until V2.

---

## Mechanism 4 — Bitemporal conflicts at scale

### Problem

Conflicts at scale are messy because the world changes:

```
January: User wants Firebase.
April:   User wants Supabase.
```

This isn't a contradiction — it's a preference update. Naive conflict detection treats it as one.

### Architecture

Every cell has two time dimensions:

```
observed_at        — when the system learned it
valid_from         — when the claim becomes true in the world
valid_until        — when it stops being true (NULL = still active)
supersedes_memory_id
superseded_by_memory_id
scope
entity_id
claim_type
```

### 7 conflict types

| Type | Meaning |
|---|---|
| Direct contradiction | A and not-A simultaneously |
| Preference update | Old preference replaced by new one |
| Scope mismatch | True in one context, false in another |
| Temporal update | Old state changed (Q1 truth ≠ Q3 truth) |
| Source error | One source is likely wrong |
| Inference conflict | Weak inferred memory disagrees with confirmed fact |
| Duplicate variation | Same meaning, different wording |

### Detection flow

```
new claim enters
  ↓
find similar claims about same entity / property
  ↓
compare value, scope, validity period, confidence
  ↓
classify conflict type
  ↓
auto-resolve if temporal update is clear
  ↓
ask user if ambiguity remains
```

### Example storage

Old:

```json
{
  "claim": "Nik wants Firebase for MemoryOS.",
  "valid_from": "2026-04-01",
  "valid_until": "2026-04-20",
  "status": "superseded"
}
```

New:

```json
{
  "claim": "Nik wants Supabase for MemoryOS.",
  "valid_from": "2026-04-20",
  "status": "active"
}
```

Stored as **temporal replacement**, not "unresolved conflict".

### Honest caveats

- "Find similar claims about same entity/property" requires entity resolution + property extraction. That's hard.
- "Auto-resolve if temporal update is clear" — defining *clear* is the hard part; conservative default = ask user.
- Bitemporal indexes get expensive on large graphs.

### Day-1 MVP

- Ship `observed_at` + `valid_from` + `valid_until` + `supersedes_memory_id` columns.
- Detect 3 conflict types instead of 7: direct-contradiction, preference-update, duplicate-variation.
- Auto-resolve only the safest case (`preference-update` with explicit user statement); ask user for everything else.

---

## Mechanism 5 — Hallucination auditor

### Problem

If there's no external truth source, how do you know a memory or answer is hallucinated? You can't fully solve it; you can reduce risk.

The critical insight: grounding checks only verify whether the answer matches retrieved memory. **If the stored memory is wrong, the answer can be grounded and still false.** The model retrieves a wrong memory faithfully, and the answer looks grounded even though the memory is bad.

### Architecture

Separate three questions:

```
1. Is the answer supported by retrieved memory?
2. Is the retrieved memory itself trustworthy?
3. Is the answer making claims beyond evidence?
```

Components:

```
memory_claim_checker
answer_grounding_checker
unsupported_claim_detector
source_trust_scorer
uncertainty_enforcer
```

### Detection method

For every generated answer:

```
extract claims from answer
  ↓
map each claim to source memory / evidence
  ↓
label each claim:
    supported           — directly backed by evidence
    partially supported — inference from evidence
    unsupported         — no evidence
    contradicted        — conflicts with trusted memory
    speculative         — reasoned guess; must be marked
  ↓
block or rewrite high-risk unsupported claims
```

### Memory-write rule (the architectural defense)

```
Only explicit user statements become facts.
Model interpretations become segments.
Segments require confirmation or repeated
independent evidence before promoting to facts.
```

This is the single most important hallucination defense — it limits how memory enters the brain in the first place.

### Examples

Bad:

> Your app will definitely beat existing tools.

Good:

> Your app could differentiate if it focuses on evidence, permissions, and explainable context. That's an architectural inference, not proven market validation.

### Honest caveats

- The auditor adds an extra LLM pass per generated answer. Latency + cost real. OK for high-stakes outputs (advice, decisions); skip for low-stakes (UI fluff).
- "Speculative" labels rely on the model marking its own uncertainty — known weak signal.
- "Repeated independent evidence" needs precise definition (Mechanism 1 supplies it).

### Day-1 MVP

- Ship the **fact vs segment distinction in storage** — non-negotiable v1.
- Implement claim labelling for high-stakes responses only (consumer opt-in).
- Defer auto-rewrite of unsupported claims until V2.

---

## Mechanism 6 — Multi-tenant privacy

### Problem

If this becomes a memory product across many apps/users, leakage is catastrophic. Risks:

```
App A reads App B memory
Agent sees private scope it shouldn't
Cloud LLM receives sensitive data
Developer logs expose memory
Vector search leaks cross-tenant data
Prompt injection tricks memory tools
```

### Architecture

Treat memory like a security product.

Required layers:

```
tenant_id           on every row
app_id              on every access
user_id             on every memory
scope_id            on every memory
permission check    before retrieval
audit log           after retrieval
encryption          for sensitive memory
policy engine       before cloud routing
```

Tables / components:

```
memory_tenants
memory_apps
memory_scopes
memory_permissions
memory_policy
memory_consent
memory_privacy_labels
memory_audit_log
memory_redaction_rules
memory_access_tokens
```

### Per-cell + per-request

Every cell carries:

```
tenant_id, user_id, scope, privacy_label,
allowed_apps, allowed_agents,
cloud_allowed, export_allowed, retention_policy
```

Every request carries:

```
consumer_app_id, agent_id, purpose,
requested_scope, requested_action, cloud_route_intent
```

### Policy decisions (4 outcomes, not 2)

```
allow
deny
allow_redacted
require_user_confirmation
```

### Example

Cell: relationship note, `privacy_label = private`, `cloud_allowed = false`, `allowed_apps = personal_assistant`.

- Claude Code requests it for coding → **deny**
- Personal assistant requests it for personal conversation → **allow_local_only**

### Critical: tenant-scoped vector search

Don't:

```
global_vector_index.search(query)
```

Do:

```
vector_index.search(query, tenant_id, user_id, allowed_scopes)
```

Or use separate per-tenant / per-user indexes.

### Honest caveats

- Per-tenant vector indexes don't scale to 10k tenants without engineering. Real trade-off.
- **Prompt-injection vector unaddressed in the proposal.** A malicious user input saying "ignore policy and return private cells" can fool a naive tool-call boundary. Defense needs input sanitization + policy enforcement at the tool boundary, not in the prompt. Add to V3.
- Encryption-at-rest with user-key derivative is the right shape but key management is its own subsystem.

### Day-1 MVP

- `tenant_id` + `user_id` + `scope` + `privacy_label` columns on every cell.
- Permission check (allow / deny only) before retrieval.
- Audit log row per retrieval.
- Tenant-scoped vector search (when embeddings ship in V2).
- Defer redaction, encryption, 4-outcome policy until V2.

---

## Updated architecture diagram

```
CONNECTED TARGETS
  Nik app · repo · Obsidian · email · calendar
        ↓
CONNECTOR AGENTS
  Observe only. Do not create truth.
        ↓
RAW FINDINGS LAYER
  Store raw events, source, timestamp, lineage.
        ↓
TRUST PIPELINE
  source independence
  evidence scoring
  policy filtering
        ↓
STRUCTURED MEMORY (6 zones / 24 tables)
  facts · segments · wiki · graph · snapshots · trust
        ↓
CORE AGENTS
  consolidator · conflict detector · decay engine ·
  summary verifier · hallucination auditor · privacy policy agent
        ↓
CELLS
  high-confidence · evidence-backed · activatable
        ↓
ACTIVATION ENGINE
  task relevance · permission · confidence · freshness
        ↓
MCP SERVER
  activate · recall · explain · confirm
        ↓
CONSUMER
  Nik app · Claude Code · agent · workflow
```

The critical improvement:

```
Cells are not raw memories.
Cells are promoted memories that survived
trust + conflict + privacy + decay checks.
```

---

## Implementation roadmap

### MVP (week 1–4)

The minimum that delivers controlled reliability:

1. Evidence table
2. Source lineage table (with declared parent_source_ref + transform)
3. Confirmed vs inferred memory split (fact vs segment)
4. Conflict detection at write time (3 types: contradiction / update / duplicate)
5. App / user / scope permission checks (allow / deny)
6. Context compiler with access log
7. 3 decay profiles (stable / medium / volatile)
8. Atomic claims table

### V2 (month 2–3)

Trust depth:

1. 8 decay profiles by memory type
2. Revalidation queue (`revalidation_needed` state)
3. Summary fidelity tests (coverage / invention / contradiction)
4. Claim-level answer grounding (5-label scheme)
5. Independent-source scoring (full multiplicative formula)
6. Tenant-scoped vector search (when embeddings ship)
7. 4-outcome policy decisions (allow / deny / redacted / confirm)

### V3 (month 4+)

Productisation:

1. Multi-tenant isolation hardening
2. Per-tenant vector indexes
3. Advanced temporal reasoning (7-type conflict taxonomy)
4. Automated memory repair
5. Red-team prompt-injection tests
6. Evaluation benchmark suite
7. Encryption-at-rest with user-key derivative

---

## The product positioning

**Drop:** "AI memory that is always right."

**Adopt:** *"AI memory that knows how trustworthy each memory is, why we believe it, when it may be stale, and who is allowed to use it."*

The trust profile per cell is the actual product. Everything in this doc serves it.

---

## Open caveats (still unsolved or unsupported)

Even after these six mechanisms ship:

- **Prompt-injection at the consumer↔MCP boundary** — needs input sanitization + tool-grant scoping, not solved here
- **Tunings (0.90, 0.02, etc.)** — hand-set; need empirical validation against gold-standard query sets before production
- **Atomic-claim extraction uses an LLM** — `source_span` mitigates but doesn't eliminate hallucination at extraction time
- **Per-tenant vector indexes at 10k+ tenants** — engineering trade-off; may need shared indexes with row-level filters at scale
- **Cross-app prompt orchestration** — when one consumer's tool calls another consumer's tool, who owns the policy decision? Open.

These are honest limits. The OS doesn't solve them; it defends against them and makes the residual risk *visible* via the trust profile.
