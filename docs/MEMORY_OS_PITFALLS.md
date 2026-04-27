# Memory OS — pitfalls + edge cases (field manual)

> Companion to `MEMORY_OS_SPEC.md`. The spec says *what* to build; this doc says *what breaks* and how to defend against it on day 1. Drawn from production postmortems of Letta/Mem0/Zep/Cognee/MemGPT/ChatGPT-memory plus general plugin-architecture lore.

## 5 production failures that have actually shipped

| # | System | Failure | Root cause | Fix |
|---|---|---|---|---|
| 1 | Zep (Nov 2025) | Service crashed every few hours under 30× growth | Connectors re-observing the same source without idempotency → duplicate cells → memory leak in Python proxy | Replaced Python proxy with Go service + stateless dedup layer ([postmortem](https://blog.getzep.com/scaling-agent-memory-zep-30x/)) |
| 2 | Mem0 (Q1 2026) | 80% of memory creations silently failed | LLM-as-observer inconsistently returned empty fact arrays — same input, different output across calls | Added schema validation + retry logic ([issue #3009](https://github.com/mem0ai/mem0/issues/3009)) |
| 3 | Industry-wide (2025) | Recall dropped 0.92 → 0.74 over weeks, no error thrown | Embedding model updated but stored vectors weren't re-embedded — silent drift | Track `embedding_model_version` on every cell ([article](https://dev.to/dowhatmatters/embedding-drift-the-quiet-killer-of-retrieval-quality-in-rag-systems-4l5m)) |
| 4 | ChatGPT memory (Feb 2025) | Cross-thread amnesia, data loss after 30–50 exchanges | Memory corruption in concurrent multi-thread writes | Still partially unresolved; users [report ongoing](https://community.openai.com/t/bug-chatgpt-memory-inconsistency-model-forgets-everything-across-chats-and-inside-threads/1310926) |
| 5 | YourMemory (2025) | Useful facts evaporated after 2-3 accesses | Decay window too tight; Ebbinghaus curve over-tuned aggressive | Two-tier decay (strategic vs ephemeral) + per-importance decay rate |

**Pattern across all 5:** silent failures dominate. None threw an exception; users just lost trust. Day-1 defense doctrine: *fail loud, never silent.*

## Edge case catalog (10 categories)

### 1. Memory drift + corruption

| Edge case | Day-1 defense |
|---|---|
| Cell duplication when canonicalisation fails | Reject `addCell()` if `(source_id, source_ref, last_24h)` already exists |
| Stale embeddings vs current cell content | Store `embedding_model_version` per cell; re-embed on version change |
| Cascading loss from recursive summarisation | Cap summary depth at 2; surface leaf cells when ambiguous |
| Schema evolution breaks old cells | Always include `cell_schema_version`; migrations are explicit, not implicit |

### 2. Multi-source agreement pitfalls

| Edge case | Day-1 defense |
|---|---|
| Correlated sources fake consensus (email forwarded to Slack = same fact 2×) | Connectors declare `independence_group`; consolidator credits agreement only across groups |
| Source-count weighted equally regardless of trustworthiness | Track `source_independence_score (0–1)` per cell; use in importance calc |
| Circular agreement (B cites A, then A cites B) | Store `source_provenance_chain`; detect cycles before counting agreement |

### 3. Decay tuning failures

| Edge case | Day-1 defense |
|---|---|
| Useful facts evaporate (decay too aggressive) | Two-tier TTL: strategic (180d+) vs ephemeral (7–14d) |
| Stale facts pollute answers (decay too lazy) | Hard floor: cells with `strength < 0.05` excluded from activation |
| Bursty access patterns (100× in one session, then never) | Use LRU+importance hybrid, not pure access count |

### 4. Activation/retrieval pitfalls

| Edge case | Day-1 defense |
|---|---|
| Anchor-matching fails (query phrasing doesn't match URN/label) | Fallback chain: exact URN → label substring → segment match → wiki body match |
| Depth-2 BFS explodes in dense graphs | Hard cap: max 50 nodes per BFS level, max 3 hops |
| "Threshold tuning" returns 0 results | Always return at least `k_min=3` cells with confidence labels; let LLM decide |
| Lossy compression in cortex summaries | Store original cell URNs alongside summary; expand on ambiguity |

### 5. Connector / plugin contract failures

| Edge case | Day-1 defense |
|---|---|
| Plugin emits unexpected fields → silent corruption | JSON-schema validate every connector output; reject malformed |
| Rogue connector touches another's data | Per-connector namespace; cross-namespace writes require explicit grant |
| Out-of-order events (resolution arrives before the event) | "Wait-for-prerequisites" queue; defer processing if dependency missing |
| Same source re-observed → duplicate cells | Mandatory idempotency key `(source_layer, source_ref, observed_at)` |

### 6. Conflict resolution pitfalls

| Edge case | Day-1 defense |
|---|---|
| 2 sources disagree (user said both "I love coffee" and "I hate coffee") | Open `conflicts` row; never silently pick one |
| Temporal conflicts (Q1 truth vs Q3 truth) | Bi-temporal validity windows: `valid_from`, `valid_to` per fact |
| Non-deterministic entity resolution ("J. Smith" = "John Smith"?) | Store both, let consolidator merge with audit log; allow rollback |
| Silent suppression of disagreements | Activation API returns `conflicts: [...]` array — consumer always sees them |

### 7. Privacy + sensitive data (personal-assistant case)

| Edge case | Day-1 defense |
|---|---|
| Health/financial/intimate data leaks across sessions | `sensitivity_label` field (`public`/`private`/`health`/`financial`); filter at activation |
| "Right to be forgotten" with provenance trails | Tombstone records, not hard delete; exclude from queries; log deletion |
| Connector consent (email reads everything by default) | Per-connector consent log; explicit grant required for sensitive scopes |
| Local vs cloud sync trade-offs | Encrypt cells at rest with user-key derivative; never plaintext sensitive fields |

### 8. LLM-as-observer hallucination

| Edge case | Day-1 defense |
|---|---|
| LLM connector generates facts not in source | Every LLM-extracted fact must include `source_excerpt` (verbatim text); reject if not present |
| No ground truth to detect hallucination | Two-pass: deterministic extraction + LLM extraction; only credit when both agree |
| Cost runaway with always-on LLM observers | Batch (≥100 items per call); rate-limit per connector |
| Circular hallucination (LLM cites its own output) | Tag cells with `generation_provenance`; refuse to count LLM-generated cells in agreement weight |

### 9. Eval + quality drift

| Edge case | Day-1 defense |
|---|---|
| No way to know if retrieval is degrading | Define 20–50 gold-standard query/answer pairs; run weekly; track recall@k |
| Same query returns different cells across calls | Log every activation result; alert on top-5 churn week-over-week |
| False negatives (query returns 0; should have returned 5) | Alert when activation returns < `k_min` cells; manual review queue |

### 10. Operational failures

| Edge case | Day-1 defense |
|---|---|
| SQLite WAL grows unbounded | `PRAGMA wal_autocheckpoint = 1000`; explicit periodic `PRAGMA wal_checkpoint(TRUNCATE)` |
| Multi-process write contention | `PRAGMA busy_timeout = 5000`; optimistic locking via `version` column on cells |
| Backup-restore merge conflict | Restore replays daily snapshot + WAL diff; new cells since backup are kept |
| One layer down (e.g., wiki) tanks the whole OS | `health_check()` per layer; activation degrades gracefully — drop the dead layer, log it, continue |

## The 10 day-1 defenses, prioritised

In implementation order — defends against most-impactful failures first:

1. **Idempotency on every ingest** — `(source_layer, source_ref, observed_at)` unique key. Closes Zep's #1 production failure.
2. **Strict schema validation on connector output** — JSON schema + TypeScript types. Reject malformed silently is the #1 cause of debugging hell.
3. **Provenance + independence tracking** — `source_layers[]`, `source_agents[]`, `independence_group`. Without this, multi-source agreement is fake.
4. **Two-tier decay** — strategic (180d) vs ephemeral (7d) TTL. Avoids YourMemory's "useful facts evaporate" failure.
5. **Embedding-version tracking** (when embeddings ship) — `embedding_model_version` per cell. Closes the silent-recall-drop failure.
6. **Per-connector namespace + explicit grants** — sandbox at the data layer, not just the process layer.
7. **Explicit conflict records** — `conflicts` table, never silent overwrite. The OS contract guarantees disagreements surface.
8. **Source-grounded LLM extraction** — every LLM-derived cell carries the source excerpt. No source = no fact.
9. **Production eval set + weekly run** — 20–50 gold queries; recall@k tracked. Without this, drift is invisible until users complain.
10. **Graceful degradation per layer** — health checks, fallback paths, never hard-crash on a single layer outage.

## Open questions (no good answer yet)

- **Source-independence detection without manual annotation.** Heuristics (cite-graphs) help but don't scale.
- **Optimal decay curve.** Ebbinghaus is a starting point; context-dependent rates are an open research problem. YourMemory closest, still hand-tuned.
- **Recursive summarisation fidelity loss.** MemGPT accepts it; nobody quantifies it cleanly. Open research.
- **Temporal conflict at scale.** Zep's bi-temporal works for small graphs; thousands of conflicting facts over years are unproven.
- **Hallucination detection without ground truth.** Entailment models are promising but not standard.
- **Cross-user privacy isolation in one OS instance.** Multi-tenancy is largely unaddressed in OSS systems today.

These five are the real research frontier. The OS doesn't need to solve them v1 — it needs to *not pretend it has solved them*.

## Source links

- [Zep scaling postmortem (Nov 2025)](https://blog.getzep.com/scaling-agent-memory-zep-30x/)
- [Mem0 Issue #3009 — memory creation silent fail](https://github.com/mem0ai/mem0/issues/3009)
- [Embedding drift: the quiet killer (2025)](https://dev.to/dowhatmatters/embedding-drift-the-quiet-killer-of-retrieval-quality-in-rag-systems-4l5m)
- [ChatGPT memory inconsistency bug report (Feb 2025)](https://community.openai.com/t/bug-chatgpt-memory-inconsistency-model-forgets-everything-across-chats-and-inside-threads/1310926)
- [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/pdf/2310.08560)
- [Memory triage for AI agents (2025)](https://fazm.ai/blog/ai-agent-memory-triage-retention-decay)
- [Cognee: From RAG to graphs](https://memgraph.com/blog/from-rag-to-graphs-cognee-ai-memory)
- [Race conditions in multi-agent orchestration](https://machinelearningmasters.com/handling-race-conditions-in-multi-agent-orchestration/)
- [Idempotency + ordering in event-driven systems](https://www.cockroachlabs.com/blog/idempotency-and-ordering-in-event-driven-systems/)
- [AI agent sandboxing 2026](https://www.firecrawl.dev/blog/ai-agent-sandbox/)
- [Mitigating hallucination in agentic systems](https://arxiv.org/html/2510.24476v1)
- [Deduplication in distributed systems](https://www.architecture-weekly.com/p/deduplication-in-distributed-systems)
