/**
 * Unit tests for `localpress briefing` (site_briefing) — the aggregation
 * command that rolls up unoptimized/missing-alt/broken-refs/orphans/a11y
 * checks into one summary plus an optional Ollama narrative.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AdapterResolver } from '../../src/adapters/resolver.ts';
import type {
  Capability,
  ListFilters,
  MediaItem,
  PagedResult,
  PruneResult,
  Reference,
  ReferenceScope,
  WpBackend,
} from '../../src/adapters/types.ts';
import {
  runA11yCheck,
  runMediaChecks,
  runOrphansCheck,
  synthesizeNarrative,
} from '../../src/cli/commands/briefing.ts';
import { SiteDb } from '../../src/engine/state/db.ts';
import type { SiteConfig } from '../../src/types.ts';

const fakeRestOnlySite: SiteConfig = {
  name: 'test-briefing-site',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
};

function makeItem(id: number, overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id,
    title: `item-${id}`,
    filename: `item-${id}.jpg`,
    url: `https://example.test/item-${id}.jpg`,
    mimeType: 'image/jpeg',
    uploadedAt: new Date('2026-01-01').toISOString(),
    ...overrides,
  };
}

/** Minimal WpBackend serving a fixed set of media items and no references. */
class FakeMediaAdapter implements WpBackend {
  readonly name = 'rest' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(['list']);

  constructor(private readonly items: MediaItem[]) {}

  async listMediaPage(_filters: ListFilters): Promise<PagedResult<MediaItem>> {
    return { items: this.items, total: this.items.length, totalPages: 1 };
  }
  async listMedia(): Promise<MediaItem[]> {
    return this.items;
  }
  async getMedia(id: number): Promise<MediaItem> {
    return makeItem(id);
  }
  async upload(): Promise<MediaItem> {
    throw new Error('not used in this test');
  }
  async replaceInPlace(): Promise<MediaItem> {
    throw new Error('not used in this test');
  }
  async updateMetadata(): Promise<void> {}
  async delete(): Promise<void> {}
  async regenerateThumbnails(): Promise<void> {}
  async pruneOrphans(): Promise<PruneResult> {
    throw new Error('not used in this test');
  }
  async findReferences(_id: number, _scope: ReferenceScope): Promise<Reference[]> {
    return [];
  }
  async findUnattached(): Promise<number[]> {
    return [];
  }
}

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

describe('runMediaChecks', () => {
  test('counts unoptimized and missing-alt items correctly', async () => {
    const items = [
      makeItem(1, { altText: 'has alt text' }),
      makeItem(2, { altText: '' }),
      makeItem(3),
    ];
    const adapter = new FakeMediaAdapter(items);
    const db = SiteDb.init(':memory:');
    db.ensureSite('test-briefing-site', 'https://example.test');
    // Mark item 1 as already processed (attachment row required for the FK).
    db.upsertAttachment({
      siteName: 'test-briefing-site',
      wpId: 1,
      sourceUrl: items[0].url,
      sourceHash: null,
      sizeBytes: null,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: Date.now(),
    });
    db.recordProcessing({
      siteName: 'test-briefing-site',
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 1000,
      bytesAfter: 500,
      resultWpId: null,
      ranAt: Date.now(),
      durationMs: 10,
      status: 'success',
      errorMessage: null,
    });

    const result = await runMediaChecks(adapter, db, 'test-briefing-site');
    db.close();

    expect(result.unoptimized.count).toBe(2); // items 2 and 3
    expect(result.unoptimized.available).toBe(true);
    expect(result.missingAlt.count).toBe(2); // items 2 (empty) and 3 (unset)
    expect(result.brokenRefs.count).toBe(0);
  });

  test('marks categories unavailable instead of throwing on adapter failure', async () => {
    const failingAdapter: WpBackend = {
      name: 'rest',
      capabilities: new Set(['list']),
      listMediaPage: async () => {
        throw new Error('network down');
      },
      listMedia: async () => [],
      getMedia: async () => makeItem(1),
      upload: async () => makeItem(1),
      replaceInPlace: async () => makeItem(1),
      updateMetadata: async () => {},
      delete: async () => {},
      regenerateThumbnails: async () => {},
      pruneOrphans: async () => {
        throw new Error('not used');
      },
      findReferences: async () => [],
      findUnattached: async () => [],
    };
    const db = SiteDb.init(':memory:');
    db.ensureSite('test-briefing-site', 'https://example.test');

    const result = await runMediaChecks(failingAdapter, db, 'test-briefing-site');
    db.close();

    expect(result.unoptimized.available).toBe(false);
    expect(result.unoptimized.unavailableReason).toContain('network down');
    expect(result.missingAlt.available).toBe(false);
    expect(result.brokenRefs.available).toBe(false);
  });
});

describe('runOrphansCheck', () => {
  test('reports unavailable for a REST-only site (no WP-CLI)', async () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    const result = await runOrphansCheck(resolver);

    expect(result.available).toBe(false);
    expect(result.count).toBe(0);
    expect(result.unavailableReason).toContain('WP-CLI');
  });
});

describe('runA11yCheck', () => {
  test('reports zero findings on a clean site', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/posts') || u.includes('/pages')) {
        return jsonResponse([], { headers: { 'X-WP-TotalPages': '1' } });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yCheck(fakeRestOnlySite);
    expect(result.available).toBe(true);
    expect(result.count).toBe(0);
  });

  test('surfaces findings from a11y scan', async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = url.toString();
      if (u.includes('/posts')) {
        return jsonResponse(
          [
            {
              id: 1,
              title: { rendered: 'Missing Alt Post' },
              content: { rendered: '<img src="x.jpg">' },
            },
          ],
          { headers: { 'X-WP-TotalPages': '1' } },
        );
      }
      if (u.includes('/pages')) {
        return jsonResponse([], { headers: { 'X-WP-TotalPages': '1' } });
      }
      throw new Error(`unexpected url: ${u}`);
    }) as typeof fetch;

    const result = await runA11yCheck(fakeRestOnlySite);
    expect(result.available).toBe(true);
    expect(result.count).toBe(1);
    expect(result.examples[0]).toContain('Missing Alt Post');
  });
});

describe('synthesizeNarrative', () => {
  const cleanCategories = {
    unoptimized: { count: 0, examples: [], available: true },
    missingAlt: { count: 0, examples: [], available: true },
    brokenRefs: { count: 0, examples: [], available: true },
    orphans: { count: 0, examples: [], available: false, unavailableReason: 'no wp-cli' },
    a11y: { count: 0, examples: [], available: true },
  };

  test('returns a canned clean message without needing Ollama', async () => {
    // No fetch mock installed — if this tried to reach Ollama it would fail
    // to connect (no network in test env) and we'd see narrativeUnavailable.
    const result = await synthesizeNarrative('test-site', cleanCategories, 0, 'moondream');
    expect(result.narrativeUnavailable).toBe(false);
    expect(result.narrative).toContain('clean');
  });

  test('marks narrative unavailable (not an error) when Ollama is unreachable', async () => {
    globalThis.fetch = (async (_url: string | URL | Request): Promise<Response> => {
      throw new Error('connection refused');
    }) as typeof fetch;

    const dirtyCategories = {
      ...cleanCategories,
      unoptimized: { count: 3, examples: ['a.jpg'], available: true },
    };
    const result = await synthesizeNarrative('test-site', dirtyCategories, 3, 'moondream');

    expect(result.narrative).toBeNull();
    expect(result.narrativeUnavailable).toBe(true);
  });
});
