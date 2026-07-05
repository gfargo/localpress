/**
 * Regression tests for the preview server's promise-resolution race
 * (issue #105): a successful /api/apply must resolve `{applied: true}`
 * even though shutdown() synchronously fires the WS close handler, and a
 * reconnect within the grace window must not cancel the session.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setOutputOptions } from '../../src/cli/utils/output.ts';
import { startPreviewServer } from '../../src/engine/preview/server.ts';

setOutputOptions({ quiet: true });

// The server opens the default browser via `xdg-open`/`open`/`start`, which
// doesn't exist in a headless CI sandbox. Stub it on PATH so startPreviewServer
// doesn't throw before we get a chance to talk to it over HTTP/WS.
let fakeBinDir: string | null = null;
let originalPath: string | undefined;

beforeAll(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), 'localpress-fake-bin-'));
  const stubPath = join(fakeBinDir, 'xdg-open');
  writeFileSync(stubPath, '#!/bin/sh\nexit 0\n');
  chmodSync(stubPath, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
});

afterAll(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (fakeBinDir) rmSync(fakeBinDir, { recursive: true, force: true });
});

let nextPort = 19801;

function basePreviewOptions(port: number, overrides: Record<string, unknown> = {}) {
  return {
    port,
    sourceBytes: Buffer.from('source'),
    filename: 'test.png',
    mimeType: 'image/png',
    wpId: 1,
    mode: 'optimize' as const,
    html: '<html></html>',
    timeoutMs: 60_000,
    onProcess: async () => ({
      bytes: Buffer.from('result'),
      mimeType: 'image/png',
      stats: {},
    }),
    onApply: async () => ({ wpId: 42, message: 'uploaded' }),
    ...overrides,
  };
}

/** Resolves to a sentinel after `ms` if `promise` hasn't settled yet. */
async function notYetResolved(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const sentinel = Symbol('pending');
  const result = await Promise.race([
    promise,
    new Promise((r) => setTimeout(() => r(sentinel), ms)),
  ]);
  return result === sentinel;
}

describe('startPreviewServer', () => {
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  });

  test('apply followed by ws close resolves {applied: true}, not cancelled', async () => {
    const port = nextPort++;
    const donePromise = startPreviewServer(basePreviewOptions(port));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });

    await fetch(`http://127.0.0.1:${port}/api/process`, { method: 'POST', body: '{}' });
    await fetch(`http://127.0.0.1:${port}/api/apply`, { method: 'POST' });

    const result = await donePromise;
    expect(result.applied).toBe(true);
    expect(result.result?.wpId).toBe(42);
  });

  test('closing and reconnecting within the grace window does not cancel', async () => {
    const port = nextPort++;
    const donePromise = startPreviewServer(basePreviewOptions(port));

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws1);
    await new Promise((resolve) => {
      ws1.onopen = resolve;
    });
    ws1.close();

    // Reconnect quickly, well within the ~2.5s grace window.
    await new Promise((r) => setTimeout(r, 300));
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws2);
    await new Promise((resolve) => {
      ws2.onopen = resolve;
    });

    // Give the (cancelled) grace timer a chance to fire if it weren't cleared.
    expect(await notYetResolved(donePromise, 2800)).toBe(true);

    // Clean up: close the live socket with no reconnect so the server shuts
    // itself down naturally via the grace-period path (avoids the server's
    // force-close-before-response quirk on /api/cancel, unrelated to this test).
    ws2.close();
    const result = await donePromise;
    expect(result.applied).toBe(false);
  }, 10_000);

  test('closing with no reconnect resolves {applied: false} after the grace period', async () => {
    const port = nextPort++;
    const donePromise = startPreviewServer(basePreviewOptions(port));

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    await new Promise((resolve) => {
      ws.onopen = resolve;
    });
    ws.close();

    const result = await donePromise;
    expect(result.applied).toBe(false);
    expect(result.result).toBeNull();
  }, 10_000);
});
