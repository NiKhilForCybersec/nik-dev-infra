/* Entry: starts Fastify on 5175, mounts WS, kicks off the orchestrator. */

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents/index.ts';
import { config } from './config.ts';
import { onFinding, onRun, snapshot } from './findings.ts';
import { factsByPredicate, memoryStats, query, recallAll } from './memory.ts';
import { startOrchestrator } from './orchestrator.ts';
import type { ServerEvent } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = resolve(here, '../../data/graph.json');

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);

// REST: snapshot — initial state for the UI.
app.get('/api/snapshot', async () => {
  const snap = snapshot();
  return {
    ...snap,
    agents: AGENTS.map((a) => ({ name: a.name, description: a.description })),
    target: { path: config.targetPath, label: config.targetLabel },
  };
});

// REST: persistent memory stats + recent activity per agent.
app.get('/api/memory', async () => {
  const stats = memoryStats();
  const perAgent = AGENTS.map((a) => ({
    agent: a.name,
    notes: recallAll(a.name).length,
    findings: (query<{ n: number }>('SELECT COUNT(*) AS n FROM findings WHERE agent = ?', [a.name])[0]?.n) ?? 0,
  }));
  return { stats, perAgent };
});

// REST: facts ledger (the 100%-confirmed graph substrate).
app.get<{ Querystring: { predicate?: string } }>('/api/facts', async (req) => {
  const pred = req.query.predicate;
  if (!pred) {
    const sample = query<{ predicate: string; n: number }>(`
      SELECT predicate, COUNT(*) AS n FROM facts GROUP BY predicate ORDER BY n DESC LIMIT 20
    `);
    return { byPredicate: sample };
  }
  return { facts: factsByPredicate(pred) };
});

// REST: project topology graph (built by the graph agent).
app.get('/api/graph', async (_req, reply) => {
  if (!existsSync(GRAPH_FILE)) {
    reply.code(404);
    return { error: 'graph not yet built — wait for the graph agent to complete one run' };
  }
  reply.header('content-type', 'application/json');
  return readFileSync(GRAPH_FILE, 'utf8');
});

// WebSocket: live feed.
let wsClients = 0;
app.register(async (instance) => {
  instance.get('/ws', { websocket: true }, (socket /* WebSocket */) => {
    wsClients++;
    app.log.info(`[ws] client connected · ${wsClients} active`);
    const send = (e: ServerEvent) => {
      try { socket.send(JSON.stringify(e)); } catch { /* socket may be closed */ }
    };
    // Push the snapshot first so the UI can hydrate before live events arrive.
    const snap = snapshot();
    send({
      type: 'snapshot',
      ...snap,
      agents: AGENTS.map((a) => ({ name: a.name, description: a.description })),
      target: { path: config.targetPath, label: config.targetLabel },
    } as ServerEvent);
    const off1 = onFinding((finding) => {
      app.log.info(`[ws] finding → ${wsClients} client(s) · ${finding.agent}/${finding.kind}`);
      send({ type: 'finding', finding });
    });
    const off2 = onRun((run) => {
      app.log.info(`[ws] run → ${wsClients} client(s) · ${run.agent} · ${run.ok ? 'ok' : 'fail'} · ${run.findingCount}f/${run.durationMs}ms`);
      send({ type: 'run', run });
    });
    socket.on('close', () => {
      wsClients--;
      app.log.info(`[ws] client disconnected · ${wsClients} active`);
      off1(); off2();
    });
  });
});

await app.listen({ port: PORT, host: HOST });
console.log(`[server] daemon listening on http://${HOST}:${PORT}`);

// Start the agent orchestrator AFTER the server is up so the very
// first findings are broadcastable.
startOrchestrator();
