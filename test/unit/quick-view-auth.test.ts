/**
 * Auth-guard tests for the quick-view browser image viewer (used by
 * `list -i` → `[P]`). Same Host + token guard pattern as the preview server,
 * verified the same way: mock the browser-opener spawn to capture the opened
 * URL (with `#<token>`), then hit the running server with fetch()/WebSocket.
 */

import { describe, expect, mock, test } from 'bun:test';

const capturedUrlBox: { value: string | null } = { value: null };

mock.module('node:child_process', () => ({
  spawn: (_cmd: string, args: string[]) => {
    capturedUrlBox.value = args[args.length - 1] ?? null;
    return { on: () => {}, unref: () => {} };
  },
}));

const { quickViewInBrowser } = await import('../../src/engine/preview/quick-view.ts');

async function startViewer() {
  capturedUrlBox.value = null;
  const donePromise = quickViewInBrowser({
    port: 0,
    imageBytes: Buffer.from('fake-image-bytes'),
    mimeType: 'image/jpeg',
    filename: 'test.jpg',
    wpId: 7,
  });

  for (let i = 0; i < 100 && !capturedUrlBox.value; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!capturedUrlBox.value) throw new Error('quick view did not open a browser URL in time');

  const [base, token] = (capturedUrlBox.value as string).split('#');
  const url = new URL(base);
  return { port: Number(url.port), token: token ?? '', donePromise };
}

// Every test must end by opening (and closing) a WS connection with the
// correct token — that's the only way this server shuts itself down; otherwise
// it lingers on its 5-minute no-connection timeout and leaks past the test.
async function shutdownViaWs(port: number, token: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
    ws.onerror = () => resolve();
    setTimeout(resolve, 2000);
  });
  ws.close();
  await new Promise((r) => setTimeout(r, 50));
}

describe('quick view auth', () => {
  test('GET / with correct Host succeeds; wrong Host 404s', async () => {
    const { port, token, donePromise } = await startViewer();
    const ok = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: `127.0.0.1:${port}` } });
    expect(ok.status).toBe(200);
    const bad = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: 'evil.example.com' } });
    expect(bad.status).toBe(404);
    await shutdownViaWs(port, token);
    await donePromise;
  });

  test('/image requires a matching token', async () => {
    const { port, token, donePromise } = await startViewer();
    const noToken = await fetch(`http://127.0.0.1:${port}/image`);
    expect(noToken.status).toBe(404);
    const wrongToken = await fetch(`http://127.0.0.1:${port}/image?token=wrong`);
    expect(wrongToken.status).toBe(404);
    const correct = await fetch(`http://127.0.0.1:${port}/image?token=${token}`);
    expect(correct.status).toBe(200);
    await shutdownViaWs(port, token);
    await donePromise;
  });

  test('WS upgrade without a token is refused; with a token is accepted', async () => {
    const { port, token, donePromise } = await startViewer();

    const bad = await fetch(`http://127.0.0.1:${port}/ws`, {
      headers: { upgrade: 'websocket', connection: 'upgrade' },
    });
    expect(bad.status).toBe(404);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 2000);
    });
    expect(opened).toBe(true);
    ws.close();
    await donePromise;
  });
});
