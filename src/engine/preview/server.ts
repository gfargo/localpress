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

/**
 * Client-side bootstrap injected into every served page. It reads the session
 * token from the URL fragment (never sent to the server or logged) and attaches
 * it to every same-origin `fetch` and WebSocket, so the real UI is authorized
 * without editing any of the UI code — while a cross-origin page (which can't
 * read our fragment) cannot forge an authorized mutation.
 */
function authBootstrap(): string {
  return `<script>(function(){
  var t=(location.hash.match(/token=([A-Za-z0-9-]+)/)||[])[1]||'';
  var of=window.fetch;
  window.fetch=function(i,init){init=init||{};var h=new Headers(init.headers||{});h.set('X-Preview-Token',t);init.headers=h;return of(i,init);};
  var OW=window.WebSocket;
  function PW(u,p){var s=u.indexOf('?')<0?'?':'&';return new OW(u+s+'token='+encodeURIComponent(t),p);}
  PW.prototype=OW.prototype;window.WebSocket=PW;
})();</script>`;
}

/** Image endpoints loaded via <img src> can't carry a custom header, so they
 * are token-exempt (still protected by the Host check + absence of CORS). */
function isTokenExempt(method: string, pathname: string): boolean {
  return method === 'GET' && (pathname === '/api/source' || pathname === '/api/result');
}

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
  /**
   * Called once the server is listening, with the bound port and session token.
   * The token is only secret from *other* processes/pages, not the launching
   * CLI — this hook exists so callers (and tests) can construct authorized
   * requests or print the URL. Optional.
   */
  onReady?: (info: { port: number; token: string; url: string }) => void;
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

/**
 * Start the preview server and open the browser.
 * Returns a promise that resolves when the user applies or cancels.
 */
export async function startPreviewServer(
  options: PreviewServerOptions,
): Promise<{ applied: boolean; result: ApplyResult | null }> {
  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  // Per-session secret. Delivered to the browser via the URL fragment and
  // required on every mutating endpoint so no other local process or web page
  // can drive the preview (e.g. POST /api/apply to overwrite the attachment).
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
    shuttingDown: boolean;
  } = {
    lastResultBytes: null,
    lastResultMimeType: null,
    timeoutId: null,
    server: null,
    wsConnected: false,
    wsHeartbeatId: null,
    closeGraceId: null,
    shuttingDown: false,
  };

  let resolvePromise: (value: { applied: boolean; result: ApplyResult | null }) => void;
  const done = new Promise<{ applied: boolean; result: ApplyResult | null }>((resolve) => {
    resolvePromise = resolve;
  });

  // The promise must resolve exactly once. Bun's `server.stop(true)` fires the
  // WebSocket close handler synchronously, so a naive apply path would let the
  // close handler's {applied:false} win the race over the real {applied:true}.
  let resolved = false;
  const resolveOnce = (value: { applied: boolean; result: ApplyResult | null }) => {
    if (!resolved) {
      resolved = true;
      resolvePromise(value);
    }
  };

  const shutdown = () => {
    state.shuttingDown = true;
    if (state.timeoutId) clearTimeout(state.timeoutId);
    if (state.wsHeartbeatId) clearInterval(state.wsHeartbeatId);
    if (state.closeGraceId) clearTimeout(state.closeGraceId);
    state.server?.stop(true);
  };

  state.server = Bun.serve({
    port,
    hostname: '127.0.0.1',
    // The apply endpoint can take 30+ seconds (SCP upload + wp media regenerate over SSH).
    // Bun's default idleTimeout is 10s which kills the connection mid-operation.
    idleTimeout: 120,
    fetch: async (req, server) => {
      const url = new URL(req.url);

      // Reject anything not addressed to the loopback origin. This defeats DNS
      // rebinding (the attacker's rebound hostname would appear in Host) and
      // stray cross-origin navigations.
      const host = req.headers.get('host') ?? '';
      const listenPort = server.port ?? state.server?.port;
      if (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`) {
        return new Response('Forbidden', { status: 403 });
      }

      // WebSocket upgrade for heartbeat — token via query string.
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        if (url.searchParams.get('token') !== token) {
          return new Response('Forbidden', { status: 403 });
        }
        const upgraded = server.upgrade(req, { data: {} });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Require the session token on every mutating/data endpoint. Image
      // endpoints loaded via <img src> can't send a header, so they're exempt
      // (still Host-checked and not CORS-readable cross-origin).
      if (url.pathname.startsWith('/api/') && !isTokenExempt(req.method, url.pathname)) {
        if (req.headers.get('x-preview-token') !== token) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      // Serve the UI (with the auth bootstrap injected into <head>).
      if (url.pathname === '/' && req.method === 'GET') {
        const html = options.html.replace('<head>', `<head>${authBootstrap()}`);
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
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
          // Resolve BEFORE shutting the server down: stop(true) fires the WS
          // close handler synchronously, and resolveOnce must record the
          // successful apply, not the close handler's cancel.
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
        // A reconnect (page reload) landed within the grace window — keep alive.
        if (state.closeGraceId) {
          clearTimeout(state.closeGraceId);
          state.closeGraceId = null;
        }
      },
      message() {
        // Heartbeat pong — client is alive.
      },
      close() {
        state.wsConnected = false;
        if (state.shuttingDown) return; // intentional shutdown — nothing to do
        // A reload closes then immediately reopens the socket. Only treat the
        // close as "the user left" if no new socket connects within the window.
        if (state.closeGraceId) clearTimeout(state.closeGraceId);
        state.closeGraceId = setTimeout(() => {
          if (!state.wsConnected && !state.shuttingDown) {
            info('  Browser tab closed. Shutting down preview server.');
            resolveOnce({ applied: false, result: null });
            shutdown();
          }
        }, 1500);
      },
    },
  });

  const actualPort = state.server.port ?? 0;
  const previewUrl = `http://127.0.0.1:${actualPort}`;

  info(`  Preview server running at ${previewUrl}`);
  info('  Opening browser...');

  options.onReady?.({ port: actualPort, token, url: previewUrl });

  // The token rides in the URL fragment: never sent to the server, never logged.
  openBrowser(`${previewUrl}/#token=${token}`);

  // Auto-shutdown timeout.
  state.timeoutId = setTimeout(() => {
    warn('Preview server timed out. Shutting down.');
    resolveOnce({ applied: false, result: null });
    shutdown();
  }, timeoutMs);

  return done;
}

/** Open a URL in the default browser. Best-effort — never throws. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    // A missing launcher (headless/CI) emits an async 'error'; swallow it so it
    // doesn't crash the process. The user can still open the printed URL.
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore
  }
}
