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
import { info, warn } from '../../cli/utils/output.ts';

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
  onApply: (resultBytes: Buffer) => Promise<ApplyResult>;
  /** Auto-shutdown timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
  /** HTML content for the UI page. */
  html: string;
}

export interface ProcessResult {
  bytes: Buffer;
  mimeType: string;
  stats: Record<string, unknown>;
}

export interface ApplyResult {
  wpId: number;
  message: string;
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

  // Mutable state shared between the fetch handler and lifecycle management.
  const state: {
    lastResultBytes: Buffer | null;
    timeoutId: ReturnType<typeof setTimeout> | null;
    server: ReturnType<typeof Bun.serve> | null;
    wsConnected: boolean;
    wsHeartbeatId: ReturnType<typeof setInterval> | null;
  } = {
    lastResultBytes: null,
    timeoutId: null,
    server: null,
    wsConnected: false,
    wsHeartbeatId: null,
  };

  let resolvePromise: (value: { applied: boolean; result: ApplyResult | null }) => void;
  const done = new Promise<{ applied: boolean; result: ApplyResult | null }>((resolve) => {
    resolvePromise = resolve;
  });

  const shutdown = () => {
    if (state.timeoutId) clearTimeout(state.timeoutId);
    if (state.wsHeartbeatId) clearInterval(state.wsHeartbeatId);
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

      // WebSocket upgrade for heartbeat.
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, { data: {} });
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 500 });
      }

      // Serve the UI.
      if (url.pathname === '/' && req.method === 'GET') {
        return new Response(options.html, {
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
          const result = await options.onApply(state.lastResultBytes);
          info(`  ✓ Applied successfully (${result.message})`);
          // Delay shutdown to ensure the response is fully sent to the browser
          // before the server closes the TCP connection.
          setTimeout(() => {
            shutdown();
            resolvePromise({ applied: true, result });
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
        shutdown();
        resolvePromise({ applied: false, result: null });
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
          }),
          { headers: { 'Content-Type': 'application/json' } },
        );
      }

      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open() {
        state.wsConnected = true;
      },
      message() {
        // Heartbeat pong — client is alive.
      },
      close() {
        state.wsConnected = false;
        info('  Browser tab closed. Shutting down preview server.');
        shutdown();
        resolvePromise({ applied: false, result: null });
      },
    },
  });

  const actualPort = state.server.port;
  const previewUrl = `http://127.0.0.1:${actualPort}`;

  info(`  Preview server running at ${previewUrl}`);
  info('  Opening browser...');

  openBrowser(previewUrl);

  // Auto-shutdown timeout.
  state.timeoutId = setTimeout(() => {
    warn('Preview server timed out. Shutting down.');
    shutdown();
    resolvePromise({ applied: false, result: null });
  }, timeoutMs);

  return done;
}

/** Open a URL in the default browser. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
