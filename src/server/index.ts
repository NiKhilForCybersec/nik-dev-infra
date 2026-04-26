/* Entry: starts Fastify on 5175, mounts WS, kicks off the orchestrator. */

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { AGENTS } from './agents/index.ts';
import { onFinding, onRun, snapshot } from './findings.ts';
import { startOrchestrator } from './orchestrator.ts';
import type { ServerEvent } from './types.ts';

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
  };
});

// WebSocket: live feed.
app.register(async (instance) => {
  instance.get('/ws', { websocket: true }, (socket /* WebSocket */) => {
    const send = (e: ServerEvent) => {
      try { socket.send(JSON.stringify(e)); } catch { /* socket may be closed */ }
    };
    // Push the snapshot first so the UI can hydrate before live events arrive.
    const snap = snapshot();
    send({
      type: 'snapshot',
      ...snap,
      agents: AGENTS.map((a) => ({ name: a.name, description: a.description })),
    } as ServerEvent);
    const off1 = onFinding((finding) => send({ type: 'finding', finding }));
    const off2 = onRun((run) => send({ type: 'run', run }));
    socket.on('close', () => { off1(); off2(); });
  });
});

await app.listen({ port: PORT, host: HOST });
console.log(`[server] daemon listening on http://${HOST}:${PORT}`);

// Start the agent orchestrator AFTER the server is up so the very
// first findings are broadcastable.
startOrchestrator();
