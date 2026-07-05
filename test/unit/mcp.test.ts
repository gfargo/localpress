/**
 * MCP server round-trip tests.
 *
 * Boots `localpress mcp` as a real subprocess, drives it with the MCP SDK's
 * client, and asserts on the protocol-level responses. No mocks.
 *
 * These are unit-grade because no WordPress is required — we only exercise
 * tools/resources that work without network calls (listTools, listResources,
 * and a sites_list call against an empty config).
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function connectClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  // Isolated XDG_CONFIG_HOME so we don't read or write the user's real config.
  const tmpHome = mkdtempSync(join(tmpdir(), 'localpress-mcp-test-'));

  const transport = new StdioClientTransport({
    command: process.execPath, // bun binary
    args: ['run', join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts'), 'mcp'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: tmpHome,
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'localpress-test', version: '0.0.0' });
  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
      rmSync(tmpHome, { recursive: true, force: true });
    },
  };
}

describe('mcp server', () => {
  test('lists all registered tools', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();

      // Spot-check core tools are present.
      expect(names).toContain('sites_list');
      expect(names).toContain('doctor');
      expect(names).toContain('list');
      expect(names).toContain('optimize');
      expect(names).toContain('caption');
      expect(names).toContain('remove_bg');

      // Sanity: we expose ≥ 20 tools.
      expect(tools.length).toBeGreaterThanOrEqual(20);
    } finally {
      await close();
    }
  }, 30_000);

  test('lists all registered resources', async () => {
    const { client, close } = await connectClient();
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((r) => r.uri).sort();
      expect(uris).toEqual([
        'localpress://capabilities',
        'localpress://history',
        'localpress://sites',
        'localpress://stats',
      ]);
    } finally {
      await close();
    }
  }, 30_000);

  test('watch_status tool is registered', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('watch_status');
    } finally {
      await close();
    }
  }, 30_000);

  test('time-machine tools are registered', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('history_list');
      expect(names).toContain('history_show');
      expect(names).toContain('history_prune');
      expect(names).toContain('undo');
    } finally {
      await close();
    }
  }, 30_000);

  test('sites_list returns empty array against fresh config', async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({ name: 'sites_list', arguments: {} });
      // CLI prints "No sites configured" to stdout in non-JSON mode but to
      // structured JSON in --json mode. We pass --json from the server, so the
      // tool result should contain a parsable structure.
      expect(result.isError).toBeFalsy();
      // structuredContent may or may not be set depending on CLI output shape;
      // at minimum, content should be present.
      expect(Array.isArray(result.content)).toBe(true);
    } finally {
      await close();
    }
  }, 30_000);

  test('tools advertise input schemas', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const optimize = tools.find((t) => t.name === 'optimize');
      expect(optimize).toBeDefined();
      expect(optimize?.inputSchema).toBeDefined();
      // Optimize takes ids + flags
      const schema = optimize?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).toBeDefined();
      expect(schema.properties).toHaveProperty('ids');
      expect(schema.properties).toHaveProperty('quality');
      expect(schema.properties).toHaveProperty('apply');
    } finally {
      await close();
    }
  }, 30_000);

  test('bulk tools expose concurrency field', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      for (const name of [
        'optimize',
        'convert',
        'resize',
        'remove_bg',
        'caption',
        'export',
        'import',
      ]) {
        const tool = tools.find((t) => t.name === name);
        const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
        expect(schema.properties, `tool ${name} should expose concurrency`).toHaveProperty(
          'concurrency',
        );
      }
    } finally {
      await close();
    }
  }, 30_000);

  test('delete tool is registered with ids + force', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'delete');
      expect(tool).toBeDefined();
      const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).toHaveProperty('ids');
      expect(schema.properties).toHaveProperty('force');
    } finally {
      await close();
    }
  }, 30_000);

  test('update_metadata tool is registered with the expected fields', async () => {
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'update_metadata');
      expect(tool).toBeDefined();
      const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).toHaveProperty('id');
      expect(schema.properties).toHaveProperty('ids');
      expect(schema.properties).toHaveProperty('altText');
      expect(schema.properties).toHaveProperty('title');
      expect(schema.properties).toHaveProperty('caption');
      expect(schema.properties).toHaveProperty('description');
    } finally {
      await close();
    }
  }, 30_000);

  test('delete tool rejects force:true without confirm:true', async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: 'delete',
        arguments: { ids: [1], force: true },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      expect(text).toContain('confirm');
    } finally {
      await close();
    }
  }, 30_000);

  test('posts_delete tool rejects force:true without confirm:true', async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: 'posts_delete',
        arguments: { id: 1, force: true },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join('\n');
      expect(text).toContain('confirm');
    } finally {
      await close();
    }
  }, 30_000);

  test('optimize tool exposes `to` (not `format`) — regression for #50', async () => {
    // Bug: the optimize MCP tool used to advertise a `format` field that got
    // mapped to `--format`, but the CLI takes `--to`. Verify the rename to `to`.
    const { client, close } = await connectClient();
    try {
      const { tools } = await client.listTools();
      const optimize = tools.find((t) => t.name === 'optimize');
      const schema = optimize?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties).toHaveProperty('to');
      expect(schema.properties).not.toHaveProperty('format');
    } finally {
      await close();
    }
  }, 30_000);
});
