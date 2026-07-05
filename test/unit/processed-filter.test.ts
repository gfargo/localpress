/**
 * Unit test for listProcessedWpIds(operation) — `optimize --unoptimized` must
 * only skip images that were actually compressed, not ones a caption/classify
 * pass touched (#98).
 */

import { describe, expect, test } from 'bun:test';
import { SiteDb } from '../../src/engine/state/db.ts';

function seed(db: SiteDb, wpId: number, operation: string) {
  db.upsertAttachment({
    siteName: 'site',
    wpId,
    sourceUrl: `https://example.test/${wpId}.jpg`,
    sourceHash: null,
    sizeBytes: null,
    width: null,
    height: null,
    mimeType: 'image/jpeg',
    lastSeenAt: Date.now(),
  });
  db.recordProcessing({
    siteName: 'site',
    wpId,
    operation,
    paramsJson: '{}',
    sourceHash: null,
    resultHash: null,
    bytesBefore: null,
    bytesAfter: null,
    resultWpId: null,
    ranAt: Date.now(),
    durationMs: 1,
    status: 'success',
    errorMessage: null,
  });
}

describe('listProcessedWpIds', () => {
  test('operation filter excludes caption-only history from "optimized"', () => {
    const db = SiteDb.init(':memory:');
    db.ensureSite('site', 'https://example.test');

    seed(db, 1, 'optimize');
    seed(db, 2, 'caption');
    seed(db, 3, 'classify');
    seed(db, 4, 'convert');

    // No filter: every processed id, regardless of operation.
    const all = db.listProcessedWpIds('site');
    expect([...all].sort()).toEqual([1, 2, 3, 4]);

    // Compression-only filter: caption/classify must NOT count as optimized.
    const optimized = db.listProcessedWpIds('site', ['optimize', 'convert', 'resize']);
    expect([...optimized].sort()).toEqual([1, 4]);
    expect(optimized.has(2)).toBe(false);
    expect(optimized.has(3)).toBe(false);

    db.close();
  });
});
