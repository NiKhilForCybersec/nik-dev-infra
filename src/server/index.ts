/* Entry: starts Fastify on 5175, mounts WS, kicks off the orchestrator. */

import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from './agents/index.ts';
import { config } from './config.ts';
import { emit, newId, onFinding, onRun, snapshot } from './findings.ts';
import { decideApproval, entities, factsByPredicate, getApproval, getPhase, listApprovals, listHooks, listSegments, memoryStats, query, recallAll, wikiHistory, wikiList, wikiRead } from './memory.ts';
import { startOrchestrator, triggerAgent } from './orchestrator.ts';
import type { Finding, ServerEvent } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const GRAPH_FILE = resolve(here, '../../data/graph.json');

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);

function latestCompleteness(): {
  overall_pct: number;
  screens: { total: number; withEdges: number };
  entities: { total: number; withEvidence: number };
  segments: { total: number; withWiki: number };
  at: number;
} | null {
  const rows = query<{ payload_json: string | null; at: number }>(
    `SELECT payload_json, at FROM findings WHERE agent = 'memory-keeper' AND kind = 'memory:completeness' ORDER BY at DESC LIMIT 1`
  );
  if (rows.length === 0 || !rows[0]?.payload_json) return null;
  try {
    const p = JSON.parse(rows[0].payload_json) as {
      overall_pct: number;
      screens: { total: number; withEdges: number };
      entities: { total: number; withEvidence: number };
      segments: { total: number; withWiki: number };
    };
    return { ...p, at: rows[0].at };
  } catch { return null; }
}

// REST: setup — read + write dev-infra.config.json so users can
// re-target the watched repo from the dashboard without editing the
// JSON by hand. Daemon restart required for new config to take effect.
const CONFIG_FILE_PATH = resolve(here, '../../dev-infra.config.json');

app.get('/api/config', async () => {
  const fs = await import('node:fs');
  const hasUserConfig = fs.existsSync(CONFIG_FILE_PATH);
  return {
    target: { path: config.targetPath, label: config.targetLabel },
    screenshotsDir: config.screenshotsDir,
    concernsFile: config.concernsFile,
    resolutionsFile: config.resolutionsFile,
    claudeMdFile: config.claudeMdFile,
    writeback: config.writeback,
    riskGate: config.riskGate,
    autoFixLoop: config.autoFixLoop,
    hasUserConfig,
    configFilePath: CONFIG_FILE_PATH,
  };
});

app.post<{ Body: { targetPath?: string; targetLabel?: string } }>('/api/config', async (req, reply) => {
  const fs = await import('node:fs');
  const body = req.body ?? {};
  const targetPath = (body.targetPath ?? '').trim();
  const targetLabel = (body.targetLabel ?? '').trim();
  if (!targetPath || !targetLabel) {
    reply.code(400);
    return { error: 'targetPath and targetLabel are required' };
  }
  // Persist a minimal config — only the fields the user provides. The
  // schema's defaults fill in everything else on next boot.
  const existing: Record<string, unknown> = fs.existsSync(CONFIG_FILE_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8')) as Record<string, unknown>
    : {};
  existing.targetPath = targetPath;
  existing.targetLabel = targetLabel;
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(existing, null, 2) + '\n');
  return { ok: true, restartRequired: true, configFilePath: CONFIG_FILE_PATH };
});

