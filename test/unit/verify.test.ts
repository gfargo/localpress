/**
 * Unit tests for the `localpress verify` command registration and the
 * `verify --hash` file-comparison helper.
 *
 * Includes a regression test for #195: `verify` was registered with a
 * required `<ids...>` positional, which made commander reject `verify --all`
 * before the action ever ran. Locks in the fix (`[ids...]`, optional).
 *
 * Also covers OSS-902: the remote file fetch must send auth headers, and any
 * failure to actually perform the comparison must be reported as
 * `verified: false` (never silently treated as a match).
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { registerVerifyCommand, verifyRemoteHash } from '../../src/cli/commands/verify.ts';

const AUTH_HEADER = 'Basic dXNlcjpwYXNz';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('verify command registration', () => {
  test('verify command is registered in the CLI', async () => {
    const mod = await import('../../src/cli/commands/verify.ts');
    expect(mod.registerVerifyCommand).toBeFunction();
  });

  test('the ids positional is optional, so --all is reachable', () => {
    const program = new Command();
    registerVerifyCommand(program);

    const verify = program.commands.find((cmd) => cmd.name() === 'verify');
    expect(verify).toBeDefined();
    expect(verify?.registeredArguments).toHaveLength(1);
    expect(verify?.registeredArguments[0]?.required).toBe(false);
  });
});

describe('verifyRemoteHash', () => {
  test('matching bytes: verified true, mismatch false', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const localHash = sha256(bytes);

    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash,
      fetchImpl,
    });

    expect(result.verified).toBe(true);
    expect(result.mismatch).toBe(false);
  });

  test('differing bytes: verified true, mismatch true', async () => {
    const remoteBytes = new TextEncoder().encode('different content');
    const localHash = sha256(new TextEncoder().encode('hello world'));

    const fetchImpl = (async () =>
      new Response(remoteBytes, { status: 200 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash,
      fetchImpl,
    });

    expect(result.verified).toBe(true);
    expect(result.mismatch).toBe(true);
  });

  test('401/403 response: verified false with a reason, not a silent ok', async () => {
    const fetchImpl = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: 'deadbeef',
      fetchImpl,
    });

    expect(result.verified).toBe(false);
    expect(result.mismatch).toBe(false);
    expect(result.reason).toContain('401');
  });

  test('fetch throws: verified false with a reason', async () => {
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: 'deadbeef',
      fetchImpl,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('network unreachable');
  });

  test('sends the Authorization header on the outgoing request', async () => {
    let capturedHeaders: Headers | undefined;

    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Uint8Array(), { status: 200 });
    }) as unknown as typeof fetch;

    await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: sha256(new Uint8Array()),
      fetchImpl,
    });

    expect(capturedHeaders?.get('Authorization')).toBe(AUTH_HEADER);
  });
});
