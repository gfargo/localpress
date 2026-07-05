/**
 * Unit tests for `localpress audit` correctness fixes (#111):
 *   - pagination must not request a page past the last one (exact multiples
 *     of the page size used to trigger a 400 → exit 4)
 *   - `find-unattached` capability wiring (REST throws, WP-CLI declares it)
 */

import { describe, expect, test } from 'bun:test';
import { AdapterResolver } from '../../src/adapters/resolver.ts';
import { RestAdapter } from '../../src/adapters/rest.ts';
import { CapabilityUnavailableError } from '../../src/adapters/types.ts';
import type {
  Capability,
  ListFilters,
  MediaItem,
  PagedResult,
  Reference,
  ReferenceScope,
  WpBackend,
} from '../../src/adapters/types.ts';
import { fetchAllMedia } from '../../src/cli/commands/audit.ts';
import type { SiteConfig } from '../../src/types.ts';

const fakeRestOnlySite: SiteConfig = {
  name: 'test-rest-only',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
};

function makeItem(id: number): MediaItem {
  return {
    id,
    title: `item-${id}`,
    filename: `item-${id}.jpg`,
    url: `https://example.test/item-${id}.jpg`,
    mimeType: 'image/jpeg',
    uploadedAt: new Date('2026-01-01').toISOString(),
  };
}

/** A minimal WpBackend that serves a fixed-size media library, one page at a time. */
class FakePagedAdapter implements WpBackend {
  readonly name = 'rest' as const;
  readonly capabilities: ReadonlySet<Capability> = new Set(['list']);
  requestedPages: number[] = [];

  constructor(private readonly totalItems: number) {}

  async listMedia(): Promise<MediaItem[]> {
    throw new Error('not used in this test');
  }

  async listMediaPage(filters: ListFilters): Promise<PagedResult<MediaItem>> {
    const perPage = filters.perPage ?? 100;
    const page = filters.page ?? 1;
    this.requestedPages.push(page);

    const totalPages = Math.ceil(this.totalItems / perPage);
    // WordPress always answers page 1, even for an empty collection
    // (totalPages 0 with 0 items); it only 400s on page > 1 past the last page.
    if (page > 1 && page > totalPages) {
      throw new Error('rest_post_invalid_page_number');
    }

    const start = (page - 1) * perPage;
    const end = Math.min(start + perPage, this.totalItems);
    const items: MediaItem[] = [];
    for (let i = start; i < end; i++) {
      items.push(makeItem(i + 1));
    }
    return { items, total: this.totalItems, totalPages };
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
  async pruneOrphans(): Promise<never> {
    throw new Error('not used in this test');
  }
  async findReferences(_id: number, _scope: ReferenceScope): Promise<Reference[]> {
    return [];
  }
  async findUnattached(): Promise<number[]> {
    return [];
  }
}

describe('fetchAllMedia pagination', () => {
  test('stops at totalPages instead of probing one page past the end', async () => {
    const adapter = new FakePagedAdapter(200); // exact multiple of the 100-item page size
    const items = await fetchAllMedia(adapter);

    expect(items.length).toBe(200);
    expect(adapter.requestedPages).toEqual([1, 2]);
  });

  test('handles a library size that is not a multiple of the page size', async () => {
    const adapter = new FakePagedAdapter(150);
    const items = await fetchAllMedia(adapter);

    expect(items.length).toBe(150);
    expect(adapter.requestedPages).toEqual([1, 2]);
  });

  test('handles an empty library', async () => {
    const adapter = new FakePagedAdapter(0);
    const items = await fetchAllMedia(adapter);

    expect(items.length).toBe(0);
    expect(adapter.requestedPages).toEqual([1]);
  });
});

describe('find-unattached capability', () => {
  test('REST adapter throws CapabilityUnavailableError for findUnattached', async () => {
    const rest = new RestAdapter(fakeRestOnlySite);
    expect(rest.capabilities.has('find-unattached')).toBe(false);
    await expect(rest.findUnattached()).rejects.toThrow(CapabilityUnavailableError);
  });

  test('REST-only site cannot resolve find-unattached', () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    expect(resolver.tryResolve('find-unattached')).toBeNull();
  });

  test('find-unattached is included in the capability report', () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    const report = resolver.capabilityReport();
    expect(report.map((r) => r.capability)).toContain('find-unattached');
  });
});
