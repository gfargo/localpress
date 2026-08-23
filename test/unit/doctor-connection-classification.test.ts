/**
 * Unit tests for `classifyConnectionError` (src/cli/commands/doctor.ts).
 *
 * Pure function, no subprocess needed — this is what actually guards against
 * a regression to runtime-specific message substring matching (the original
 * bug: Bun's fetch() rejects with a message that never matched the old
 * ENOTFOUND/ECONNREFUSED substring check).
 */

import { describe, expect, test } from 'bun:test';
import { WpApiError } from '../../src/adapters/types.ts';
import { classifyConnectionError } from '../../src/cli/commands/doctor.ts';

const SITE_URL = 'https://example.test';

function assertNonEmptyFix(fix: string | undefined): void {
  expect(typeof fix).toBe('string');
  expect((fix as string).length).toBeGreaterThan(0);
}

describe('classifyConnectionError — non-WpApiError (fetch never got a response)', () => {
  test('TypeError("fetch failed") — Node/undici', () => {
    const issue = classifyConnectionError(new TypeError('fetch failed'), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('Error("Unable to connect. Is the computer able to access the url?") — Bun', () => {
    const issue = classifyConnectionError(
      new Error('Unable to connect. Is the computer able to access the url?'),
      SITE_URL,
    );
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('Error("getaddrinfo ENOTFOUND example.com")', () => {
    const issue = classifyConnectionError(new Error('getaddrinfo ENOTFOUND example.com'), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('DOMException-style abort/timeout', () => {
    const issue = classifyConnectionError(
      new DOMException('The operation was aborted.', 'AbortError'),
      SITE_URL,
    );
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('non-Error throw', () => {
    const issue = classifyConnectionError('boom', SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });
});

describe('classifyConnectionError — WpApiError (server responded)', () => {
  test('status 401 → auth, with fix', () => {
    const issue = classifyConnectionError(new WpApiError('Unauthorized', 401), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('auth');
    assertNonEmptyFix(issue.fix);
  });

  test('status 403 → not auth, but carries a fix', () => {
    const issue = classifyConnectionError(new WpApiError('Forbidden', 403), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).not.toBe('auth');
    assertNonEmptyFix(issue.fix);
  });

  test('status 404 → network, with fix', () => {
    const issue = classifyConnectionError(new WpApiError('Not Found', 404), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('status undefined → treated as unreachable (network), with fix', () => {
    const issue = classifyConnectionError(new WpApiError('No structured status'), SITE_URL);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('network');
    assertNonEmptyFix(issue.fix);
  });

  test('other status (e.g. 500, or a JSON-parse error with an arbitrary status) → carries a fix', () => {
    const issue = classifyConnectionError(new WpApiError('Internal Server Error', 500), SITE_URL);
    expect(issue.severity).toBe('error');
    assertNonEmptyFix(issue.fix);
  });
});
