/**
 * Unit tests for the a11y scan — verifies that failed/errored requests
 * are surfaced instead of silently producing a false "no issues found" result.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runA11yScan } from '../../src/cli/commands/a11y.ts';

const BASE_URL = 'https://example.test';
const AUTH = 'Basic dGVzdDp0ZXN0';

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('runA11yScan', () => {
  test('reports a clean, complete scan when everything succeeds', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/posts')) return jsonResponse([], { headers: { 'X-WP-TotalPages': '1' } });
      if (u.includes('/pages')) return jsonResponse([], { headers: { 'X-WP-TotalPages': '1' } });
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts', 'pages'],
      status: 'publish',
      limit: 100,
    });

    expect(result.postsChecked).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.truncated).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('records an error and marks scan incomplete on a mid-pagination failure', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('page=1')) {
        return jsonResponse(
          [{ id: 1, title: { rendered: 'Post 1' }, content: { rendered: '<p>hi</p>' } }],
          { headers: { 'X-WP-TotalPages': '3' } },
        );
      }
      if (u.includes('page=2')) {
        return new Response('Internal Server Error', { status: 500 });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts'],
      status: 'publish',
      limit: 100,
    });

    expect(result.postsChecked).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].status).toBe(500);
    expect(result.complete).toBe(false);
  });

  test('records a network error when fetch throws, without checking any posts', async () => {
    globalThis.fetch = (async (_url: string | URL | Request): Promise<Response> => {
      throw new Error('fetch failed: connection refused');
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts', 'pages'],
      status: 'publish',
      limit: 100,
    });

    expect(result.postsChecked).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain('connection refused');
    expect(result.complete).toBe(false);
  });

  test('--id mode records an error when a single post lookup 404s', async () => {
    globalThis.fetch = (async (_url: string | URL | Request) =>
      new Response('Not Found', { status: 404 })) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts'],
      id: 42,
      status: 'publish',
      limit: 100,
    });

    expect(result.postsChecked).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].status).toBe(404);
    expect(result.complete).toBe(false);
  });

  test('--id mode does not report an error when the post is found under another post type', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/posts/')) return new Response('Not Found', { status: 404 });
      if (u.includes('/pages/')) {
        return jsonResponse({
          id: 42,
          title: { rendered: 'A Page' },
          content: { rendered: '<p>hi</p>' },
        });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts', 'pages'],
      id: 42,
      status: 'publish',
      limit: 100,
    });

    expect(result.postsChecked).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.complete).toBe(true);
  });

  test('marks the scan truncated when --limit is hit before all pages are checked', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      // Every page returns as many posts as requested (per_page), with 3 total pages available.
      const params = new URL(u).searchParams;
      const perPage = Number.parseInt(params.get('per_page') ?? '20', 10);
      const posts = Array.from({ length: perPage }, (_, i) => ({
        id: i + 1,
        title: { rendered: `Post ${i + 1}` },
        content: { rendered: '<p>hi</p>' },
      }));
      return jsonResponse(posts, { headers: { 'X-WP-TotalPages': '3' } });
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts'],
      status: 'publish',
      limit: 5,
    });

    expect(result.postsChecked).toBe(5);
    expect(result.errors).toEqual([]);
    expect(result.truncated).toEqual(['posts']);
    expect(result.complete).toBe(false);
  });

  test('an error in one post type does not prevent checking another', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/posts')) return new Response('Forbidden', { status: 403 });
      if (u.includes('/pages')) return jsonResponse([], { headers: { 'X-WP-TotalPages': '1' } });
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts', 'pages'],
      status: 'publish',
      limit: 100,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].postType).toBe('posts');
    expect(result.complete).toBe(false);
  });
});
