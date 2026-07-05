/**
 * Unit tests for RestAdapter list filtering/sorting (localpress #123 / OSS-521):
 *
 *   1. `--sort size` must sort the whole filtered library, not just one page.
 *   2. `--type image/png` must return only that exact MIME type, not every
 *      image subtype.
 *
 * Spins up an in-process fake WP REST media endpoint with Bun.serve() so we
 * can exercise real pagination/header-driven behavior without Docker.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { RestAdapter } from '../../src/adapters/rest.ts';
import type { SiteConfig } from '../../src/types.ts';

interface FixtureItem {
  id: number;
  sizeBytes: number;
  mimeType: string;
}

function buildMediaResponse(item: FixtureItem) {
  return {
    id: item.id,
    title: { rendered: `Item ${item.id}`, raw: `Item ${item.id}` },
    source_url: `https://example.test/wp-content/uploads/item-${item.id}.jpg`,
    mime_type: item.mimeType,
    media_details: {
      width: 800,
      height: 600,
      file: `item-${item.id}.jpg`,
      filesize: item.sizeBytes,
    },
    alt_text: '',
    caption: { rendered: '' },
    description: { rendered: '' },
    date: '2024-01-01T00:00:00',
    slug: `item-${item.id}`,
  };
}

let activeServer: ReturnType<typeof Bun.serve> | undefined;

/**
 * Fake WP REST media endpoint. `items` must already be in the order the real
 * WP site would return them for `orderby=date&order=desc` (newest first) —
 * the fixtures below deliberately hide the "true" max/min size on a later
 * page so a test that only looked at page 1 would get the wrong answer.
 */
function startFakeWpServer(items: FixtureItem[]): {
  url: string;
  lastQuery: () => URLSearchParams;
} {
  let lastSearchParams = new URLSearchParams();

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      lastSearchParams = url.searchParams;

      if (!url.pathname.endsWith('/wp-json/wp/v2/media')) {
        return new Response('not found', { status: 404 });
      }

      const perPage = Number(url.searchParams.get('per_page') ?? '10');
      const page = Number(url.searchParams.get('page') ?? '1');
      const mimeType = url.searchParams.get('mime_type');
      const mediaType = url.searchParams.get('media_type');

      let filtered = items;
      if (mimeType) {
        // Real WP: mime_type does an exact post_mime_type match.
        filtered = filtered.filter((i) => i.mimeType === mimeType);
      } else if (mediaType) {
        // Real WP: media_type only matches the broad category.
        filtered = filtered.filter((i) => i.mimeType.startsWith(`${mediaType}/`));
      }

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      const start = (page - 1) * perPage;
      const pageItems = filtered.slice(start, start + perPage);

      return new Response(JSON.stringify(pageItems.map(buildMediaResponse)), {
        headers: {
          'content-type': 'application/json',
          'X-WP-Total': String(total),
          'X-WP-TotalPages': String(totalPages),
        },
      });
    },
  });
  activeServer = server;

  return { url: `http://localhost:${server.port}`, lastQuery: () => lastSearchParams };
}

function makeSite(url: string): SiteConfig {
  return {
    name: 'test',
    url,
    username: 'admin',
    appPassword: 'test-pass',
    createdAt: '2024-01-01T00:00:00.000Z',
  };
}

afterEach(() => {
  activeServer?.stop(true);
  activeServer = undefined;
});

