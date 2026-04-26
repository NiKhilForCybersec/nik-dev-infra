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
import { entities, factsByPredicate, getPhase, listHooks, listSegments, memoryStats, query, recallAll, wikiHistory, wikiList, wikiRead } from './memory.ts';
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
    phase: getPhase(),
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

// REST: rich entity rollups for the per-entity drill-down panel (D.15).
// Per entity: register fields + in/out edge counts + recent finding stats.
// One round-trip; the UI groups client-side by `kind`.
app.get('/api/entities-rich', async () => {
  const all = entities();
  const inByUrn = new Map<string, number>();
  const outByUrn = new Map<string, number>();
  for (const r of query<{ subject: string; n: number }>(`SELECT subject, COUNT(*) AS n FROM facts GROUP BY subject`)) {
    outByUrn.set(r.subject, r.n);
  }
  for (const r of query<{ object: string; n: number }>(`SELECT object, COUNT(*) AS n FROM facts GROUP BY object`)) {
    inByUrn.set(r.object, r.n);
  }
  // Findings touching this entity (file match OR summary mentions URN).
  const findingsByFile = new Map<string, { total: number; err: number; warn: number; lastAt: number; lastKind: string; lastSev: string }>();
  for (const r of query<{ file: string | null; severity: string; kind: string; at: number }>(
    `SELECT file, severity, kind, at FROM findings WHERE file IS NOT NULL ORDER BY at DESC`
  )) {
    if (!r.file) continue;
    const cur = findingsByFile.get(r.file) ?? { total: 0, err: 0, warn: 0, lastAt: 0, lastKind: '', lastSev: '' };
    cur.total++;
    if (r.severity === 'error') cur.err++;
    else if (r.severity === 'warn') cur.warn++;
    if (r.at > cur.lastAt) { cur.lastAt = r.at; cur.lastKind = r.kind; cur.lastSev = r.severity; }
    findingsByFile.set(r.file, cur);
  }
  const enriched = all.map((e) => {
    const f = e.file ? findingsByFile.get(e.file) : undefined;
    return {
      ...e,
      inDegree: inByUrn.get(e.urn) ?? 0,
      outDegree: outByUrn.get(e.urn) ?? 0,
      findingTotal: f?.total ?? 0,
      findingErr: f?.err ?? 0,
      findingWarn: f?.warn ?? 0,
      lastFindingAt: f?.lastAt ?? null,
      lastFindingKind: f?.lastKind ?? null,
      lastFindingSeverity: f?.lastSev ?? null,
    };
  });
  return { entities: enriched };
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

// REST: latest screenshot for a screen URN. URN format: 'screen:HomeScreen'
// (we accept the bare screen name too). Looks up the most-recent matching
// PNG in <repo>/<config.screenshotsDir>/.
app.get<{ Params: { urn: string } }>('/api/screenshots/:urn', async (req, reply) => {
  const urn = decodeURIComponent(req.params.urn);
  const screenName = urn.startsWith('screen:') ? urn.slice('screen:'.length) : urn;
  if (!/^[A-Z][A-Za-z0-9]*Screen$/.test(screenName)) {
    reply.code(400);
    return { error: 'expected URN of the form screen:<Name>Screen' };
  }
  const dir = resolve(config.targetPath, config.screenshotsDir);
  if (!existsSync(dir)) {
    reply.code(404);
    return { error: `screenshots dir not present: ${config.screenshotsDir}` };
  }
  const fs = await import('node:fs');
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { reply.code(404); return { error: 'unreadable' }; }
  const sorted = names
    .filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && new RegExp(`^${screenName}\\b`).test(n))
    .map((n) => ({ n, m: fs.statSync(resolve(dir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  const newest = sorted[0];
  if (!newest) {
    reply.code(404);
    return { error: `no screenshot for ${screenName} — drop one at ${config.screenshotsDir}/${screenName}.png` };
  }
  const file = resolve(dir, newest.n);
  const ext = newest.n.slice(newest.n.lastIndexOf('.') + 1).toLowerCase();
  const ct = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  reply.header('content-type', ct);
  reply.header('cache-control', 'no-cache');
  return fs.readFileSync(file);
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
      phase: getPhase(),
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
