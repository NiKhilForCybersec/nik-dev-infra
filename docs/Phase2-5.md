# Phase 2-5 plan — `nik-dev-infra`

> Read this in the **second Claude Code session** (the one running in `~/nik-dev-infra/`). Phase 1 (scaffold + 4 agents + UI shell) shipped on 2026-04-26 in commit `45df468`. Each phase below is its own commit (or several). Order matters — earlier phases are foundations later ones rely on.

## Phase 2 — Foundation polish (priority: highest)

Goal: lock in the agent contract, observability, and external repo before adding more agents.

| # | Task | Files touched | DoD |
|---|---|---|---|
| 2.1 | **Zod output schemas per agent.** Define `FindingSchema` per agent kind. Validate every Claude `-p` output against it; reject + log malformed outputs (don't crash the agent). Add a `parseFinding` helper in `src/server/findings.ts`. | `src/server/agents/*.ts`, `src/server/findings.ts` | All 4 agents validate output; an intentionally bad agent prompt produces a "schema-rejected" finding instead of a thrown error |
| 2.2 | **Per-agent metrics panel** in UI. Stats: total runs, success rate %, avg duration, last 7d trend sparkline, last error message. Right-side panel toggleable from the agent rail. | `src/ui/App.tsx`, new `src/ui/AgentMetrics.tsx` | Click an agent in the rail → metrics panel appears |
| 2.3 | **GitHub repo + CI**. `gh repo create niki-dev-infra --public`, push, add `.github/workflows/ci.yml` running `npm run typecheck` on PR. README badge. | `.github/workflows/ci.yml`, README | `git push` → CI green |
| 2.4 | **WebSocket end-to-end validation**. Confirm: edit a NIK file → orchestrator triggers agent → agent finishes → finding broadcast over WS → UI repaints WITHOUT polling. Currently snapshot-only hydrate. | `src/server/index.ts`, `src/ui/App.tsx` | Visible: edit a file in NIK and watch finding land in :5174 within seconds |
| 2.5 | **Findings.jsonl rotation**. When the file exceeds 10 MB, rotate to `findings.YYYY-MM-DD.jsonl`. Hydrate only the most recent. | `src/server/findings.ts` | 100k findings doesn't slow boot |

Total: ~5h.

## Phase 3 — Agent suite expansion

Each new agent = 1 `.ts` runner + 1 `.md` prompt + entry in `agents/index.ts` + Zod schema. Same pattern as the existing 4.

| # | Agent | What it answers | Powered by | Est |
|---|---|---|---|---|
| 3.1 | `database` | Compares `~/NIK/supabase/migrations/*.sql` against contract Zod schemas. Flags column name / type mismatches, missing RLS policies on new tables, missing indexes on `user_id`. | `claude -p` (high reasoning) | 1.5h |
| 3.2 | `health` | Pings Supabase REST + Anthropic + OpenAI + MCP server every 60s; surfaces last-seen, latency p95. | deterministic + `fetch` | 45m |
| 3.3 | `concerns` | Parses `~/NIK/docs/Concerns.md`, classifies open vs resolved, links each to the relevant agent. Drives the "what's the user asked for that's still open?" view. | `claude -p` (small) | 1h |
| 3.4 | `graph` | Builds the project topology JSON (contracts → screens → tables, components, hooks, master nodes). UI panel uses cytoscape on the dev-infra side. | deterministic | 2h |
| 3.5 | `llm-cost` | Tails Nik's Anthropic API request log via a Supabase realtime channel. Flags expensive calls. (Requires a tiny Nik-side change: insert an `llm_calls` row per request. Coordinate with the Nik session.) | deterministic | 1.5h (incl. Nik coordination) |
| 3.6 | `sync` | Cross-screen consistency. Reads sample data from Supabase via service role + checks: does Home Hydrate widget value match Hydration screen value? Does Profile level match score-derived level? | `claude -p` (data + reasoning) | 2h |
| 3.7 | `secrets` | Scans for accidentally-committed API keys / `sk-ant-*` / `sk-proj-*` strings in ANY tracked file under `~/NIK/`. Errors if found. | deterministic regex | 30m |
| 3.8 | `accessibility` | Reads new screens; checks for `aria-label` on icon-only buttons, color-only state indicators, etc. | `claude -p` | 1.5h |

Total: ~10h. Add agents in priority order; ship after each.

## Phase 4 — Self-improving meta-agent

Goal: agents that learn from user concerns + their own past findings, suggest prompt improvements.

| # | Task | DoD |
|---|---|---|
| 4.1 | `meta` agent runs nightly. Inputs: last 200 findings + `~/NIK/docs/Concerns.md`. Output: zero or more proposed `.md` prompt diffs to specific agents. | Nightly run produces a JSON file `data/meta-proposals.json` |
| 4.2 | UI **review queue**. Tab in the dev console showing pending prompt diffs. Approve → applies the diff to the agent's `.md` file + commits to git with a "(meta)" tag. Reject → records that signal so the meta-agent learns. | User can approve/reject in 2 clicks; commit lands |
| 4.3 | Reject-feedback loop. Track which proposals get rejected; meta-agent's prompt is updated weekly to avoid those classes. | Reject rate trends down over time |
| 4.4 | Per-agent budget. Cap each agent at N runs/day or M Claude tokens/day. Surface breaches as findings. | Runaway agent doesn't spend the whole sub |

Total: ~4-5h.

## Phase 5 — Generalize as `npx`

Goal: anyone with a TypeScript project can `npx <name> <project-path>` and get a tailored dev-infra.

| # | Task | DoD |
|---|---|---|
| 5.1 | Extract `~/NIK`-specific paths into a `dev-infra.config.ts` file the user creates in their project. Schema: `{ srcDirs, contractsDir, manifestsGlob, agentsToEnable, customPrompts }`. | nik-dev-infra reads config; default config ships for the Nik shape |
| 5.2 | Plugin system: agents can be loaded from outside the package (`config.agents = ['./my-agent.ts']`). | Third-party agent works |
| 5.3 | CLI: `npm publish`. `npx <name> init` creates the config; `npx <name> start` runs daemon + UI. | `npx <name> init` in a fresh repo works |
| 5.4 | Docs site (mkdocs / nextra) explaining agent authoring + plugin system. | Public link |
| 5.5 | First external user. | Star + issue on GitHub |

Total: ~10-15h.

---

## Notes on running this plan

- **Each phase is independently shippable.** Don't block on later phases.
- **Per-task commits** with clear messages so the meta-agent has good signal.
- **AGENTS.md in the dev-infra repo** is the project context — update it as patterns evolve.
- **Keep the `~/NIK/` Claude Code session ignorant of dev-infra internals** — it should only know about `docs/Concerns.md` and `docs/DevInfra.md`. Cross-session pollution is the failure mode this whole architecture is designed to avoid.
- **Cost cap on Claude Max**: Pro caps in 5h windows; Max much higher. Track cumulative `claude -p` runs/day in metrics. If you hit a cap, the orchestrator already backs off agent re-runs cleanly.

## Hand-off prompt for the dev-infra session

Paste this in the **`~/nik-dev-infra/` Claude Code session** to start:

> Read `docs/Phase2-5.md`. Phase 1 is shipped (commit 45df468). Pick up from Phase 2.1 (Zod output schemas per agent). Confirm the plan, then ship 2.1 + 2.2 + 2.3 in this session. Do not touch any file under `~/NIK/`.