describe('RestAdapter — size sort scans the whole library', () => {
  test('finds the true max across pages, not just page 1', async () => {
    // 250 items across 3 server pages (100/100/50). The global max lives on
    // page 3 — a per-page sort (the old buggy behavior) would never see it.
    const items: FixtureItem[] = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      sizeBytes: 1000 + ((i * 13) % 5000),
      mimeType: 'image/jpeg',
    }));
    const globalMaxIndex = 220;
    items[globalMaxIndex].sizeBytes = 999_999;

    const { url } = startFakeWpServer(items);
    const adapter = new RestAdapter(makeSite(url));

    const result = await adapter.listMediaPage({
      sortBy: 'size',
      sortOrder: 'desc',
      perPage: 10,
      page: 1,
    });

    expect(result.total).toBe(250);
    expect(result.totalPages).toBe(25);
    expect(result.items[0]?.sizeBytes).toBe(999_999);
  });

  test('finds the true min across pages when sorting ascending', async () => {
    const items: FixtureItem[] = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      sizeBytes: 10_000 + ((i * 13) % 5000),
      mimeType: 'image/jpeg',
    }));
    const globalMinIndex = 230;
    items[globalMinIndex].sizeBytes = 42;

    const { url } = startFakeWpServer(items);
    const adapter = new RestAdapter(makeSite(url));

    const result = await adapter.listMediaPage({
      sortBy: 'size',
      sortOrder: 'asc',
      perPage: 10,
      page: 1,
    });

    expect(result.items[0]?.sizeBytes).toBe(42);
  });

  test('warns and does not crash when the library exceeds the bounded fetch limit', async () => {
    // 2,500 items at per_page=100 is 25 pages — beyond the 20-page cap, so
    // this must fall back to a bounded (but honestly-labeled) sort.
    const items: FixtureItem[] = Array.from({ length: 2500 }, (_, i) => ({
      id: i + 1,
      sizeBytes: (i * 7) % 100_000,
      mimeType: 'image/jpeg',
    }));

    const { url } = startFakeWpServer(items);
    const adapter = new RestAdapter(makeSite(url));

    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    let result: Awaited<ReturnType<typeof adapter.listMediaPage>>;
    try {
      result = await adapter.listMediaPage({
        sortBy: 'size',
        sortOrder: 'desc',
        perPage: 50,
        page: 1,
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(result.total).toBe(2500);
    expect(result.items).toHaveLength(50);
    expect(stderrOutput).toContain('Sorting by size across the first');
  });

  test('does not warn when the whole library fits within the bounded fetch', async () => {
    const items: FixtureItem[] = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      sizeBytes: i,
      mimeType: 'image/jpeg',
    }));

    const { url } = startFakeWpServer(items);
    const adapter = new RestAdapter(makeSite(url));

    const originalWrite = process.stderr.write.bind(process.stderr);
    let stderrOutput = '';
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrOutput += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      await adapter.listMediaPage({ sortBy: 'size', sortOrder: 'desc', perPage: 10, page: 1 });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(stderrOutput).toBe('');
  });
});

describe('RestAdapter — exact MIME type filtering', () => {
  function mixedMimeFixtures(): FixtureItem[] {
    return [
      { id: 1, sizeBytes: 100, mimeType: 'image/png' },
      { id: 2, sizeBytes: 100, mimeType: 'image/jpeg' },
      { id: 3, sizeBytes: 100, mimeType: 'image/png' },
      { id: 4, sizeBytes: 100, mimeType: 'image/webp' },
      { id: 5, sizeBytes: 100, mimeType: 'image/jpeg' },
      { id: 6, sizeBytes: 100, mimeType: 'video/mp4' },
    ];
  }

  test('`type: image/png` returns only PNGs', async () => {
    const { url, lastQuery } = startFakeWpServer(mixedMimeFixtures());
    const adapter = new RestAdapter(makeSite(url));

    const result = await adapter.listMediaPage({ type: 'image/png' });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.mimeType).toBe('image/png');
    }
    expect(lastQuery().get('mime_type')).toBe('image/png');
    expect(lastQuery().get('media_type')).toBe('image');
  });

  test('`type: image` (bare category) still returns every image subtype', async () => {
    const { url, lastQuery } = startFakeWpServer(mixedMimeFixtures());
    const adapter = new RestAdapter(makeSite(url));

    const result = await adapter.listMediaPage({ type: 'image' });

    const mimeTypes = new Set(result.items.map((i) => i.mimeType));
    expect(mimeTypes.size).toBeGreaterThan(1);
    expect(lastQuery().get('media_type')).toBe('image');
    expect(lastQuery().get('mime_type')).toBeNull();
  });

  test('`listMedia` (non-paged) also applies the exact MIME filter', async () => {
    const { url } = startFakeWpServer(mixedMimeFixtures());
    const adapter = new RestAdapter(makeSite(url));

    const items = await adapter.listMedia({ type: 'image/jpeg' });

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.mimeType).toBe('image/jpeg');
    }
  });
});
