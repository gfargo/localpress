/**
 * Local preview server for visual processing feedback.
 *
 * Spins up a temporary Bun HTTP server that serves a web UI where users
 * can adjust processing parameters, see before/after previews, and commit
 * the result back to WordPress — all from the browser.
 *
 * The server is ephemeral: it starts when the user passes `--preview`,
 * opens the browser automatically, and shuts down after the user applies
 * or cancels (or after a timeout).
 *
 * Architecture:
 *   - GET /           → serves the single-page HTML UI
 *   - GET /api/source → returns the original image bytes
 *   - POST /api/process → runs the engine with the given params, returns result
 *   - POST /api/apply  → commits the last result to WordPress and shuts down
 *   - POST /api/cancel → shuts down without committing
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { info, warn } from '../../cli/utils/output.ts';
import { isAuthorized, isValidHost } from './token-auth.ts';

export interface PreviewServerOptions {
  /** Port to listen on. 0 = auto-assign. */
  port?: number;
  /** The original image bytes to preview. */
  sourceBytes: Buffer;
  /** Original filename (for display). */
  filename: string;
  /** Original MIME type. */
  mimeType: string;
  /** Image dimensions. */
  width?: number;
  height?: number;
  /** WordPress attachment ID. */
  wpId: number;
  /** The mode determines which UI controls to show. */
  mode: 'remove-bg' | 'optimize' | 'convert' | 'resize';
  /** Called when the user clicks "Process" with the given params. Returns result bytes. */
  onProcess: (params: Record<string, unknown>) => Promise<ProcessResult>;
  /** Called when the user clicks "Apply" to commit the result. */
  onApply: (resultBytes: Buffer, resultMimeType: string | null) => Promise<ApplyResult>;
  /** Auto-shutdown timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
  /** HTML content for the UI page. */
  html: string;
  /** Extra metadata to include in the /api/meta response (e.g. profiles). */
  extraMeta?: Record<string, unknown>;
}

export interface ProcessResult {
  bytes: Buffer;
  mimeType: string;
  stats: Record<string, unknown>;
}

export interface ApplyResult {
  wpId: number;
  message: string;
  /** Fresh metadata from WordPress after the upload — for UI display. */
  freshItem?: {
    filename: string;
    mimeType: string;
    sizeBytes?: number;
    width?: number;
    height?: number;
    url: string;
  };
}

/** Grace period after a WS close to allow a reload (or tab-switch) to reconnect. */
const CLOSE_GRACE_MS = 2500;

/**
 * Start the preview server and open the browser.
 * Returns a promise that resolves when the user applies or cancels.
 */
