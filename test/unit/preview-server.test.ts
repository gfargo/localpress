/**
 * Integration tests for the preview server's security + lifecycle fixes:
 *   - #106: mutating endpoints require the session token; a forged Host is
 *     rejected (DNS-rebind guard).
 *   - #105: a successful apply resolves { applied: true } (previously the WS
 *     close race made every apply report applied:false).
 *
 * Runs a real Bun.serve on loopback. Requests use raw sockets with
 * `Connection: close` (Bun's fetch keep-alive pool reuses a socket the server
 * closes between requests, which is unrelated to what we're testing). The
 * browser open is a detached, unref'd spawn that no-ops (never throws) in CI.
 */

import { describe, expect, test } from 'bun:test';
import { connect } from 'node:net';
import {
  type ApplyResult,
  type ProcessResult,
  startPreviewServer,
} from '../../src/engine/preview/server.ts';

interface Harness {
  port: number;
  token: string;
  done: Promise<{ applied: boolean; result: ApplyResult | null }>;
}

// onReady fires synchronously during startPreviewServer() (before its first
// await), so we can capture the port/token in the same tick.
function launch(): Harness {
  let port = 0;
  let token = '';
  const done = startPreviewServer({
    sourceBytes: Buffer.from('source-image-bytes'),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    wpId: 42,
    mode: 'optimize',
    html: '<!DOCTYPE html><html><head></head><body>preview</body></html>',
    onProcess: async (): Promise<ProcessResult> => ({
      bytes: Buffer.from('processed-bytes'),
      mimeType: 'image/webp',
      stats: {},
    }),
    onApply: async (): Promise<ApplyResult> => ({ wpId: 42, message: 'applied' }),
    onReady: (info) => {
      port = info.port;
      token = info.token;
    },
  });
  if (!token) throw new Error('onReady did not fire synchronously');
  return { port, token, done };
}

interface RawResponse {
  status: number;
  body: string;
}

/** Send one raw HTTP/1.1 request over a fresh socket (Connection: close). */
function raw(
  port: number,
  method: string,
  path: string,
  opts: { host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const host = opts.host ?? `127.0.0.1:${port}`;
    const body = opts.body ?? '';
    const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: close'];
    for (const [k, v] of Object.entries(opts.headers ?? {})) lines.push(`${k}: ${v}`);
    if (body) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
    let data = '';
    sock.on('data', (d) => {
      data += d.toString();
    });
    sock.on('end', () => {
      const m = data.match(/^HTTP\/1\.1 (\d{3})/);
      const sep = data.indexOf('\r\n\r\n');
      resolve({ status: m ? Number(m[1]) : 0, body: sep >= 0 ? data.slice(sep + 4) : '' });
    });
    sock.on('error', reject);
  });
}

describe('preview server — auth (#106)', () => {
  test('rejects /api/apply without the session token', async () => {
    const h = launch();
    const res = await raw(h.port, 'POST', '/api/apply');
    expect(res.status).toBe(403);
    await raw(h.port, 'POST', '/api/cancel', { headers: { 'X-Preview-Token': h.token } });
    await h.done;
  });

  test('rejects a request with a foreign Host header (DNS-rebind guard)', async () => {
    const h = launch();
    // Matching loopback Host is accepted (serves the UI shell)...
    expect((await raw(h.port, 'GET', '/')).status).toBe(200);
    // ...a rebound attacker hostname is rejected before any handler runs.
    expect((await raw(h.port, 'GET', '/api/meta', { host: 'evil.example.com' })).status).toBe(403);
    await raw(h.port, 'POST', '/api/cancel', { headers: { 'X-Preview-Token': h.token } });
    await h.done;
  });

  test('injects the auth bootstrap into the served HTML', async () => {
    const h = launch();
    const res = await raw(h.port, 'GET', '/');
    expect(res.body).toContain('X-Preview-Token');
    await raw(h.port, 'POST', '/api/cancel', { headers: { 'X-Preview-Token': h.token } });
    await h.done;
  });
});

describe('preview server — apply resolves applied:true (#105)', () => {
  test('a token-authorized process→apply resolves { applied: true }', async () => {
    const h = launch();
    const auth = { 'X-Preview-Token': h.token };

    const proc = await raw(h.port, 'POST', '/api/process', {
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(proc.status).toBe(200);

    const apply = await raw(h.port, 'POST', '/api/apply', { headers: auth });
    expect(apply.status).toBe(200);

    const outcome = await h.done;
    expect(outcome.applied).toBe(true);
    expect(outcome.result?.wpId).toBe(42);
  });
});
