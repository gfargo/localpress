/**
 * Quick browser image viewer.
 *
 * Spins up a minimal HTTP server that serves a single image in the browser.
 * Opens automatically and shuts down when the tab closes (via WebSocket).
 * Used by the interactive media browser's [P] keybinding as a
 * terminal-agnostic alternative to iTerm2 inline images.
 */

import { spawn } from 'node:child_process';

export interface QuickViewOptions {
  /** Image bytes to display. */
  imageBytes: Buffer;
  /** MIME type of the image. */
  mimeType: string;
  /** Filename for display. */
  filename: string;
  /** Image dimensions. */
  width?: number;
  height?: number;
  /** File size in bytes. */
  sizeBytes?: number;
  /** WordPress attachment ID. */
  wpId: number;
  /** Port (0 = auto). */
  port?: number;
}

/**
 * Open an image in the browser. Returns a promise that resolves when
 * the browser tab is closed.
 */
export async function quickViewInBrowser(options: QuickViewOptions): Promise<void> {
  let resolvePromise: () => void;
  const done = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });

  const state: {
    server: ReturnType<typeof Bun.serve> | null;
    timeoutId: ReturnType<typeof setTimeout> | null;
  } = { server: null, timeoutId: null };

  const shutdown = () => {
    if (state.timeoutId) clearTimeout(state.timeoutId);
    state.server?.stop(true);
  };

  const html = buildQuickViewHtml(options);

  state.server = Bun.serve({
    port: options.port ?? 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      const url = new URL(req.url);
      // Only serve the loopback origin (defeats DNS rebinding). quick-view is
      // read-only (no mutation endpoint), so no token is needed beyond this.
      const host = req.headers.get('host') ?? '';
      const listenPort = server.port ?? state.server?.port;
      if (host !== `127.0.0.1:${listenPort}` && host !== `localhost:${listenPort}`) {
        return new Response('Forbidden', { status: 403 });
      }
      if (url.pathname === '/ws' && req.headers.get('upgrade') === 'websocket') {
        const upgraded = server.upgrade(req, { data: {} });
        return upgraded ? undefined : new Response('Upgrade failed', { status: 500 });
      }
      if (url.pathname === '/' && req.method === 'GET') {
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/image' && req.method === 'GET') {
        return new Response(options.imageBytes, {
          headers: {
            'Content-Type': options.mimeType,
            'Content-Length': String(options.imageBytes.length),
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
      return new Response('Not Found', { status: 404 });
    },
    websocket: {
      open() {},
      message() {},
      close() {
        shutdown();
        resolvePromise();
      },
    },
  });

  const previewUrl = `http://127.0.0.1:${state.server.port}`;
  openBrowser(previewUrl);

  // Auto-shutdown after 5 minutes if the WebSocket never connects.
  state.timeoutId = setTimeout(
    () => {
      shutdown();
      resolvePromise();
    },
    5 * 60 * 1000,
  );

  return done;
}

function buildQuickViewHtml(opts: QuickViewOptions): string {
  const dims = opts.width && opts.height ? `${opts.width}×${opts.height}px` : '';
  const size = opts.sizeBytes ? formatBytes(opts.sizeBytes) : '';
  const meta = [`#${opts.wpId}`, opts.mimeType, dims, size].filter(Boolean).join('  ·  ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.filename)} — localpress</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0f1117; color: #e4e6ef; min-height: 100vh;
    display: flex; flex-direction: column;
  }
  .bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 20px; background: #1a1d27; border-bottom: 1px solid #2e3345;
    flex-shrink: 0;
  }
  .bar-left { display: flex; align-items: center; gap: 10px; }
  .bar h1 { font-size: 15px; font-weight: 600; }
  .bar h1 span { color: #22c55e; }
  .bar .filename { color: #8b8fa3; font-size: 13px; }
  .bar .meta { color: #8b8fa3; font-size: 12px; }
  .viewer {
    flex: 1; display: flex; align-items: center; justify-content: center;
    background: repeating-conic-gradient(#1e2130 0% 25%, #252838 0% 50%) 50% / 20px 20px;
    padding: 20px;
  }
  .viewer img {
    max-width: 100%; max-height: calc(100vh - 60px);
    object-fit: contain; border-radius: 4px;
  }
</style>
</head>
<body>
<div class="bar">
  <div class="bar-left">
    <h1><span>local</span>press</h1>
    <span class="filename">${escapeHtml(opts.filename)}</span>
  </div>
  <span class="meta">${escapeHtml(meta)}</span>
</div>
<div class="viewer">
  <img src="/image" alt="${escapeHtml(opts.filename)}" />
</div>
<script>
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws');
  ws.onopen = () => { setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 5000); };
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignore — best-effort browser launch
  }
}
