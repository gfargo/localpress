/**
 * Unit tests for CPT REST route resolution in `posts.ts`.
 *
 * Verifies that `resolveTypeEndpoint` reads `rest_base` from
 * `/wp-json/wp/v2/types/{type}` instead of assuming it equals the type slug,
 * and that built-ins (post/page) never hit the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { PostTypeError, resolveTypeEndpoint } from '../../src/cli/commands/posts.ts';
import { ExitCode } from '../../src/types.ts';
import type { SiteConfig } from '../../src/types.ts';

const site: SiteConfig = {
  name: 'test',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'app-password',
  createdAt: new Date(0).toISOString(),
};

let originalFetch: typeof fetch;
let calls: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Response) {
  globalThis.fetch = (async (input: string | URL, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
}

describe('resolveTypeEndpoint', () => {
  test('built-in "post" never calls fetch', async () => {
    stubFetch(() => new Response('should not be called', { status: 200 }));
    const endpoint = await resolveTypeEndpoint(site, 'post');
    expect(endpoint).toBe('/posts');
    expect(calls.length).toBe(0);
  });

  test('built-in "page" never calls fetch', async () => {
    stubFetch(() => new Response('should not be called', { status: 200 }));
    const endpoint = await resolveTypeEndpoint(site, 'page');
    expect(endpoint).toBe('/pages');
    expect(calls.length).toBe(0);
  });

  test('resolves a CPT whose rest_base differs from its slug', async () => {
    stubFetch(() => Response.json({ rest_base: 'portfolio', show_in_rest: true }, { status: 200 }));
    const endpoint = await resolveTypeEndpoint(site, 'portfolio_project');
    expect(endpoint).toBe('/portfolio');
    expect(calls[0]).toBe('https://example.test/wp-json/wp/v2/types/portfolio_project');
  });

  test('falls back to the type slug when rest_base is absent', async () => {
    stubFetch(() => Response.json({ show_in_rest: true }, { status: 200 }));
    const endpoint = await resolveTypeEndpoint(site, 'event');
    expect(endpoint).toBe('/event');
  });

  test('throws PostTypeError with InvalidUsage on a 404 type lookup', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    await expect(resolveTypeEndpoint(site, 'nonexistent')).rejects.toThrow(PostTypeError);
    try {
      await resolveTypeEndpoint(site, 'nonexistent-2');
      throw new Error('expected resolveTypeEndpoint to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PostTypeError);
      expect((err as PostTypeError).exitCode).toBe(ExitCode.InvalidUsage);
      expect((err as PostTypeError).message).toContain('was not found');
    }
  });

  test('throws PostTypeError with CapabilityUnavailable when show_in_rest is false', async () => {
    stubFetch(() => Response.json({ rest_base: 'hidden', show_in_rest: false }, { status: 200 }));
    try {
      await resolveTypeEndpoint(site, 'hidden_type');
      throw new Error('expected resolveTypeEndpoint to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PostTypeError);
      expect((err as PostTypeError).exitCode).toBe(ExitCode.CapabilityUnavailable);
      expect((err as PostTypeError).message).toBe(
        'Post type "hidden_type" is not exposed in the REST API (show_in_rest=false) — ' +
          'it cannot be managed via localpress.',
      );
    }
  });

  test('caches the resolved endpoint — fetch is called only once per type', async () => {
    stubFetch(() => Response.json({ rest_base: 'gallery', show_in_rest: true }, { status: 200 }));
    const first = await resolveTypeEndpoint(site, 'gallery_item');
    const second = await resolveTypeEndpoint(site, 'gallery_item');
    expect(first).toBe('/gallery');
    expect(second).toBe('/gallery');
    expect(calls.length).toBe(1);
  });
});
