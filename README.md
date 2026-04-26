# nik-dev-infra

Always-on dev infrastructure for the [Nik app](../NIK). Runs a long-lived Node daemon that watches the Nik codebase and spawns parallel `claude -p` agents on every change. Findings stream live to a React console at http://localhost:5174.

Cost: covered by Claude Max subscription. No per-token billing.

## Quickstart

```bash
cd ~/nik-dev-infra
npm install
npm start
```

- Daemon: `http://localhost:5175` (Fastify + WebSocket)
- UI:     `http://localhost:5174` (React + Vite, proxies API/WS)

Open the UI, then edit any file under `~/NIK/web/src/` or `~/NIK/supabase/`. Findings appear in real time.

## Agents (current)

| Agent      | What it answers                                                       | Powered by   |
|------------|------------------------------------------------------------------------|--------------|
| registry   | How many ops + commands? Any duplicate names?                         | deterministic |
| drift      | What manifest declarations don't match JSX usage?                     | claude -p     |
| navigation | Does any onNav('xxx') target a screen that doesn't exist?             | claude -p     |
| hardcoded  | What JSX literals look like fake/demo data instead of real ops?       | claude -p     |

Adding more (next sessions): database, health, llm, activity, graph, concerns, meta.

## Why separate from Nik

- Doesn't share Nik's bundle / dependencies / context
- Has its own dev session in Claude Code so you can extend agents without context-switching
- Findings persist across Nik dev sessions (the daemon keeps running)
- Cost / observability isolated
- Eventually extractable as `npx <some-name> <project-path>` for any TS project

See [AGENTS.md](./AGENTS.md) for the architecture + conventions when extending.
