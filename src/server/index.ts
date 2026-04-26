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
import { entities, factsByPredicate, listHooks, listSegments, memoryStats, query, recallAll, wikiHistory, wikiList, wikiRead } from './memory.ts';
import { startOrchestrator, triggerAgent } from './orchestrator.ts';
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

// REST: segments tree.
app.get<{ Querystring: { parent?: string } }>('/api/segments', async (req) => {
  if (req.query.parent === undefined) return { segments: listSegments() };
  const parent = req.query.parent === '' ? null : req.query.parent;
  return { segments: listSegments(parent) };
});

// REST: register catalog (entities). Optional kind / segment filter.
app.get<{ Querystring: { kind?: string; segment?: string } }>('/api/register', async (req) => {
  return { entities: entities({ kind: req.query.kind, segment: req.query.segment }) };
});

// REST: active hooks list.
app.get('/api/hooks', async () => {
  return { hooks: listHooks() };
});

// REST: wiki — list all pages, optionally filtered by segment.
app.get<{ Querystring: { segment?: string } }>('/api/wiki', async (req) => {
  return { pages: wikiList(req.query.segment) };
});

// REST: wiki — read a single page.
app.get<{ Querystring: { segment?: string; topic?: string; history?: string } }>('/api/wiki/page', async (req, reply) => {
  const seg = req.query.segment;
  const topic = req.query.topic;
  if (!seg || !topic) {
    reply.code(400);
    return { error: 'segment and topic are required' };
  }
  const page = wikiRead(seg, topic);
  if (!page) {
    reply.code(404);
    return { error: 'page not found' };
  }
  if (req.query.history === '1') {
    return { page, revisions: wikiHistory(seg, topic) };
  }
  return { page };
});

// REST: manually trigger an agent by name. Useful for the bootstrap
// pass and any agent the user wants to re-run on demand.
app.post<{ Params: { name: string } }>('/api/agents/:name/run', async (req, reply) => {
  const r = triggerAgent(req.params.name);
  if (!r.ok) {
    reply.code(404);
    return { error: r.reason };
  }
  return { ok: true };
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