// REST: snapshot — initial state for the UI.
app.get('/api/snapshot', async () => {
  const snap = snapshot();
  return {
    ...snap,
    agents: AGENTS.map((a) => ({ name: a.name, description: a.description })),
    target: { path: config.targetPath, label: config.targetLabel },
    phase: getPhase(),
    completeness: latestCompleteness(),
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

// REST: pending approvals queue. Returns rows with the payload parsed
// so the dashboard doesn't have to JSON.parse on every render.
app.get<{ Querystring: { filter?: string } }>('/api/approvals', async (req) => {
  const filter = req.query.filter === 'all' ? 'all' : 'pending';
  const rows = listApprovals(filter);
  return {
    approvals: rows.map((r) => ({
      ...r,
      payload: (() => { try { return JSON.parse(r.payload_json); } catch { return null; } })(),
    })),
  };
});

// POST /api/approvals/:id/decide  body: { decision: 'approved'|'rejected', note?: string }
// On reject, attempts to revert each file in the diff via `git checkout --`.
// Hard-path: the revert is best-effort; failures emit auto-fix:revert-failed
// for human follow-up rather than silently leaving partial state.
app.post<{ Params: { id: string }; Body: { decision: 'approved' | 'rejected'; note?: string } }>(
  '/api/approvals/:id/decide',
  async (req, reply) => {
    const { decision, note } = req.body ?? {};
    if (decision !== 'approved' && decision !== 'rejected') {
      reply.code(400);
      return { error: `decision must be 'approved' or 'rejected'` };
    }
    const row = getApproval(req.params.id);
    if (!row) {
      reply.code(404);
      return { error: 'approval not found' };
    }
    if (row.status !== 'pending') {
      reply.code(409);
      return { error: `approval already ${row.status}` };
    }

    let revertErrors: string[] = [];
    let applyErrors: string[] = [];

    // Branch on the approval kind — auto-fix and self-improve have
    // different "approve / reject" semantics.
    const isAutoFix = row.kind === 'auto-fix:cycle-complete';
    const isPromptDiff = row.kind === 'self:prompt-diff-proposal';

    if (decision === 'rejected' && isAutoFix) {
      // Revert the file changes the dispatched session made.
      try {
        const payload = JSON.parse(row.payload_json) as { diff?: { filesChanged?: string[] }; headBefore?: string };
        const files = payload.diff?.filesChanged ?? [];
        const headBefore = payload.headBefore;
        if (files.length > 0) {
          const { execa } = await import('execa');
          for (const file of files) {
            try {
              if (headBefore) {
                await execa('git', ['checkout', headBefore, '--', file], { cwd: config.targetPath, timeout: 10_000 });
              } else {
                await execa('git', ['checkout', '--', file], { cwd: config.targetPath, timeout: 10_000 });
              }
            } catch (e) {
              revertErrors.push(`${file}: ${(e as Error).message.slice(0, 100)}`);
            }
          }
        }
      } catch (e) {
        revertErrors.push(`payload parse: ${(e as Error).message}`);
      }
    }

    if (decision === 'approved' && isPromptDiff) {
      // Defense-in-depth: even with explicit user approval, the
      // riskGate.allowWritePrompt flag still gates actually editing
      // dev-infra's own prompt files. Without it, decline + tell the user.
      if (!config.riskGate.allowWritePrompt) {
        reply.code(403);
        return {
          error: 'riskGate.allowWritePrompt is false — set it to true in dev-infra.config.json to apply prompt diffs',
        };
      }
      try {
        const payload = JSON.parse(row.payload_json) as { promptPath?: string; find?: string; replace?: string };
        const { promptPath, find, replace } = payload;
        if (!promptPath || typeof find !== 'string' || typeof replace !== 'string') {
          applyErrors.push('payload missing promptPath / find / replace');
        } else {
          const fs = await import('node:fs');
          if (!fs.existsSync(promptPath)) {
            applyErrors.push(`prompt file not found: ${promptPath}`);
          } else {
            const current = fs.readFileSync(promptPath, 'utf8');
            if (!current.includes(find)) {
              applyErrors.push(`find-text not present in prompt — likely already edited or stale proposal`);
            } else {
              const next = current.replace(find, replace);
              fs.writeFileSync(promptPath, next);
            }
          }
        }
      } catch (e) {
        applyErrors.push(`apply failed: ${(e as Error).message}`);
      }
      // If apply errored, surface it to the caller and DON'T mark approved
      // — the user can decide whether to re-attempt or reject instead.
      if (applyErrors.length > 0) {
        reply.code(500);
        return { error: 'apply failed', applyErrors };
      }
    }

    decideApproval(req.params.id, decision, note);
    // Emit a finding so the rail records the human decision. Use the
    // originating agent name so dashboard filters work correctly.
    const decisionAgent = isPromptDiff ? 'self-improve' : 'auto-fix-driver';
    const decisionKind = isPromptDiff
      ? (decision === 'approved' ? 'self:prompt-diff-applied' : 'self:prompt-diff-rejected')
      : (decision === 'approved' ? 'auto-fix:approved' : 'auto-fix:rejected');
    emit({
      id: newId(),
      agent: decisionAgent,
      kind: decisionKind,
      at: Date.now(),
      severity: (decision === 'rejected' && revertErrors.length > 0) ? 'warn' : 'info',
      summary: isPromptDiff
        ? (decision === 'approved'
            ? `applied prompt diff for ${(JSON.parse(row.payload_json) as { targetAgent?: string }).targetAgent ?? '?'}`
            : `rejected prompt diff ${req.params.id.slice(0, 8)}`)
        : (decision === 'approved'
            ? `approved cycle ${req.params.id.slice(0, 8)}`
            : `rejected cycle ${req.params.id.slice(0, 8)} · ${revertErrors.length === 0 ? 'clean revert' : `${revertErrors.length} revert errors`}`),
      payload: { approvalId: req.params.id, decision, note: note ?? null, revertErrors, applyErrors },
    } as Finding);

    if (revertErrors.length > 0) {
      emit({
        id: newId(),
        agent: 'auto-fix-driver',
        kind: 'auto-fix:revert-failed',
        at: Date.now(),
        severity: 'warn',
        summary: `${revertErrors.length} file(s) failed to revert — manual cleanup required`,
        payload: { approvalId: req.params.id, errors: revertErrors },
      } as Finding);
    }

    return { ok: true, decision, revertErrors };
  },
);

// REST: per-screen screenshot metadata (mtime, size, blank-flag) for the
// dashboard's quality check + cache-bust logic. The gallery polls this
// every ~10s and rebuilds img URLs with the mtime so a fresh capture
// is picked up without hard-reloading the browser.
//
// Blank detection: a real screen capture at 390x844 is typically 70-200
// KB. Files below 8 KB are almost certainly blank/degenerate and the
// capture script either timed out before paint or hit an error state.
// We surface `isBlank: true` so the UI can show a "re-run" hint instead
// of a useless white image.
// POST /api/memory/note — UI's "drop a note" button. Same write path
// as the MCP server's memory.note tool.
app.post<{ Body: { text?: string; scope?: string; tags?: string[] } }>('/api/memory/note', async (req, reply) => {
  const text = (req.body?.text ?? '').trim();
  if (!text) {
    reply.code(400);
    return { error: 'text is required' };
  }
  const scope = req.body?.scope?.trim() || 'session';
  const tags = Array.isArray(req.body?.tags) ? req.body!.tags!.filter((t): t is string => typeof t === 'string') : [];
  const { addFact, registerEntity } = await import('./memory.ts');
  const id = newId();
  const urn = `note:${id}`;
  registerEntity({
    urn, kind: 'note', label: text.slice(0, 80),
    agent: 'dashboard', segment: scope,
    evidence: [text], confidence: 1.0,
  });
  addFact({
    agent: 'dashboard',
    subject: urn, predicate: 'note_in_scope', object: `scope:${scope}`,
    evidence: [text], confidence: 1.0,
  });
  for (const tag of tags) {
    addFact({
      agent: 'dashboard',
      subject: urn, predicate: 'tagged', object: `tag:${tag}`,
      evidence: [text], confidence: 1.0,
    });
  }
  return { ok: true, urn };
});

// REST: memory-ground feed — unified view across the memory layers.
// Returns the most recent rows from notes / facts / wiki / register
// (filtered + paginated server-side for cheap UI). The dashboard's
// MEMORY GROUND panel polls this every 5s.
app.get<{ Querystring: { layer?: string; query?: string; segment?: string; kind?: string; hours?: string; limit?: string } }>('/api/memory/feed', async (req) => {
  const layer = req.query.layer ?? 'all';
  const q = req.query.query?.trim() ?? '';
  const segment = req.query.segment?.trim() ?? '';
  const kind = req.query.kind?.trim() ?? '';
  const hours = req.query.hours ? Number(req.query.hours) : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const sinceMs = hours && Number.isFinite(hours) ? Date.now() - hours * 60 * 60 * 1000 : 0;
  const like = `%${q}%`;

  type Row = { layer: string; at: number; primary: string; secondary: string; raw: Record<string, unknown> };
  const rows: Row[] = [];

  if (layer === 'all' || layer === 'notes') {
    const conds = ['1=1'];
    const params: unknown[] = [];
    if (q) { conds.push('(key LIKE ? OR value_json LIKE ?)'); params.push(like, like); }
    if (sinceMs > 0) { conds.push('at >= ?'); params.push(sinceMs); }
    params.push(limit);
    const r = query<{ agent: string; key: string; value_json: string; at: number }>(
      `SELECT agent, key, value_json, at FROM notes WHERE ${conds.join(' AND ')} ORDER BY at DESC LIMIT ?`, params,
    );
    for (const x of r) rows.push({ layer: 'notes', at: x.at, primary: `${x.agent}/${x.key}`, secondary: x.value_json.slice(0, 200), raw: x });
  }
  if (layer === 'all' || layer === 'facts') {
    const conds = ['1=1'];
    const params: unknown[] = [];
    if (q) { conds.push('(subject LIKE ? OR object LIKE ? OR predicate LIKE ?)'); params.push(like, like, like); }
    if (sinceMs > 0) { conds.push('at >= ?'); params.push(sinceMs); }
    params.push(limit);
    const r = query<{ subject: string; predicate: string; object: string; agent: string; confidence: number; at: number }>(
      `SELECT subject, predicate, object, agent, confidence, at FROM facts WHERE ${conds.join(' AND ')} ORDER BY at DESC LIMIT ?`, params,
    );
    for (const x of r) rows.push({ layer: 'facts', at: x.at, primary: `${x.subject} —${x.predicate}→ ${x.object}`, secondary: `agent: ${x.agent} · conf: ${x.confidence}`, raw: x });
  }
  if (layer === 'all' || layer === 'wiki') {
    const conds = ['1=1'];
    const params: unknown[] = [];
    if (q) { conds.push('(topic LIKE ? OR content LIKE ?)'); params.push(like, like); }
    if (segment) { conds.push('segment = ?'); params.push(segment); }
    if (sinceMs > 0) { conds.push('at >= ?'); params.push(sinceMs); }
    params.push(limit);
    const r = query<{ segment: string; topic: string; content: string; at: number }>(
      `SELECT segment, topic, content, at FROM wiki_pages WHERE ${conds.join(' AND ')} ORDER BY at DESC LIMIT ?`, params,
    );
    for (const x of r) rows.push({ layer: 'wiki', at: x.at, primary: `${x.segment}/${x.topic}`, secondary: x.content.slice(0, 200), raw: x });
  }
  if (layer === 'all' || layer === 'register') {
    const conds = ['1=1'];
    const params: unknown[] = [];
    if (q) { conds.push('(urn LIKE ? OR label LIKE ?)'); params.push(like, like); }
    if (segment) { conds.push('segment = ?'); params.push(segment); }
    if (kind) { conds.push('kind = ?'); params.push(kind); }
    if (sinceMs > 0) { conds.push('at >= ?'); params.push(sinceMs); }
    params.push(limit);
    const r = query<{ urn: string; kind: string; label: string; segment: string | null; agent: string; confidence: number; at: number; file: string | null }>(
      `SELECT urn, kind, label, segment, agent, confidence, at, file FROM register WHERE ${conds.join(' AND ')} ORDER BY at DESC LIMIT ?`, params,
    );
    for (const x of r) rows.push({ layer: 'register', at: x.at, primary: `${x.kind}: ${x.label}`, secondary: `${x.urn}${x.segment ? ` · ${x.segment}` : ''} · conf ${x.confidence}`, raw: x });
  }
  if (layer === 'all' || layer === 'approvals') {
    const conds = ["status = 'pending'"];
    const params: unknown[] = [];
    if (q) { conds.push('payload_json LIKE ?'); params.push(like); }
    if (sinceMs > 0) { conds.push('created_at >= ?'); params.push(sinceMs); }
    params.push(limit);
    const r = query<{ id: string; agent: string; kind: string; created_at: number; payload_json: string }>(
      `SELECT id, agent, kind, created_at, payload_json FROM approvals WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, params,
    );
    for (const x of r) rows.push({ layer: 'approvals', at: x.created_at, primary: `${x.kind} (${x.id.slice(0, 8)})`, secondary: `${x.agent} · pending decision`, raw: x });
  }

  // Merge + sort + cap.
  rows.sort((a, b) => b.at - a.at);
  const capped = rows.slice(0, limit);

  // Layer counts (over the unfiltered window) for the UI's filter chips.
  const counts = {
    notes: query<{ n: number }>(`SELECT COUNT(*) AS n FROM notes`)[0]?.n ?? 0,
    facts: query<{ n: number }>(`SELECT COUNT(*) AS n FROM facts`)[0]?.n ?? 0,
    wiki: query<{ n: number }>(`SELECT COUNT(*) AS n FROM wiki_pages`)[0]?.n ?? 0,
    register: query<{ n: number }>(`SELECT COUNT(*) AS n FROM register`)[0]?.n ?? 0,
    approvals_pending: query<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE status='pending'`)[0]?.n ?? 0,
  };

  return { rows: capped.map((r) => ({ ...r, at_iso: new Date(r.at).toISOString() })), counts };
});

// REST: per-module intent summaries from the knowledge graph
// (codebase-graph + intent-extractor agents). Returns the parsed
// "purpose" sentence — a short, hover-displayable string. Modules
// without an intent yet are simply absent from the response.
app.get('/api/code-intents', async () => {
  const rows = query<{ path: string; intent_summary: string | null }>(
    `SELECT path, intent_summary FROM code_files WHERE intent_summary IS NOT NULL`,
  );
  const intents: { path: string; summary: string }[] = [];
  for (const r of rows) {
    if (!r.intent_summary) continue;
    try {
      const j = JSON.parse(r.intent_summary) as { shape?: string; purpose?: string; deferred?: string };
      if (j.shape === 'A' && j.purpose) intents.push({ path: r.path, summary: j.purpose });
      else if (j.shape === 'B' && j.deferred) intents.push({ path: r.path, summary: `(deferred: ${j.deferred})` });
    } catch { /* malformed — skip */ }
  }
  return { intents };
});

app.get('/api/screenshots-meta', async () => {
  const dir = resolve(config.targetPath, config.screenshotsDir);
  const fs = await import('node:fs');
  if (!fs.existsSync(dir)) return { dir, present: [] };
  const VALID_EXT = /\.(png|jpe?g|webp)$/i;
  const BLANK_BYTES = 8 * 1024;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return { dir, present: [] }; }
  const grouped = new Map<string, { file: string; mtimeMs: number; size: number }>();
  for (const name of names) {
    if (!VALID_EXT.test(name)) continue;
    const stem = name.slice(0, name.lastIndexOf('.'));
    const m = stem.match(/^([A-Z][A-Za-z0-9]*Screen)\b/);
    if (!m) continue;
    const screenName = m[1]!;
    let stat;
    try { stat = fs.statSync(resolve(dir, name)); } catch { continue; }
    const cur = grouped.get(screenName);
    if (!cur || stat.mtimeMs > cur.mtimeMs) {
      grouped.set(screenName, { file: name, mtimeMs: stat.mtimeMs, size: stat.size });
    }
  }

  // Latest screen-validator verdict per screen. The validator emits one
  // finding per non-ok screen + a single summary every run. Treat any
  // per-screen finding OLDER than the most recent summary as resolved
  // (the validator re-judged + didn't re-emit it = ok now).
  const lastSummary = query<{ at: number }>(
    `SELECT at FROM findings WHERE agent = 'screen-validator' AND kind = 'capture:summary' ORDER BY at DESC LIMIT 1`,
  )[0];
  const summaryAt = lastSummary?.at ?? 0;
  const verdictRows = query<{ payload_json: string; at: number }>(
    `SELECT payload_json, at FROM findings
       WHERE agent = 'screen-validator'
         AND kind != 'capture:summary'
         AND payload_json LIKE '%"screen"%'
       ORDER BY at DESC`,
  );
  const latestByScreen = new Map<string, { verdict: string; confidence: number; at: number }>();
  for (const r of verdictRows) {
    if (r.at < summaryAt - 1000) break;               // older than current run = resolved
    let p: { screen?: string; verdict?: string; confidence?: number } = {};
    try { p = JSON.parse(r.payload_json); } catch { continue; }
    if (!p.screen || !p.verdict) continue;
    if (latestByScreen.has(p.screen)) continue;
    latestByScreen.set(p.screen, {
      verdict: p.verdict,
      confidence: typeof p.confidence === 'number' ? p.confidence : 1,
      at: r.at,
    });
  }

  const present = [...grouped.entries()].map(([screenName, m]) => {
    const v = latestByScreen.get(screenName);
    // If the file is fresher than the latest verdict, the validator hasn't
    // re-judged this capture yet → leave verdict undefined (UI shows "ok"
    // optimistically until the next validator pass).
    const verdictApplies = v && v.at >= m.mtimeMs - 1000;
    return {
      urn: `screen:${screenName}`,
      screenName,
      file: m.file,
      mtimeMs: Math.round(m.mtimeMs),
      sizeBytes: m.size,
      isBlank: m.size < BLANK_BYTES,
      ...(verdictApplies && v ? { verdict: v.verdict, confidence: v.confidence, verdictAt: v.at } : {}),
    };
  });
  return { dir: config.screenshotsDir, present };
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
      completeness: latestCompleteness(),
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
