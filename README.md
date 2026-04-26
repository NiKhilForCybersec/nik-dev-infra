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

## Agents (12 shipped)

| Agent          | What it answers                                                              | Powered by    |
|----------------|------------------------------------------------------------------------------|---------------|
| registry       | How many ops + commands? Any duplicate names?                                | deterministic |
| health         | Are Anthropic / OpenAI / Supabase / MCP reachable? p95 latency?              | deterministic |
| graph          | What's the project topology — screens → ops → cmds → navigation?             | deterministic |
| llm-cost       | Did any LLM call breach the cost threshold? Daily spend vs budget?           | deterministic |
| secrets        | Any committed API keys / private keys in tracked files?                      | deterministic |
| drift          | What manifest declarations don't match JSX usage?                            | claude -p     |
| navigation     | Does any onNav('xxx') target a screen that doesn't exist?                    | claude -p     |
| hardcoded      | What JSX literals look like fake/demo data instead of real ops?              | claude -p     |
| database       | Contract↔migration drift; missing RLS; missing user_id index                 | claude -p     |
| concerns       | Open vs resolved entries in `<repo>/docs/Concerns.md`; route to right agent  | claude -p     |
| sync           | Same metric on two screens with disagreeing values?                          | claude -p     |
| accessibility  | Icon-only buttons, color-only state, missing alts, keyboard traps            | claude -p     |

Roadmap: persistent memory layer (SQLite + per-agent markdown notebooks), bootstrap pass that builds a 100%-confident project model, write-back to `<repo>/docs/Concerns.md` + consent-gated `CLAUDE.md` line, meta-agent that learns from past findings, and `npx <name> <repo>` generalization.

## Why standalone

- Doesn't share the watched app's bundle, dependencies, or Claude Code session
- Findings persist across the watched app's dev sessions (the daemon keeps running)
- Cost / observability isolated
- Designed from day 1 to be drop-in for any TypeScript project — only the configurable target paths point at the watched app

See [AGENTS.md](./AGENTS.md) for the architecture + conventions when extending.
