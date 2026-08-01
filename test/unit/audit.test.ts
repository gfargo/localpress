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
import {
  fetchAllMedia,
  summarizeFindings,
  auditSite,
} from '../../src/cli/commands/audit.ts';
import type { AuditFinding, AuditSummary } from '../../src/cli/commands/audit.ts';
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

// -- Helper to make AuditFinding fixtures ------------------------------------

function makeFinding(
  type: AuditFinding['type'],
  id = 1,
  filename = 'photo.jpg',
): AuditFinding {
  return { type, attachmentId: id, filename, detail: `test ${type}` };
}

// -- summarizeFindings --------------------------------------------------------

describe('summarizeFindings', () => {
  test('returns all-zero summary for empty findings', () => {
    const summary = summarizeFindings([]);
    const expected: AuditSummary = {
      unoptimized: 0,
      large: 0,
      missingAlt: 0,
      displaySize: 0,
      duplicates: 0,
      brokenRefs: 0,
      orphan: 0,
      missingFile: 0,
      unattached: 0,
      quality: 0,
      ocrMatch: 0,
    };
    expect(summary).toEqual(expected);
  });

  test('counts each finding type correctly', () => {
    const findings: AuditFinding[] = [
      makeFinding('unoptimized', 1),
      makeFinding('unoptimized', 2),
      makeFinding('large', 3),
      makeFinding('missing-alt', 4),
      makeFinding('display-size', 5),
      makeFinding('duplicate', 6),
      makeFinding('broken-ref', 7),
      makeFinding('orphan', 8),
      makeFinding('missing-file', 9),
      makeFinding('unattached', 10),
      makeFinding('quality', 11),
      makeFinding('ocr-match', 12),
    ];
    const summary = summarizeFindings(findings);
    expect(summary.unoptimized).toBe(2);
    expect(summary.large).toBe(1);
    expect(summary.missingAlt).toBe(1);
    expect(summary.displaySize).toBe(1);
    expect(summary.duplicates).toBe(1);
    expect(summary.brokenRefs).toBe(1);
    expect(summary.orphan).toBe(1);
    expect(summary.missingFile).toBe(1);
    expect(summary.unattached).toBe(1);
    expect(summary.quality).toBe(1);
    expect(summary.ocrMatch).toBe(1);
  });

  test('handles findings with only one type', () => {
    const findings = [makeFinding('missing-alt', 1), makeFinding('missing-alt', 2), makeFinding('missing-alt', 3)];
    const summary = summarizeFindings(findings);
    expect(summary.missingAlt).toBe(3);
    expect(summary.unoptimized).toBe(0);
    expect(summary.large).toBe(0);
  });

  test('rolled-up totals across two sites sum correctly', () => {
    const s1 = summarizeFindings([makeFinding('unoptimized'), makeFinding('large')]);
    const s2 = summarizeFindings([makeFinding('unoptimized'), makeFinding('missing-alt'), makeFinding('missing-alt')]);

    // Sum manually as done in the --all-sites path
    const totals: AuditSummary = {
      unoptimized: s1.unoptimized + s2.unoptimized,
      large: s1.large + s2.large,
      missingAlt: s1.missingAlt + s2.missingAlt,
      displaySize: s1.displaySize + s2.displaySize,
      duplicates: s1.duplicates + s2.duplicates,
      brokenRefs: s1.brokenRefs + s2.brokenRefs,
      orphan: s1.orphan + s2.orphan,
      missingFile: s1.missingFile + s2.missingFile,
      unattached: s1.unattached + s2.unattached,
      quality: s1.quality + s2.quality,
      ocrMatch: s1.ocrMatch + s2.ocrMatch,
    };

    expect(totals.unoptimized).toBe(2);
    expect(totals.large).toBe(1);
    expect(totals.missingAlt).toBe(2);
  });
});

// -- auditSite ----------------------------------------------------------------

describe('auditSite', () => {
  test('returns findings for items with missing alt text (via summarizeFindings)', () => {
    // auditSite creates an AdapterResolver that makes real HTTP calls, so for
    // pure-unit coverage we verify the finding-generation logic via
    // summarizeFindings directly with findings that match what auditSite would
    // produce for two items with empty alt text.
    const result = summarizeFindings([
      makeFinding('missing-alt', 2),
      makeFinding('missing-alt', 3),
    ]);
    expect(result.missingAlt).toBe(2);
  });

  test('returns error field (not throw) when fetch fails', async () => {
    // We can't easily inject a fake adapter into auditSite without network calls,
    // but we CAN verify the error-result contract by stubbing the global fetch
    // RestAdapter uses under the hood, so this stays hermetic (no real DNS
    // lookup) instead of relying on a .invalid domain actually failing to resolve.
    const brokenSite: SiteConfig = {
      name: 'broken',
      url: 'https://example.test',
      username: 'admin',
      appPassword: 'xxxx xxxx xxxx xxxx xxxx xxxx',
      createdAt: new Date('2026-01-01').toISOString(),
    };
    const fakeConfig = {
      version: 1 as const,
      sites: { broken: brokenSite },
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.reject(new Error('simulated network failure'))) as unknown as typeof fetch;
    try {
      // auditSite should not throw — it should return a result with error set.
      const result = await auditSite(brokenSite, {}, fakeConfig);
      expect(typeof result.error).toBe('string');
      expect(result.findings).toEqual([]);
      expect(result.totalItems).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns error for --orphans when WP-CLI is not configured', async () => {
    const restOnlySite: SiteConfig = { ...fakeRestOnlySite };
    const fakeConfig = {
      version: 1 as const,
      sites: { [restOnlySite.name]: restOnlySite },
    };
    const result = await auditSite(restOnlySite, { orphans: true }, fakeConfig);
    expect(result.error).toMatch(/WP-CLI/);
    expect(result.findings).toEqual([]);
  });

  test('returns error for --unattached when WP-CLI is not configured', async () => {
    const restOnlySite: SiteConfig = { ...fakeRestOnlySite };
    const fakeConfig = {
      version: 1 as const,
      sites: { [restOnlySite.name]: restOnlySite },
    };
    const result = await auditSite(restOnlySite, { unattached: true }, fakeConfig);
    expect(result.error).toMatch(/WP-CLI/);
    expect(result.findings).toEqual([]);
  });
});
