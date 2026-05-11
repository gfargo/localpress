/**
 * Boot the localpress MCP server over stdio.
 *
 * Spawned as a long-lived child process by an MCP host (Claude Desktop,
 * Cursor, Claude Code, etc.). Talks JSON-RPC over stdin/stdout.
 *
 * Implementation: each registered tool dispatches by spawning the same
 * localpress binary recursively with `--json --quiet` (see invoke.ts).
 * This reuses the CLI's stable JSON contract and means every CLI feature
 * appears in the MCP server for free.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import packageJson from '../../../package.json' with { type: 'json' };
import { registerResources } from './resources.ts';
import { registerTools } from './tools.ts';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer(
    {
      name: 'localpress',
      version: packageJson.version,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
      instructions:
        "localpress is a CLI for local-compute WordPress media optimization. Tools call the local CLI, which talks to the user's configured WordPress site via REST + Application Passwords (and optionally WP-CLI over SSH). Every tool accepts an optional `site` arg; when omitted, the active site from config is used. Bulk ops (list+optimize/convert/resize/caption with --unoptimized or --all) are dry-run by default — pass `apply: true` to execute.",
    },
  );

  registerTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The connect() call returns once the transport is wired up. The process
  // stays alive because stdin is open. When the host closes stdin, the
  // transport closes and Node exits naturally.
}
