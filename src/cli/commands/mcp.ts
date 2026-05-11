/**
 * `localpress mcp` — boot the MCP server over stdio.
 *
 * Intended to be spawned by an MCP host (Claude Desktop, Cursor, Claude Code).
 * Talks JSON-RPC over stdin/stdout. Not designed for direct human invocation —
 * if you run this in a terminal, nothing visible happens until JSON-RPC bytes
 * arrive on stdin.
 *
 * See .wiki/MCP-Setup.md for host configuration examples.
 */

import type { Command } from 'commander';

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Run as an MCP (Model Context Protocol) server over stdio')
    .action(async () => {
      // Lazy-load the SDK — keeps CLI startup time unaffected when not running
      // as an MCP server.
      const { startMcpServer } = await import('../mcp/server.ts');
      await startMcpServer();
    });
}
