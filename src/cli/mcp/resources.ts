/**
 * MCP resources for localpress.
 *
 * Resources surface read-only context an agent might want to load proactively,
 * without having to call a tool. Three resources today:
 *
 *   localpress://sites         — configured sites + active site marker
 *   localpress://stats         — cumulative processing stats for the active site
 *   localpress://capabilities  — backend capability matrix for the active site
 *
 * All three dispatch through the CLI's --json contract via invokeCli().
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { invokeCli } from './invoke.ts';

async function readAsResource(uri: URL, args: string[]) {
  const result = await invokeCli({ args });
  const body =
    typeof result.stdout === 'string' ? result.stdout : JSON.stringify(result.stdout, null, 2);
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: result.ok ? body : `Error (exit ${result.exitCode}):\n${result.stderr}\n\n${body}`,
      },
    ],
  };
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    'sites',
    'localpress://sites',
    {
      title: 'Configured sites',
      description: 'All WordPress sites configured for localpress, with the active site marked.',
      mimeType: 'application/json',
    },
    async (uri) => readAsResource(uri, ['sites']),
  );

  server.registerResource(
    'stats',
    'localpress://stats',
    {
      title: 'Active site stats',
      description: 'Cumulative processing stats and library health for the active site.',
      mimeType: 'application/json',
    },
    async (uri) => readAsResource(uri, ['stats']),
  );

  server.registerResource(
    'capabilities',
    'localpress://capabilities',
    {
      title: 'Backend capabilities',
      description:
        'Capability matrix for the active site: which adapters are available, what each can do.',
      mimeType: 'application/json',
    },
    async (uri) => readAsResource(uri, ['doctor']),
  );

  server.registerResource(
    'history',
    'localpress://history',
    {
      title: 'Time-machine history',
      description:
        'Recent sessions and snapshots for the active site — what can be undone, retention status, storage used.',
      mimeType: 'application/json',
    },
    async (uri) => readAsResource(uri, ['history']),
  );
}
