/* MCP server — dev-infra's per-project memory exposed as MCP tools.
 *
 * Run via stdio so any Claude Code session (or other MCP client) in
 * the user's repo can query the live knowledge graph + concerns +
 * resolutions + findings of THAT project.
 *
 * Environment:
 *   DEVINFRA_TARGET_ID  — picks data/<id>/memory.db (multi-target #4).
 *                         Default 'default' uses data/memory.db.
 *
 * Install in ~/.claude.json mcpServers:
 *   "myapp-memory": {
 *     "command": "npx",
 *     "args": ["tsx", "/abs/path/nik-dev-infra/src/server/mcp-server/server.ts"],
 *     "env": { "DEVINFRA_TARGET_ID": "myapp" }
 *   }
 *
 * Hard-path: every read goes through the same memory.ts helpers the
 * daemon uses, so consistency is a single-source-of-truth invariant.
 * Writes go through the same helpers + log to console.error so the
 * client can see what landed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { codeTools, callCodeTool } from './tools/code.ts';
import { generalTools, callGeneralTool } from './tools/general.ts';

const targetId = process.env.DEVINFRA_TARGET_ID ?? 'default';

const server = new Server(
  {
    name: `dev-infra-memory:${targetId}`,
    version: '0.1.0',
  },
  {
    capabilities: { tools: {} },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...codeTools, ...generalTools],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name.startsWith('memory.code.')) {
      return await callCodeTool(name, args ?? {});
    }
    if (name.startsWith('memory.')) {
      return await callGeneralTool(name, args ?? {});
    }
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${name} failed: ${(e as Error).message}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
// Stderr is the MCP-safe log channel (stdout is reserved for the protocol).
console.error(`[mcp] dev-infra memory server ready · target=${targetId}`);
