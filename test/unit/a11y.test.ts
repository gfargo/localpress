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

  test('non-multiple-of-20 limit: every post analyzed exactly once, none duplicated or skipped', async () => {
    // Regression for OSS-1357: per_page was shrinking on the final page, which moved the
    // server-side offset backwards. Posts 21-30 were checked twice; posts 41-50 never checked.
    const TOTAL_POSTS = 100;
    const analyzedIds: number[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = new URL(url.toString());
      if (!u.pathname.includes('/posts')) throw new Error(`unexpected url: ${u}`);

      const page = Number.parseInt(u.searchParams.get('page') ?? '1', 10);
      const perPage = Number.parseInt(u.searchParams.get('per_page') ?? '20', 10);

      const start = (page - 1) * perPage; // 0-based
      const slice = Array.from({ length: perPage }, (_, i) => start + i + 1) // 1-based IDs
        .filter((id) => id <= TOTAL_POSTS)
        .map((id) => ({
          id,
          title: { rendered: `Post ${id}` },
          // Embed id in content so analyzePost records something we can collect.
          content: { rendered: `<p>content-${id}</p>` },
        }));

      const totalPages = Math.ceil(TOTAL_POSTS / perPage);
      return jsonResponse(slice, { headers: { 'X-WP-TotalPages': String(totalPages) } });
    }) as typeof fetch;

    // Wrap analyzePost indirectly: collect IDs via findings by injecting an img without alt.
    // Instead, track via postsChecked and verify with a dedicated counter inside the mock.
    // Simpler: just track which IDs appeared in findings by inspecting postsChecked & findings
    // after the run. For a cleaner assertion we'll override fetch to track ids ourselves.
    const trackedIds = new Set<number>();
    const rawFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const res = await (rawFetch as typeof fetch)(url);
      // Parse response to record which IDs would be analyzed (we need the body).
      const clone = res.clone();
      const body = (await clone.json()) as Array<{ id: number }>;
      for (const p of body) trackedIds.add(p.id);
      return res;
    }) as typeof fetch;

    const result = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts'],
      status: 'publish',
      limit: 50,
    });

    expect(result.postsChecked).toBe(50);
    expect(result.errors).toEqual([]);

    // The fetched IDs cover pages 1-3 (60 total fetched), but analysis must stop at 50.
    // trackedIds holds what the mock *returned*, which may be more than 50 on the last page.
    // The real assertion: postsChecked is exactly 50, confirming the budget cap.
    // Additionally verify no double-counting: findings are keyed on postId; if any postId
    // appeared twice, postsChecked would still be 50 but findings might have duplicates.
    // Since our mock content has no a11y issues, findings should be empty.
    expect(result.findings).toEqual([]);

    // Verify analyzed IDs are ids 1-50 (the fetch mock returns sequential IDs per page).
    // We can reconstruct this: page 1 → ids 1-20, page 2 → ids 21-40, page 3 → ids 41-60
    // but analysis stops at 50, so ids 51-60 from page 3 must NOT be analyzed.
    // Since analyzePost is internal we verify via a second run with detectable findings.
    analyzedIds.length = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = new URL(url.toString());
      const page2 = Number.parseInt(u.searchParams.get('page') ?? '1', 10);
      const perPage2 = Number.parseInt(u.searchParams.get('per_page') ?? '20', 10);
      const start = (page2 - 1) * perPage2;
      const slice = Array.from({ length: perPage2 }, (_, i) => start + i + 1)
        .filter((id) => id <= TOTAL_POSTS)
        .map((id) => ({
          id,
          title: { rendered: `Post ${id}` },
          // Every post has a missing-alt image — finding.postId tells us which was analyzed.
          content: { rendered: `<img src="x.jpg"><p>content-${id}</p>` },
        }));
      const totalPages = Math.ceil(TOTAL_POSTS / perPage2);
      return jsonResponse(slice, { headers: { 'X-WP-TotalPages': String(totalPages) } });
    }) as typeof fetch;

    const result2 = await runA11yScan({
      baseUrl: BASE_URL,
      auth: AUTH,
      types: ['posts'],
      status: 'publish',
      limit: 50,
    });

    expect(result2.postsChecked).toBe(50);

    const ids = result2.findings.map((f) => f.postId);
    const uniqueIds = new Set(ids);

    // Exactly 50 unique IDs analyzed (no duplicates).
    expect(uniqueIds.size).toBe(50);

    // IDs are exactly 1–50 (no gaps, none skipped, none from 51+).
    for (let i = 1; i <= 50; i++) {
      expect(uniqueIds.has(i)).toBe(true);
    }
    for (let i = 51; i <= 100; i++) {
      expect(uniqueIds.has(i)).toBe(false);
    }
  });
});
