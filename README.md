# nik-dev-infra

[![ci](https://github.com/NiKhilForCybersec/nik-dev-infra/actions/workflows/ci.yml/badge.svg)](https://github.com/NiKhilForCybersec/nik-dev-infra/actions/workflows/ci.yml)

Always-on dev infrastructure that watches a TypeScript codebase and spawns parallel `claude -p` agents on every change. Findings stream live to a React console at http://localhost:5174.

This is a **standalone project** — not part of any app it watches. Right now it's pointed at the Nik app at `~/NIK/` (that's the first real-world target driving the agent design), but it's being built so any developer can clone this repo, point it at their own codebase, and get the same live agent dashboard. Generalization to a `npx` plugin is on the roadmap (Phase 5).

Cost: covered by Claude Max subscription. No per-token billing.

## Quickstart

```bash
cd ~/nik-dev-infra
npm install
npm start
```

- Daemon: `http://localhost:5175` (Fastify + WebSocket)
- UI:     `http://localhost:5174` (React + Vite, proxies API/WS)

Open the UI, then edit any file under the watched repo. Findings appear in real time.

## Agents (22 shipped)

**Deterministic (no LLM):**

| Agent           | What it answers                                                              |
|-----------------|------------------------------------------------------------------------------|
| registry        | How many ops + commands? Any duplicate names?                                |
| health          | Are Anthropic / OpenAI / Supabase / MCP reachable? p95 latency?              |
| graph           | Project topology — screens, ops, cmds, endpoints, llm-providers, tables, components, all the edges between them |
| llm-cost        | Did any LLM call breach the cost threshold? Daily spend vs budget?           |
| secrets         | Any committed API keys / private keys in tracked files?                      |
| memory-keeper   | Memory layer integrity, completeness %, vacuum + prune                       |
| mcp             | MCP server tool discovery + diff over time                                   |
| prober          | Runtime endpoint reachability + p95 latency                                  |
| screenshots     | Watches docs/screenshots/ folder, registers as `has_screenshot` facts        |
| self-awareness  | Reads our own code; describes dev-infra's structure into the meta/self wiki  |
| self-monitor    | Per-agent latency / error rate / schema-rejection rate over 24h              |

**LLM-driven (`claude -p`):**

| Agent           | What it answers                                                              |
|-----------------|------------------------------------------------------------------------------|
| drift           | Manifest ↔ JSX wiring drift                                                  |
| navigation      | Broken onNav targets, missing route handlers, wrong tile destinations        |
| hardcoded       | JSX literals masquerading as live user data                                  |
| database        | Contract ↔ migration drift, missing RLS, missing user_id indexes             |
| concerns        | Classify entries in user's Concerns.md; route each to the right agent        |
| sync            | Same metric, two screens, disagreeing values (live vs hardcoded, etc.)       |
| accessibility   | Icon-only buttons, color-only state, missing alts, tap target size           |
| bindings        | Pin each JSX dynamic value to the exact op.field it reads                    |
| ai-coverage     | Every manual write/command has a matching aiAffordances phrase?              |
| bootstrap       | Cluster register entities into segments, seed the meta wiki                  |
| doc-ingest      | Read README + vision/architecture docs into the meta/intent wiki             |
| self-improve    | Propose prompt diffs for self-monitor-flagged problem agents (gated)         |
| **curator**     | Cross-verify before any user-repo write; audit Concerns.md + Resolutions.md  |

## Memory layers (L0 → L8)

| Layer | What | Status |
|---|---|---|
| L0 findings | append-only event log + ring buffer + JSONL on disk | ✅ |
| L1 facts + notes | (subject,predicate,object) triples + per-agent kv | ✅ |
| L2/L3 segments | slash-pathed product partitions (auth/oauth/github) | ✅ |
| L4 wiki | machine-written, human-editable markdown per (segment, topic), Obsidian-vault-friendly | ✅ |
| L5 register | URN-keyed canonical entity catalog | ✅ |
| L6 hooks | (segment, event) → agent subscriptions; wildcard matching | ✅ |
| L7 vector | semantic recall — pending until corpus warrants | ⏸ |
| L8 snapshots | periodic memory.db archives | ⏸ |

## Hard-path discipline

Every agent prompt opens with: "Hard path, never happy path. Below 100% confidence, don't emit." Every fact has confidence 1.0 only with file evidence. The curator runs cross-verification rules before any concern hits the user's repo, and write-back is consent-gated (default off).

## Screenshots (optional, for the SCREENS gallery)

The dashboard's **SCREENS** gallery shows a thumbnail per screen. Thumbnails come from `<watched-repo>/docs/screenshots/<ScreenName>.png`. Three ways to populate that folder:

**Option 1 — your Claude Code session in the watched repo:** ask it to take screenshots once. Cleanest, no new deps.

**Option 2 — automated via Playwright** (one-time install, repeatable runs):
```bash
npm i -D playwright             # ~50 MB npm + 170 MB Chromium download
npx playwright install chromium

npm run screenshots:login        # one-time: opens a headed browser; log into your app, press Enter
npm run screenshots              # captures every Screen entity to <repo>/docs/screenshots/
```
The script reads the screen list from the running daemon (or the screens dir on disk if daemon is down) and follows a default tile-click navigation strategy; edit `scripts/take-screenshots.mjs`'s `CUSTOM_NAV` map to override per-screen routes when needed. Auth survives across runs via `data/playwright-auth.json` (gitignored).

**Option 3 — the curator's CLAUDE.md gate:** flip `writeback.insertClaudeMdGate: true` in `dev-infra.config.json`. The curator inserts an instruction block into your repo's CLAUDE.md telling that session to drop a fresh `*Screen.png` after every `*Screen.tsx` edit. (Requires `writeback.enabled: true` first; default both are off.)

## Roadmap

- Setup wizard for first-run target picker
- Bootstrap progress UI (completeness % + ETA)
- Playwright screen-mount probes (runtime verification of UI wirings)
- L8 snapshots
- Phase 4 meta-agent (learns from past findings)
- Phase 5: `npx nik-dev-infra <repo>` for any TypeScript project

## Why standalone

- Doesn't share the watched app's bundle, dependencies, or Claude Code session
- Findings persist across the watched app's dev sessions (the daemon keeps running)
- Cost / observability isolated
- Designed from day 1 to be drop-in for any TypeScript project — only the configurable target paths point at the watched app

See [AGENTS.md](./AGENTS.md) for the architecture + conventions when extending.