export async function startPreviewServer(
  options: PreviewServerOptions,
): Promise<{ applied: boolean; result: ApplyResult | null }> {
  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const token = randomUUID();

  // Mutable state shared between the fetch handler and lifecycle management.
  const state: {
    lastResultBytes: Buffer | null;
    lastResultMimeType: string | null;
    timeoutId: ReturnType<typeof setTimeout> | null;
    server: ReturnType<typeof Bun.serve> | null;
    wsConnected: boolean;
    wsHeartbeatId: ReturnType<typeof setInterval> | null;
    closeGraceId: ReturnType<typeof setTimeout> | null;
  } = {
    lastResultBytes: null,
    lastResultMimeType: null,
    timeoutId: null,
    server: null,
    wsConnected: false,
    wsHeartbeatId: null,
    closeGraceId: null,
  };

  let resolved = false;
  let resolvePromise: (value: { applied: boolean; result: ApplyResult | null }) => void;
  const done = new Promise<{ applied: boolean; result: ApplyResult | null }>((resolve) => {
    resolvePromise = resolve;
  });
  const resolveOnce = (value: { applied: boolean; result: ApplyResult | null }) => {
    if (resolved) return;
    resolved = true;
    resolvePromise(value);
  };

  const shutdown = () => {
    if (state.timeoutId) clearTimeout(state.timeoutId);
    if (state.wsHeartbeatId) clearInterval(state.wsHeartbeatId);
    if (state.closeGraceId) clearTimeout(state.closeGraceId);
    state.server?.stop(true);
  };

  const resetIdleTimeout = () => {
    if (state.timeoutId) clearTimeout(state.timeoutId);
    state.timeoutId = setTimeout(() => {
      warn('Preview server timed out. Shutting down.');
      // Resolve before shutting down — shutdown() triggers the WS close handler
      // synchronously (see the apply path below), and close() checks `resolved`
      // to decide whether to arm the reconnect grace timer.
      resolveOnce({ applied: false, result: null });
      shutdown();
    }, timeoutMs);
  };

  state.server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    // The apply endpoint can take 30+ seconds (SCP upload + wp media regenerate over SSH).
    // Bun's default idleTimeout is 10s which kills the connection mid-operation.
    idleTimeout: 120,
    fetch: async (req, server) => {
      const url = new URL(req.url);

      // Kill DNS rebinding: every request, token-gated or not, must target this
      // server's own host:port.
      if (!isValidHost(req, server.port)) {
        return new Response('Not Found', { status: 404 });
      }

      // Serve the UI unauthenticated — the token lives in the URL fragment,
      // which browsers never send to the server, so there's nothing to check here.
      if (url.pathname === '/' && req.method === 'GET') {
        return new Response(options.html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // Every other route is state-changing or returns private data — require the
      // session token. Same generic 404 for bad host/token/path so an attacker can't
      // distinguish which check failed.
      if (!isAuthorized(req, url, server.port, token)) {
        return new Response('Not Found', { status: 404 });
      }

      // Any authorized API activity keeps the session alive.
      if (url.pathname.startsWith('/api/')) {
        resetIdleTimeout();
      }

      // WebSocket upgrade for heartbeat.
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, { data: {} });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Serve the original image.
      if (url.pathname === '/api/source' && req.method === 'GET') {
        return new Response(options.sourceBytes, {
          headers: {
            'Content-Type': options.mimeType,
            'Content-Length': String(options.sourceBytes.length),
          },
        });
      }

      // Serve the last processed result (for the UI to fetch after processing).
      if (url.pathname === '/api/result' && req.method === 'GET') {
        if (!state.lastResultBytes) {
          return new Response(JSON.stringify({ error: 'No result yet' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(state.lastResultBytes, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': String(state.lastResultBytes.length),
          },
        });
      }

      // Process with given parameters.
      if (url.pathname === '/api/process' && req.method === 'POST') {
        try {
          const params = (await req.json()) as Record<string, unknown>;
          const result = await options.onProcess(params);
          state.lastResultBytes = result.bytes;
          state.lastResultMimeType = result.mimeType;
          return new Response(
            JSON.stringify({
              stats: result.stats,
              sizeBytes: result.bytes.length,
              mimeType: result.mimeType,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Apply the result to WordPress.
      if (url.pathname === '/api/apply' && req.method === 'POST') {
        if (!state.lastResultBytes) {
          return new Response(JSON.stringify({ error: 'No result to apply' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        try {
          info('  Applying optimized image to WordPress...');
          const result = await options.onApply(state.lastResultBytes, state.lastResultMimeType);
          info(`  ✓ Applied successfully (${result.message})`);
          // Delay shutdown to ensure the response is fully sent to the browser
          // before the server closes the TCP connection. Resolve before shutting
          // down — shutdown() triggers the WS close handler synchronously, which
          // would otherwise resolve `{applied: false}` first.
          setTimeout(() => {
            resolveOnce({ applied: true, result });
            shutdown();
          }, 500);
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          warn(`  Apply failed: ${message}`);
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }

      // Cancel and shut down.
      if (url.pathname === '/api/cancel' && req.method === 'POST') {
        resolveOnce({ applied: false, result: null });
        shutdown();
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Metadata endpoint for the UI to bootstrap itself.
      if (url.pathname === '/api/meta' && req.method === 'GET') {
        return new Response(
          JSON.stringify({
            mode: options.mode,
            filename: options.filename,
            mimeType: options.mimeType,
            width: options.width,
            height: options.height,
            sizeBytes: options.sourceBytes.length,
            wpId: options.wpId,
            ...(options.extraMeta ?? {}),
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open() {
        state.wsConnected = true;
        if (state.closeGraceId) {
          clearTimeout(state.closeGraceId);
          state.closeGraceId = null;
        }
        resetIdleTimeout();
      },
      message() {
        // Heartbeat pong — client is alive.
        resetIdleTimeout();
      },
      close() {
        state.wsConnected = false;
        // A deliberate shutdown (apply/cancel/timeout) resolves the promise
        // before calling shutdown(), which stops the server and triggers this
        // handler synchronously. Don't treat that as a "tab closed" event —
        // only arm the grace timer for a close we didn't initiate ourselves.
        if (resolved) return;
        // Don't shut down immediately: a page reload (or a brief tab switch)
        // closes the socket and reopens a new one moments later. Give it a
        // grace window before treating this as a real "tab closed".
        if (state.closeGraceId) clearTimeout(state.closeGraceId);
        state.closeGraceId = setTimeout(() => {
          state.closeGraceId = null;
          if (state.wsConnected) return;
          info('  Browser tab closed. Shutting down preview server.');
          shutdown();
          resolveOnce({ applied: false, result: null });
        }, CLOSE_GRACE_MS);
      },
    },
  });

  const actualPort = state.server.port;
  const previewUrl = `http://127.0.0.1:${actualPort}`;

  info(`  Preview server running at ${previewUrl}`);
  info('  Opening browser...');

  openBrowser(`${previewUrl}#${token}`);

  // Auto-shutdown timeout.
  resetIdleTimeout();

  return done;
}

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  // Without this, a missing browser-opener binary (e.g. no xdg-open in a
  // headless/CI environment) surfaces as an unhandled 'error' event and
  // crashes the process.
  child.on('error', () => {});
  child.unref();
}
