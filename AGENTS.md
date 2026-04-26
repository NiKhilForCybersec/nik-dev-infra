# nik-dev-infra · agent project context

This directory is **dev infrastructure for the Nik app** at `~/NIK/`. It runs an always-on Node daemon that watches the Nik codebase, spawns parallel `claude -p` agent calls on file changes, and surfaces findings to a live React console at http://localhost:5174.

## Sibling, not parent

- `~/NIK/` — the actual Nik app (separate Claude Code session)
- `~/nik-dev-infra/` — this project (this Claude Code session)

When extending agents in this session, NEVER touch files in `~/NIK/` unless the user explicitly asks. The agents READ the Nik codebase; they don't WRITE to it. Edits to Nik happen in the other session.

## Architecture

```
src/server/
├── index.ts           Fastify on :5175, mounts WS, starts orchestrator
├── orchestrator.ts    Schedules agents on file change + intervals
├── watcher.ts         chokidar over ~/NIK/{web/src,supabase,docs}
├── claude.ts          Wrapper around `execa('claude', ['-p', ...])`
├── findings.ts        Append-only JSONL writer + in-memory ring buffer
├── types.ts           Finding, Agent, AgentRun
└── agents/
    ├── index.ts       Registers all agents
    ├── <name>.ts      Agent runner (TS): builds prompt, parses output
    └── <name>.md      Agent prompt (markdown — easy to edit + self-improve)
```

UI lives at `src/ui/` and runs on Vite :5174 with proxy to the daemon's :5175.

## How an agent works

1. Watcher fires for a changed file → orchestrator picks affected agents from a routing table
2. Orchestrator spawns the agent in parallel with sibling agents (Promise.all)
3. Agent's `run(input)` builds the Claude prompt by reading its sibling `.md` file + context
4. `claude.ts` shells out: `claude -p <prompt> --output-format stream-json --add-dir ~/NIK`
5. Output streams in; agent parses, validates against Zod schema
6. Each finding is appended to `data/findings.jsonl` + broadcast over WebSocket
7. UI renders new findings live

## Adding a new agent

1. Create `src/server/agents/<name>.md` — the prompt (clear instructions, JSON output schema)
2. Create `src/server/agents/<name>.ts` — the runner (1 export: `runFn`, `routedFiles`, `name`)
3. Register in `src/server/agents/index.ts`
4. Restart `npm run daemon`

That's it. The orchestrator + UI handle the rest.

## Self-improvement loop

`agents/meta.md` (build later) reads the last N findings + `~/NIK/docs/Concerns.md` and proposes prompt diffs to other agent `.md` files. Diffs go to a review queue in the UI; user approves → committed to this repo.

## Running

```bash
cd ~/nik-dev-infra
npm install
npm start    # concurrently: daemon (:5175) + UI (:5174)
```

Open http://localhost:5174.

## Conventions for Claude Code in THIS session

- This is dev infrastructure, not user-facing product. Optimize for clarity + observability over polish.
- Prefer small focused agents over one mega-agent. Each agent should answer ONE question.
- Agent prompts live in markdown files — easy to read, edit, version, and (later) auto-improve.
- Findings are append-only. Never mutate or delete past findings; new findings supersede.
- The `~/NIK/` codebase is read-only from here. If you need to fix something IN Nik, surface it as a finding.
- Cost is covered by Claude Max subscription. Don't worry about per-call billing — but don't spawn agents needlessly either.
