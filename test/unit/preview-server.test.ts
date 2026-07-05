/**
 * Integration-style unit tests for the preview server's auth guard.
 * Spins up a real `startPreviewServer` instance with stubbed onProcess/onApply
 * callbacks and hits it with `fetch()` to confirm the token/Host checks are wired
 * in correctly — in particular that `/api/apply` never reaches the WordPress-mutating
 * callback without a valid token.
 *
 * `node:child_process` is mocked so no real browser-opener process is spawned;
 * instead we capture the URL (with the `#<token>` fragment) that the server
 * would have opened, so tests can address it directly.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';

const capturedUrlBox: { value: string | null } = { value: null };

mock.module('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    capturedUrlBox.value = args[args.length - 1] ?? null;
    return { on: () => {}, unref: () => {} };
  },
}));

const { startPreviewServer } = await import('../../src/engine/preview/server.ts');

async function startServer(
  onApply: (bytes: Buffer, mime: string | null) => Promise<{ wpId: number; message: string }>,
) {
  capturedUrlBox.value = null;
  let applyCalls = 0;

  const donePromise = startPreviewServer({
    port: 0,
    sourceBytes: Buffer.from('fake-image-bytes'),
    filename: 'test.jpg',
    mimeType: 'image/jpeg',
    wpId: 42,
    mode: 'optimize',
    html: '<html><body>preview</body></html>',
    timeoutMs: 60_000,
    onProcess: async () => ({
      bytes: Buffer.from('processed'),
      mimeType: 'image/webp',
      stats: {},
    }),
    onApply: async (bytes, mime) => {
      applyCalls++;
      return onApply(bytes, mime);
    },
  });

  for (let i = 0; i < 100 && !capturedUrlBox.value; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!capturedUrlBox.value) throw new Error('server did not open a browser URL in time');

  const [base, token] = (capturedUrlBox.value as string).split('#');
  const url = new URL(base);

  return {
    port: Number(url.port),
    token: token ?? '',
    donePromise,
    getApplyCalls: () => applyCalls,
  };
}

describe('preview server auth', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  test('GET / with correct Host succeeds; wrong Host 404s', async () => {
    const { port, token, donePromise } = await startServer(async () => ({
      wpId: 1,
      message: 'ok',
    }));
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${port}/api/cancel`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token },
      }).catch(() => {});
      await donePromise;
    });

    const ok = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: `127.0.0.1:${port}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { host: 'evil.example.com' },
    });
    expect(bad.status).toBe(404);
  });

  test('/api/source requires a matching token', async () => {
    const { port, token, donePromise } = await startServer(async () => ({
      wpId: 1,
      message: 'ok',
    }));
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${port}/api/cancel`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token },
      }).catch(() => {});
      await donePromise;
    });

    const noToken = await fetch(`http://127.0.0.1:${port}/api/source`);
    expect(noToken.status).toBe(404);

    const wrongToken = await fetch(`http://127.0.0.1:${port}/api/source?token=wrong`);
    expect(wrongToken.status).toBe(404);

    const correct = await fetch(`http://127.0.0.1:${port}/api/source?token=${token}`);
    expect(correct.status).toBe(200);
  });

  test('POST /api/apply without a token never reaches the onApply callback', async () => {
    const { port, token, getApplyCalls, donePromise } = await startServer(async () => ({
      wpId: 99,
      message: 'applied',
    }));
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${port}/api/cancel`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token },
      }).catch(() => {});
      await donePromise;
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/apply`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(getApplyCalls()).toBe(0);
  });

  test('POST /api/apply with the correct token reaches onApply and resolves', async () => {
    const { port, token, getApplyCalls, donePromise } = await startServer(async () => ({
      wpId: 99,
      message: 'applied',
    }));

    // /api/apply requires a primed result — generate one via /api/process first.
    await fetch(`http://127.0.0.1:${port}/api/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Preview-Token': token },
      body: JSON.stringify({}),
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/apply`, {
      method: 'POST',
      headers: { 'X-Preview-Token': token },
    });
    expect(res.status).toBe(200);
    expect(getApplyCalls()).toBe(1);

    const result = await donePromise;
    expect(result.applied).toBe(true);
  });

  test('WS upgrade to /ws without a token is refused', async () => {
    const { port, token, donePromise } = await startServer(async () => ({
      wpId: 1,
      message: 'ok',
    }));
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${port}/api/cancel`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token },
      }).catch(() => {});
      await donePromise;
    });

    const res = await fetch(`http://127.0.0.1:${port}/ws`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(res.status).toBe(404);
  });

  test('WS upgrade to /ws with the correct token is accepted', async () => {
    const { port, token, donePromise } = await startServer(async () => ({
      wpId: 1,
      message: 'ok',
    }));
    cleanups.push(async () => {
      await fetch(`http://127.0.0.1:${port}/api/cancel`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token },
      }).catch(() => {});
      await donePromise;
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);
    ws.close();
  });
});
