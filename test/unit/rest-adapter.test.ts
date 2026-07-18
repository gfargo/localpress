/**
 * Regression tests for gfargo/localpress#101 and #204: the REST adapter must
 * request `context=edit` so raw block markup and raw HTML fields are
 * available, but must degrade gracefully when the auth account can't use it.
 *
 *   1. The fast reference scan must find Gutenberg block embeds via
 *      `content.raw`. When `context=edit` is forbidden (401/403 — e.g. an
 *      Author/Contributor Application Password), it must retry without the
 *      `context` param and fall back to matching the `wp-image-<id>` class in
 *      rendered HTML, rather than throwing. A 401/403 on the earlier
 *      featured-image scan (which never requests `context=edit`) is a real
 *      auth failure and must still surface as an error.
 *   2. `getMedia` must prefer `caption.raw` over the stripped `caption.rendered`
 *      fallback, so read-modify-write flows like `tag`/`vision` don't
 *      permanently flatten formatted captions on write-back.
 *
 * All requests are served by a mocked `fetch` — no live WordPress needed.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import { RestAdapter } from '../../src/adapters/rest.ts';
import type { SiteConfig } from '../../src/types.ts';

const fakeSite: SiteConfig = {
  name: 'test-site',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
};

type MockHandler = (url: URL, init?: RequestInit) => Response;

let originalFetch: typeof fetch | undefined;

function installFetchMock(handler: MockHandler): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
});

function jsonResponse(
  body: unknown,
  opts?: { headers?: Record<string, string>; status?: number },
): Response {
  return new Response(JSON.stringify(body), {
    status: opts?.status ?? 200,
    headers: { 'content-type': 'application/json', ...opts?.headers },
  });
}

const PAGE_HEADERS = { 'X-WP-Total': '1', 'X-WP-TotalPages': '1' };
const EMPTY_HEADERS = { 'X-WP-Total': '0', 'X-WP-TotalPages': '1' };

describe('RestAdapter.findReferences (fast scan)', () => {
  test('finds Gutenberg block references via content.raw (context=edit)', async () => {
    const adapter = new RestAdapter(fakeSite);

    installFetchMock((url) => {
      if (url.pathname.endsWith('/wp-json/wp/v2/pages')) {
        return jsonResponse([], { headers: EMPTY_HEADERS });
      }
      if (url.pathname.endsWith('/wp-json/wp/v2/posts')) {
        if (url.searchParams.get('context') === 'edit') {
          return jsonResponse(
            [
              {
                id: 7,
                title: { rendered: 'Hello' },
                type: 'post',
                content: {
                  rendered:
                    '<figure class="wp-block-image"><img src="x.jpg" class="wp-image-42" /></figure>',
                  raw: '<!-- wp:image {"id":42,"sizeSlug":"large"} -->\n<figure class="wp-block-image size-large"><img src="x.jpg" class="wp-image-42"/></figure>\n<!-- /wp:image -->',
                },
              },
            ],
            { headers: PAGE_HEADERS },
          );
        }
        // Featured-image scan (no context param) — no featured image match here.
        return jsonResponse(
          [{ id: 7, title: { rendered: 'Hello' }, type: 'post', featured_media: 0 }],
          { headers: PAGE_HEADERS },
        );
      }
      throw new Error(`unexpected URL in test: ${url.toString()}`);
    });

    const refs = await adapter.findReferences(42, 'fast');
    const blockRef = refs.find((r) => r.type === 'gutenberg-block');
    expect(blockRef).toBeDefined();
    expect(blockRef?.occurrences).toBeGreaterThanOrEqual(1);
    expect(blockRef?.postId).toBe(7);
  });

  test('retries without context and falls back to rendered wp-image-<id> class when context=edit is forbidden', async () => {
    const adapter = new RestAdapter(fakeSite);
    const requestedUrls: URL[] = [];

    installFetchMock((url) => {
      requestedUrls.push(url);

      if (url.pathname.endsWith('/wp-json/wp/v2/pages')) {
        return jsonResponse([], { headers: EMPTY_HEADERS });
      }
      if (url.pathname.endsWith('/wp-json/wp/v2/posts')) {
        if (url.searchParams.get('context') === 'edit') {
          // Author/Contributor Application Password: context=edit is forbidden.
          return jsonResponse(
            { code: 'rest_forbidden_context', message: 'Sorry, you are not allowed to edit.' },
            { status: 403 },
          );
        }
        if (url.searchParams.get('_fields') === 'id,title,type,content') {
          // Retry without context — only rendered HTML is available.
          return jsonResponse(
            [
              {
                id: 9,
                title: { rendered: 'Limited perms post' },
                type: 'post',
                content: { rendered: '<img class="wp-image-42" src="x.jpg" />' },
              },
            ],
            { headers: PAGE_HEADERS },
          );
        }
        // Featured-image scan (no context param) — no featured image match here.
        return jsonResponse(
          [
            {
              id: 9,
              title: { rendered: 'Limited perms post' },
              type: 'post',
              featured_media: 0,
            },
          ],
          { headers: PAGE_HEADERS },
        );
      }
      throw new Error(`unexpected URL in test: ${url.toString()}`);
    });

    const refs = await adapter.findReferences(42, 'fast');
    const blockRef = refs.find((r) => r.type === 'gutenberg-block');
    expect(blockRef).toBeDefined();
    expect(blockRef?.occurrences).toBeGreaterThanOrEqual(1);
    expect(blockRef?.postId).toBe(9);

    // The retry must have actually happened: one forbidden context=edit
    // request, then a follow-up with no context param (defaults to view).
    const postsRequests = requestedUrls.filter((u) => u.pathname.endsWith('/wp-json/wp/v2/posts'));
    expect(postsRequests.some((u) => u.searchParams.get('context') === 'edit')).toBe(true);
    expect(
      postsRequests.some(
        (u) =>
          u.searchParams.get('context') === null &&
          u.searchParams.get('_fields') === 'id,title,type,content',
      ),
    ).toBe(true);
  });

  test('does not mask a real auth failure as a missing-reference result', async () => {
    const adapter = new RestAdapter(fakeSite);

    installFetchMock((url) => {
      if (url.pathname.endsWith('/wp-json/wp/v2/pages')) {
        return jsonResponse([], { headers: EMPTY_HEADERS });
      }
      if (url.pathname.endsWith('/wp-json/wp/v2/posts')) {
        // Bad credentials: even the featured-image scan (default context,
        // runs first) is rejected.
        return jsonResponse(
          { code: 'rest_forbidden', message: 'Invalid Application Password.' },
          { status: 401 },
        );
      }
      throw new Error(`unexpected URL in test: ${url.toString()}`);
    });

    await expect(adapter.findReferences(42, 'fast')).rejects.toThrow();
  });
});

describe('RestAdapter.getMedia caption handling', () => {
  test('preserves HTML caption via context=edit raw field', async () => {
    const adapter = new RestAdapter(fakeSite);

    installFetchMock((url) => {
      expect(url.pathname).toBe('/wp-json/wp/v2/media/55');
      expect(url.searchParams.get('context')).toBe('edit');
      return jsonResponse({
        id: 55,
        title: { rendered: 'A photo', raw: 'A photo' },
        source_url: 'https://example.test/wp-content/uploads/photo.jpg',
        mime_type: 'image/jpeg',
        alt_text: 'A photo',
        caption: {
          rendered: '<p>See &#038; <a href="https://example.test/docs">docs</a></p>\n',
          raw: 'See &amp; <a href="https://example.test/docs">docs</a>',
        },
        description: { rendered: '<p>desc</p>', raw: 'desc' },
        date: '2026-01-01T00:00:00',
        slug: 'photo',
      });
    });

    const item = await adapter.getMedia(55);
    expect(item.caption).toBe('See &amp; <a href="https://example.test/docs">docs</a>');
    expect(item.caption).toContain('<a href=');
  });

  test('falls back to stripped rendered caption when raw is absent', async () => {
    const adapter = new RestAdapter(fakeSite);

    installFetchMock(() =>
      jsonResponse({
        id: 56,
        title: { rendered: 'A photo' },
        source_url: 'https://example.test/wp-content/uploads/photo2.jpg',
        mime_type: 'image/jpeg',
        caption: { rendered: '<p>See <a href="https://example.test/docs">docs</a></p>' },
        date: '2026-01-01T00:00:00',
        slug: 'photo2',
      }),
    );

    const item = await adapter.getMedia(56);
    expect(item.caption).toBe('See docs');
  });
});

describe('tag/vision regression: caption HTML survives read-modify-write', () => {
  // Mirrors the `[tags: …]` block composition in `localpress tag`
  // (src/cli/commands/tag.ts): append without disturbing existing caption text.
  const TAG_BLOCK_RE = /\[tags:\s*([^\]]*)\]/i;

  test('appending a [tags: …] block preserves the existing HTML-formatted caption', async () => {
    const adapter = new RestAdapter(fakeSite);
    let capturedBody: string | undefined;

    installFetchMock((url, init) => {
      if (url.pathname !== '/wp-json/wp/v2/media/77') {
        throw new Error(`unexpected URL in test: ${url.toString()}`);
      }
      if (init?.method === 'POST') {
        capturedBody = init.body as string;
        return jsonResponse({ id: 77 });
      }
      return jsonResponse({
        id: 77,
        title: { rendered: 'Team photo', raw: 'Team photo' },
        source_url: 'https://example.test/wp-content/uploads/team.jpg',
        mime_type: 'image/jpeg',
        caption: {
          rendered: '<p>Team at the <a href="https://example.test/offsite">offsite</a></p>\n',
          raw: 'Team at the <a href="https://example.test/offsite">offsite</a>',
        },
        date: '2026-01-01T00:00:00',
        slug: 'team',
      });
    });

    const item = await adapter.getMedia(77);
    expect(item.caption).toBe('Team at the <a href="https://example.test/offsite">offsite</a>');

    const tags = ['team', 'offsite', 'group-photo'];
    const newBlock = `[tags: ${tags.join(', ')}]`;
    const currentCaption = item.caption ?? '';
    const newCaption = TAG_BLOCK_RE.test(currentCaption)
      ? currentCaption.replace(TAG_BLOCK_RE, newBlock).trim()
      : currentCaption
        ? `${currentCaption.trim()} ${newBlock}`
        : newBlock;

    await adapter.updateMetadata(77, { caption: newCaption });

    expect(capturedBody).toBeDefined();
    const sentBody = JSON.parse(capturedBody as string) as { caption?: string };
    expect(sentBody.caption).toContain('<a href="https://example.test/offsite">offsite</a>');
    expect(sentBody.caption).toContain('[tags: team, offsite, group-photo]');
  });
});
