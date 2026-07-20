/**
 * Regression test for runBulkVision's result accounting: preflight-skipped
 * items (e.g. non-image attachments) must be pushed into `results` just like
 * idempotent skips are, so `processed + skipped + failures` always sums to
 * the number of attempted IDs.
 */

import { describe, expect, test } from 'bun:test';
import type { MediaItem, WpBackend } from '../../src/adapters/types.ts';
import { runBulkVision } from '../../src/engine/caption/run-bulk.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

function makeMediaItem(id: number, mimeType: string): MediaItem {
  return {
    id,
    title: `item-${id}`,
    filename: `item-${id}.bin`,
    url: `https://example.test/wp-content/uploads/item-${id}.bin`,
    mimeType,
    uploadedAt: new Date(0).toISOString(),
  };
}

function makeFakeAdapter(items: Map<number, MediaItem>): WpBackend {
  return {
    name: 'rest',
    capabilities: new Set(),
    getMedia: async (id: number) => {
      const item = items.get(id);
      if (!item) throw new Error(`no such item: ${id}`);
      return item;
    },
    updateMetadata: async () => {},
  } as unknown as WpBackend;
}

describe('runBulkVision — result accounting', () => {
  test('preflight-skipped items are counted in `skipped` and appear in `results`', async () => {
    const db = SiteDb.init(':memory:');
    db.ensureSite('test-site', 'https://example.test');

    // Mix of images (processed) and a non-image (preflight-skipped).
    const items = new Map<number, MediaItem>([
      [1, makeMediaItem(1, 'image/png')],
      [2, makeMediaItem(2, 'application/pdf')],
      [3, makeMediaItem(3, 'image/png')],
    ]);
    const adapter = makeFakeAdapter(items);

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
      // 1x1 transparent PNG — enough for the image pipeline to accept.
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI6QAAAABJRU5ErkJggg==',
        'base64',
      );
      return new Response(png, { status: 200 });
    }) as typeof fetch;

    try {
      const result = await runBulkVision({
        ids: [1, 2, 3],
        isDryRun: true,
        effectiveModel: 'test-model',
        ollamaUrl: 'http://localhost:11434',
        getAdapter: adapter,
        metaAdapter: adapter,
        db,
        siteName: 'test-site',
        siteUrl: 'https://example.test',
        configDir: '/tmp/does-not-matter',
        historyEnabled: false,
        historyMaxSizeBytes: 0,
        options: {
          kind: 'alt',
          operation: 'caption',
          buildUpdate: (generated) => ({ altText: generated }),
          readPrevious: () => undefined,
          overwrite: false,
          preflightSkip: (item) =>
            item.mimeType.startsWith('image/') ? undefined : 'not an image',
        },
        onItemStart: () => {},
        onItemSuccess: () => {},
        onItemSkip: () => {},
        onItemError: () => {},
      });

      expect(result.processed + result.skipped + result.failures).toBe(3);
      expect(result.skipped).toBe(1);

      const skippedIds = result.results.filter((r) => r.skipped).map((r) => r.id);
      expect(skippedIds).toEqual([2]);
    } finally {
      globalThis.fetch = realFetch;
      db.close();
    }
  });
});
