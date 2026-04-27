# nik-dev-infra

[![ci](https://github.com/NiKhilForCybersec/nik-dev-infra/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKhilForCybersec/nik-dev-infra/actions/workflows/ci.yml)

Always-on dev infrastructure that watches a codebase and runs 28 parallel agents — deterministic + `claude -p` — on every change. Findings stream live to a React console at http://localhost:5174.

This is a **standalone project** — its own daemon, its own session, never touches the watched repo's editor or bundle. Currently pointed at the Nik app at `~/NIK/` (the first real-world target driving the design). Stack-agnostic: works on any project that fits the configured globs in `dev-infra.config.json`. Generalization to `npx nik-dev-infra init` is on the roadmap.

The product principle is **hard path, not happy path** — every agent must reach 100% factual confidence before it emits a finding, and every write-back to the user's repo passes through the curator's cross-verification gate. Cost is covered by Claude Max; no per-token billing.

## Quickstart

```bash
git clone https://github.com/NiKhilForCybersec/nik-dev-infra
cd nik-dev-infra
npm install
npm run init -- --target ~/MyApp        # auto-detects stack + writes dev-infra.config.json
npm start
```

- Daemon: `http://localhost:5175` (Fastify + WebSocket)
- UI:     `http://localhost:5174` (React + Vite, proxies API/WS)

Open the UI, then edit any file under the watched repo. Findings appear in real time.

### `npm run init` — stack-detecting setup wizard

```bash
npm run init                                       # interactive — prompts for target path
npm run init -- --target ~/MyApp                   # detects + prompts for confirmation
npm run init -- --target ~/MyApp --label MyApp -y  # detects + writes, no prompts
npm run init -- --detect-only ~/MyApp              # dry-run, prints detected config only
```

Auto-detects: framework (Vite / Next / Remix / SvelteKit / Expo / RN), `screensGlob`, `contractsDir`, `manifestsGlob`, `migrationsGlob`, `backendDirs`, `frontendGlobs`, `screenshotsDir`, `concernsFile`, `resolutionsFile`, `claudeMdFile`. Walks workspace package locations (`web/`, `app/`, `apps/web/`, etc.) so monorepos work. Existing `writeback` / `riskGate` / `autoFixLoop` overrides are preserved on re-runs.

## Agents (28 shipped)

**Deterministic (no LLM, ~150ms typical):**

| Agent              | What it answers                                                              |
|--------------------|------------------------------------------------------------------------------|
| registry           | How many ops + commands? Any duplicate names?                                |
| health             | Are Anthropic / OpenAI / Supabase / MCP reachable? p95 latency?              |
| graph              | Project topology — screens, ops, cmds, endpoints, llm-providers, tables, components, all the edges between them |
| llm-cost           | Did any LLM call breach the cost threshold? Daily spend vs budget?           |
| secrets            | Any committed API keys / private keys in tracked files?                      |
| memory-keeper      | Memory layer integrity, completeness %, vacuum + prune                       |
| mcp                | MCP server tool discovery + diff over time                                   |
| prober             | Runtime endpoint reachability + p95 latency                                  |
| screenshots        | Watches `docs/screenshots/` folder, registers as `has_screenshot` facts      |
| **screen-validator** | Per-screenshot Layer-1 validation (7 checks: blank / auth-wall / skeleton / error-state / network-pending / scroll-required / failed-nav) + confidence score |
| **screen-prober**  | Spawns the Playwright capture script every 30 min; pre-flights dev server, debounces across daemon restarts |
| **snapshotter**    | Atomic `memory.db` backups every 6h, prunes own archives                     |
| self-awareness     | Reads our own code; describes dev-infra's structure into the meta/self wiki  |
| self-monitor       | Per-agent latency / error rate / schema-rejection rate over 24h              |

**LLM-driven (`claude -p`, 5–180s per call):**

| Agent              | What it answers                                                              |
|--------------------|------------------------------------------------------------------------------|
| drift              | Manifest ↔ JSX wiring drift                                                  |
| navigation         | Broken onNav targets, missing route handlers, wrong tile destinations        |
| hardcoded          | JSX literals masquerading as live user data                                  |
| database           | Contract ↔ migration drift, missing RLS, missing user_id indexes             |
| concerns           | Classify entries in user's Concerns.md; route each to the right agent        |
| sync               | Same metric, two screens, disagreeing values (live vs hardcoded, etc.)       |
| accessibility      | Icon-only buttons, color-only state, missing alts, tap target size           |
| bindings           | Pin each JSX dynamic value to the exact op.field it reads                    |
| ai-coverage        | Every manual write/command has a matching aiAffordances phrase?              |
| bootstrap          | Cluster register entities into segments, seed the meta wiki                  |
| doc-ingest         | Read README + vision/architecture docs into the meta/intent wiki             |
| self-improve       | Propose prompt diffs for self-monitor-flagged problem agents (gated)         |
| **curator**        | Cross-verify before any user-repo write; audit Concerns.md + Resolutions.md  |
| **auto-fix-driver** | Pick a Concerns.md gap, dispatch a `claude -p` session in the user's repo to fix it (opt-in, dry-run by default — see [Continuous-dev loop](#continuous-dev-loop)) |

## Memory layers (L0 → L8)

All in one SQLite file (`data/memory.db`) via `better-sqlite3` in WAL mode. Every agent reads/writes through the same `memory.ts` module so cross-cutting invariants (timestamps, evidence arrays, confidence floors) are enforced in one place.

| Layer | What | Status |
|---|---|---|
| L0 findings | Append-only event stream (also mirrored to `findings.jsonl` for grep) | ✅ |
| L1a notes | Per-agent (key → value) scratchpad for current-state lookups | ✅ |
| L1b facts | 100%-confirmed (subject, predicate, object) triples — graph edges live here | ✅ |
| L2/L3 segments | Slash-pathed grouping (`screen/Home`, `screen/Home/widgets`) — the wiki + hooks scope against this | ✅ |
| L4 wiki | Long-form markdown per (segment, topic), with full revision history | ✅ |
| L5 register | URN-keyed canonical entity catalog (every screen / endpoint / op / cmd / llm-provider / mcp-tool) — graph nodes live here | ✅ |
| L6 hooks | (segment, event) → agent subscriptions; lifecycle events flow through here | ✅ |
| L7 runs + summaries | `agent_runs` (durable per-dispatch record) + `agent_summaries` (rolling per-agent prose, fed into next prompt as "PREVIOUSLY CONCLUDED") | ✅ |
| L8 snapshots | Atomic `memory.db` backups every 6h via SQLite's `db.backup()` API, pruned to last N | ✅ |

## Hard-path discipline (the product's main instruction hook)

Every agent prompt opens with: **"Hard path, never happy path. Below 100% confidence, don't emit."** Every fact stored in L1b carries confidence 1.0 only with file evidence. The curator runs cross-verification rules before any concern hits the user's repo, and write-back is consent-gated (default off). Vague / observational / speculative concerns (no file ref, no imperative verb, words like *maybe / perhaps / consider*) are caught upstream by the auto-fix-driver's actionability filter and never dispatched.

When a finding's confidence drops below 100%, the agent emits a `needs-clarification` (auto-fix) or `audit-uncertain` (curator) instead of fabricating a verdict. Better to leave a question open than ship a wrong answer.

## Continuous-dev loop

Opt-in autonomous loop (`auto-fix-driver` agent) that drives the user's `Concerns.md` to zero. Each cycle:

1. **Read** `<repo>/docs/Concerns.md` and `Resolutions.md`.
2. **Compute the gap set**: concerns whose claimed resolution is missing OR was flagged by the curator as cosmetic / regressed / unverifiable.
3. **Filter for actionability**: requires a file ref OR a curator verdict OR an imperative verb. Speculative wording rejected.
4. **Filter by scope**: only files matching `autoFixLoop.scopes` globs (default: `["docs/**", "*.md", "*.json"]`) are eligible. Source-file concerns get an `out-of-scope` finding so you know which globs to add when expanding the loop.
5. **Pick top-1** by severity → recency → fewer prior attempts.
6. **Pre-dispatch git snapshot** captures HEAD; **post-dispatch diff** flags any out-of-scope file edits.
7. **Dispatch** `claude -p` with `cwd=<userRepo>` + Read/Edit/Write/Glob/Grep tools + a verification-required prompt: append a `Resolutions.md` entry citing concrete evidence (tsc pass / call-site trace / screenshot diff) OR a "deferred — needs clarification" note. No hedging language allowed.
8. **Curator audits** the new resolution next pass — `cosmetic` / `regressed` / `unverifiable` count as failures.

**Hard guards** (any one fails → cycle aborts with an info finding):

- `autoFixLoop.enabled === true`
- Kill-switch sentinel `<repo>/.dev-infra-pause` not present (touch it to pause instantly without restarting the daemon)
- Concerns.md exists
- Cycles in trailing 24h < `maxCyclesPerDay` (default `1`)
- Last N cycles weren't all failures (default `maxConsecutiveFailures: 3`)
- Working tree is clean (live mode only — won't clobber in-progress edits)
- Per-concern attempt count < 2

**Default OFF + dryRun=true**: the driver builds + emits the planned prompt as a finding instead of dispatching, so the selector + prompt can be calibrated against your actual Concerns.md before unleashing real edits. Dashboard panel **AUTO-FIX** surfaces every cycle event with diff / claude-output drilldown.

## Screenshots (the SCREENS gallery + visual validation)

The dashboard's **SCREENS** gallery renders a thumbnail per screen. Thumbnails come from `<watched-repo>/docs/screenshots/<ScreenName>.png`. Each capture is scored by **screen-validator** (Layer-1, deterministic) — 7 checks (file size floor, auth markers, skeleton markers, error-boundary, pending network, console errors, content-height) → verdict (`ok` / `blank` / `auth-wall` / `skeleton-loading` / `error-state` / `network-pending` / `scroll-required` / `failed-nav`) + confidence 0–1. Verdict + confidence shown as a chip on each card.

**Three ways to populate the folder:**

1. **Daemon-driven (recommended)** — the **screen-prober** agent runs `scripts/take-screenshots.mjs` every 30 min in the background. Pre-flights the dev server (`http://localhost:5173/` by default) and skips if it's down. Cross-restart debounce via DB lookup so daemon reloads don't spawn redundant captures. Just install Playwright once:
   ```bash
   npm i -D playwright
   npx playwright install chromium
   npm run screenshots:login        # one-time: opens a headed browser; log into your app, press Enter
   ```
   That's it — captures land automatically.

2. **Manual one-shot** — `npm run screenshots` runs the same script ad-hoc.

3. **Curator's CLAUDE.md gate** — flip `writeback.insertClaudeMdGate: true` in `dev-infra.config.json`. The curator inserts an instruction block into your repo's `CLAUDE.md` telling that session to drop a fresh `<ScreenName>.png` after every `*Screen.tsx` edit. (Requires `writeback.enabled: true` first; default both are off.)

Auth handling: the script tolerates a missing `data/playwright-auth.json` by clicking "Continue as demo user" / "Skip" / equivalent on the auth screen. Override per-screen via `CUSTOM_NAV` in `scripts/take-screenshots.mjs` for cases the default tile-click strategy misses. Tile-label aliases live in `SCREEN_ALIASES` for screens whose visible tile name differs from the class name.

## Roadmap

- **`npx nik-dev-infra init`** — stack-detecting setup wizard (auto-detects screens glob, backend dirs, screenshot folder)
- **User-repo knowledge graph (Graphify-class)** — Tree-sitter AST + LLM intent extraction + Leiden clustering + embeddings, stored alongside L5 register, used as input by every agent for richer grounding
- **Multi-target daemon** — one daemon process watching multiple repos with isolated SQLite per target
- **Sandboxed LLM agent execution** — separate the agent runtime from the daemon process for blast-radius bounds
- **self-improve agent applies prompt diffs** (currently emits diff-as-finding only)
- **Approval queue UI** for live `auto-fix-driver` cycles (one-click approve/reject vs. full live mode)

## Why standalone

- Doesn't share the watched app's bundle, dependencies, or Claude Code session
- Findings persist across the watched app's dev sessions (the daemon keeps running)
- Cost / observability isolated
- Stack-agnostic by design — only the configurable globs in `dev-infra.config.json` point at the watched app

See [AGENTS.md](./AGENTS.md) for the architecture + conventions when extending.
