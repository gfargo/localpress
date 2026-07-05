/**
 * Unit tests for the shared preview-server auth guard (token-auth.ts).
 */

import { describe, expect, test } from 'bun:test';
import { extractToken, isAuthorized, isValidHost } from '../../src/engine/preview/token-auth.ts';

const TOKEN = 'a1b2c3d4-e5f6-4789-9abc-def012345678';

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

describe('isValidHost', () => {
  test('accepts 127.0.0.1:<port>', () => {
    const r = req('http://127.0.0.1:4123/', { headers: { host: '127.0.0.1:4123' } });
    expect(isValidHost(r, 4123)).toBe(true);
  });

  test('accepts localhost:<port>', () => {
    const r = req('http://localhost:4123/', { headers: { host: 'localhost:4123' } });
    expect(isValidHost(r, 4123)).toBe(true);
  });

  test('rejects mismatched port', () => {
    const r = req('http://127.0.0.1:4123/', { headers: { host: '127.0.0.1:9999' } });
    expect(isValidHost(r, 4123)).toBe(false);
  });

  test('rejects a foreign host (DNS rebinding)', () => {
    const r = req('http://127.0.0.1:4123/', { headers: { host: 'evil.example.com' } });
    expect(isValidHost(r, 4123)).toBe(false);
  });

  test('rejects a missing host header', () => {
    const r = new Request('http://127.0.0.1:4123/');
    r.headers.delete('host');
    expect(isValidHost(r, 4123)).toBe(false);
  });
});

describe('extractToken', () => {
  test('prefers the X-Preview-Token header', () => {
    const url = new URL('http://127.0.0.1:4123/api/meta?token=from-query');
    const r = req(url.toString(), { headers: { 'x-preview-token': 'from-header' } });
    expect(extractToken(r, url)).toBe('from-header');
  });

  test('falls back to the ?token= query param', () => {
    const url = new URL('http://127.0.0.1:4123/api/source?token=from-query');
    const r = req(url.toString());
    expect(extractToken(r, url)).toBe('from-query');
  });

  test('returns null when neither is present', () => {
    const url = new URL('http://127.0.0.1:4123/api/source');
    const r = req(url.toString());
    expect(extractToken(r, url)).toBeNull();
  });
});

describe('isAuthorized', () => {
  test('accepts a valid host + correct token via header', () => {
    const url = new URL('http://127.0.0.1:4123/api/apply');
    const r = req(url.toString(), {
      method: 'POST',
      headers: { host: '127.0.0.1:4123', 'x-preview-token': TOKEN },
    });
    expect(isAuthorized(r, url, 4123, TOKEN)).toBe(true);
  });

  test('accepts a valid host + correct token via query param', () => {
    const url = new URL(`http://127.0.0.1:4123/api/source?token=${TOKEN}`);
    const r = req(url.toString(), { headers: { host: '127.0.0.1:4123' } });
    expect(isAuthorized(r, url, 4123, TOKEN)).toBe(true);
  });

  test('rejects a missing token', () => {
    const url = new URL('http://127.0.0.1:4123/api/apply');
    const r = req(url.toString(), { method: 'POST', headers: { host: '127.0.0.1:4123' } });
    expect(isAuthorized(r, url, 4123, TOKEN)).toBe(false);
  });

  test('rejects a wrong token', () => {
    const url = new URL('http://127.0.0.1:4123/api/apply');
    const r = req(url.toString(), {
      method: 'POST',
      headers: { host: '127.0.0.1:4123', 'x-preview-token': 'wrong-token-wrong-token-wrong123' },
    });
    expect(isAuthorized(r, url, 4123, TOKEN)).toBe(false);
  });

  test('rejects a wrong host even with the correct token', () => {
    const url = new URL('http://127.0.0.1:4123/api/apply');
    const r = req(url.toString(), {
      method: 'POST',
      headers: { host: 'evil.example.com', 'x-preview-token': TOKEN },
    });
    expect(isAuthorized(r, url, 4123, TOKEN)).toBe(false);
  });
});
