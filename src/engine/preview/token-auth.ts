/**
 * Shared auth guard for the ephemeral preview servers (server.ts, quick-view.ts).
 *
 * Both servers bind 127.0.0.1 only, but that alone doesn't stop another local
 * process — or a malicious web page via DNS rebinding / a findable ephemeral
 * port — from hitting the state-changing endpoints. Every request must carry
 * a per-session token (delivered to the browser via the URL fragment, which
 * never reaches the server or logs) and a Host header that matches the port
 * the server is actually listening on.
 */

import { timingSafeEqual } from 'node:crypto';

export function isValidHost(req: Request, port: number | undefined): boolean {
  if (port === undefined) return false;
  const host = req.headers.get('host');
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Header first (JSON fetch calls), then `?token=` query param (img/WS requests that can't set headers). */
export function extractToken(req: Request, url: URL): string | null {
  return req.headers.get('x-preview-token') ?? url.searchParams.get('token');
}

export function isAuthorized(
  req: Request,
  url: URL,
  port: number | undefined,
  token: string,
): boolean {
  if (!isValidHost(req, port)) return false;
  const provided = extractToken(req, url);
  if (!provided) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
