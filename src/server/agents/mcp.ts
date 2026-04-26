/* MCP discovery agent — deterministic.
 *
 * For every configured MCP server, the agent POSTs a JSON-RPC
 * `tools/list` request and ingests the returned tool catalog into
 * the memory layer. Each tool becomes:
 *
 *   - a register entity at urn `mcp_tool:<server>/<tool>` with kind
 *     'mcp_tool', the description as label, evidence pointing at the
 *     server URL.
 *   - a fact triple `mcp_tool:<server>/<tool>` `tool_of` `mcp_server:<name>`.
 *
 * Diff with the prior run (via the register) → on transitions the
 * agent emits `mcp:tool-added` or `mcp:tool-removed`. Server
 * unreachability surfaces as `mcp:server-down` (one finding per
 * server, not per probe — to avoid flooding).
 *
 * Hard-path: tools are written at confidence 1.0 only. If the JSON-
 * RPC reply is malformed or the response status indicates a
 * non-200 / non-JSON shape, the server is treated as down for this
 * run; nothing is registered for that server.
 *
 * Configuration: `mcpServers: [{ name, url, headers? }]` in
 * dev-infra.config.json. Default is empty — agent emits a one-time
 * `mcp:not-configured` info finding and stays quiet otherwise.
 */

import { config } from '../config.ts';
import { newId } from '../findings.ts';
import { addFact, entities, registerEntity } from '../memory.ts';
import type { Agent, Finding } from '../types.ts';

const FETCH_TIMEOUT_MS = 8_000;

type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

const downSince = new Map<string, number>();
let configHintEmitted = false;

async function listTools(server: { name: string; url: string; headers?: Record<string, string> }): Promise<{ ok: true; tools: ToolDescriptor[] } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(server.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...(server.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const json = (await r.json()) as { result?: { tools?: ToolDescriptor[] }; error?: { message?: string } };
    if (json.error) return { ok: false, error: json.error.message ?? 'jsonrpc error' };
    const tools = json.result?.tools;
    if (!Array.isArray(tools)) return { ok: false, error: 'response missing result.tools array' };
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'fetch failed' };
  } finally {
    clearTimeout(timer);
  }
}

export const mcpAgent: Agent = {
  name: 'mcp',
  description: 'Introspects configured MCP servers; registers each tool as an entity; tracks tool-added/removed transitions.',
  routedFiles: [],
  // Not too aggressive — MCP server lists rarely change. Five-min cadence
  // is a good balance against flooding; the keeper agent handles cleanup.
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    if (config.mcpServers.length === 0) {
      if (configHintEmitted) return [];
      configHintEmitted = true;
      return [{
        id: newId(),
        agent: 'mcp',
        kind: 'mcp:not-configured',
        at: Date.now(),
        severity: 'info',
        summary: 'no MCP servers configured — set mcpServers[] in dev-infra.config.json to enable tool discovery',
      }];
    }

    const findings: Finding[] = [];

    for (const server of config.mcpServers) {
      const serverUrn = `mcp_server:${server.name}`;
      registerEntity({
        urn: serverUrn,
        kind: 'mcp_server',
        label: server.name,
        evidence: [server.url],
        agent: 'mcp',
      });

      // Snapshot prior tool URNs for this server, to compute the diff.
      const priorTools = entities({ kind: 'mcp_tool' })
        .filter((e) => e.urn.startsWith(`mcp_tool:${server.name}/`))
        .map((e) => e.urn);
      const priorSet = new Set(priorTools);

      const r = await listTools(server);
      if (!r.ok) {
        const downAt = downSince.get(server.name);
        if (!downAt) {
          downSince.set(server.name, Date.now());
          findings.push({
            id: newId(),
            agent: 'mcp',
            kind: 'mcp:server-down',
            at: Date.now(),
            severity: 'error',
            summary: `MCP server "${server.name}" unreachable — ${r.error}`,
            payload: { server: server.name, url: server.url, error: r.error },
          });
        }
        continue;
      }
      if (downSince.delete(server.name)) {
        findings.push({
          id: newId(),
          agent: 'mcp',
          kind: 'mcp:server-recovered',
          at: Date.now(),
          severity: 'info',
          summary: `MCP server "${server.name}" recovered`,
          payload: { server: server.name },
        });
      }

      const seenUrns = new Set<string>();
      for (const tool of r.tools) {
        if (typeof tool?.name !== 'string' || !tool.name) continue;
        const urn = `mcp_tool:${server.name}/${tool.name}`;
        seenUrns.add(urn);
        registerEntity({
          urn,
          kind: 'mcp_tool',
          label: tool.description?.slice(0, 80) ?? tool.name,
          evidence: [server.url],
          agent: 'mcp',
        });
        addFact({
          agent: 'mcp',
          subject: urn,
          predicate: 'tool_of',
          object: serverUrn,
          evidence: [server.url],
        });
        if (!priorSet.has(urn)) {
          findings.push({
            id: newId(),
            agent: 'mcp',
            kind: 'mcp:tool-added',
            at: Date.now(),
            severity: 'info',
            summary: `MCP server "${server.name}" added tool "${tool.name}" — ${tool.description?.slice(0, 100) ?? '(no description)'}`,
            payload: { server: server.name, tool: tool.name, description: tool.description ?? null },
          });
        }
      }

      // Diff: tools that were present before but absent now → removed.
      for (const urn of priorSet) {
        if (!seenUrns.has(urn)) {
          findings.push({
            id: newId(),
            agent: 'mcp',
            kind: 'mcp:tool-removed',
            at: Date.now(),
            severity: 'warn',
            summary: `MCP server "${server.name}" no longer exposes ${urn.replace(`mcp_tool:${server.name}/`, '')}`,
            payload: { server: server.name, urn },
          });
        }
      }
    }

    // Run summary at the end for visibility.
    const total = entities({ kind: 'mcp_tool' }).length;
    findings.push({
      id: newId(),
      agent: 'mcp',
      kind: 'mcp:summary',
      at: Date.now(),
      severity: 'info',
      summary: `MCP discovery: ${total} tool${total === 1 ? '' : 's'} across ${config.mcpServers.length} server${config.mcpServers.length === 1 ? '' : 's'}`,
      payload: { tools: total, servers: config.mcpServers.length },
    });

    return findings;
  },
};
