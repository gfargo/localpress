/**
 * Unit tests for the stats dashboard database methods.
 *
 * Tests getLibraryOverview, getFormatBreakdown, and getRecentOperations
 * against an in-memory SQLite database with seeded data.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SiteDb } from '../../src/engine/state/db.ts';

const SITE_NAME = 'test-site';
const SITE_URL = 'https://example.test';

let db: SiteDb;

beforeEach(() => {
  db = SiteDb.init(':memory:');
  db.ensureSite(SITE_NAME, SITE_URL);
});

afterEach(() => {
  db.close();
});

// -- Helpers ------------------------------------------------------------------

function seedAttachments(
  items: Array<{ wpId: number; mimeType: string; sizeBytes: number }>,
): void {
  for (const item of items) {
    db.upsertAttachment({
      siteName: SITE_NAME,
      wpId: item.wpId,
      sourceUrl: `https://example.test/wp-content/uploads/img-${item.wpId}.jpg`,
      sourceHash: `hash-${item.wpId}`,
      sizeBytes: item.sizeBytes,
      width: 1920,
      height: 1080,
      mimeType: item.mimeType,
      lastSeenAt: Date.now(),
    });
  }
}

function seedProcessing(
  items: Array<{
    wpId: number;
    operation: string;
    bytesBefore: number;
    bytesAfter: number;
    ranAt?: number;
    status?: 'success' | 'failure';
  }>,
): void {
  for (const item of items) {
    db.recordProcessing({
      siteName: SITE_NAME,
      wpId: item.wpId,
      operation: item.operation,
      paramsJson: null,
      sourceHash: `hash-${item.wpId}`,
      resultHash: `result-${item.wpId}`,
      bytesBefore: item.bytesBefore,
      bytesAfter: item.bytesAfter,
      resultWpId: null,
      ranAt: item.ranAt ?? Date.now(),
      durationMs: 150,
      status: item.status ?? 'success',
      errorMessage: null,
    });
  }
}

// -- getLibraryOverview -------------------------------------------------------

describe('getLibraryOverview', () => {
  test('returns zeros when no attachments exist', () => {
    const overview = db.getLibraryOverview(SITE_NAME);
    expect(overview.totalAttachments).toBe(0);
    expect(overview.totalSizeBytes).toBe(0);
    expect(overview.optimized).toBe(0);
    expect(overview.unoptimized).toBe(0);
  });

  test('counts total attachments and size', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 500_000 },
      { wpId: 2, mimeType: 'image/png', sizeBytes: 300_000 },
      { wpId: 3, mimeType: 'image/webp', sizeBytes: 200_000 },
    ]);

    const overview = db.getLibraryOverview(SITE_NAME);
    expect(overview.totalAttachments).toBe(3);
    expect(overview.totalSizeBytes).toBe(1_000_000);
  });

  test('correctly identifies optimized vs unoptimized', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 500_000 },
      { wpId: 2, mimeType: 'image/png', sizeBytes: 300_000 },
      { wpId: 3, mimeType: 'image/webp', sizeBytes: 200_000 },
    ]);

    // Only process items 1 and 2
    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 500_000, bytesAfter: 300_000 },
      { wpId: 2, operation: 'optimize', bytesBefore: 300_000, bytesAfter: 150_000 },
    ]);

    const overview = db.getLibraryOverview(SITE_NAME);
    expect(overview.optimized).toBe(2);
    expect(overview.unoptimized).toBe(1);
  });

  test('failed operations do not count as optimized', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 500_000 },
      { wpId: 2, mimeType: 'image/png', sizeBytes: 300_000 },
    ]);

    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 500_000, bytesAfter: 300_000 },
      {
        wpId: 2,
        operation: 'optimize',
        bytesBefore: 300_000,
        bytesAfter: 300_000,
        status: 'failure',
      },
    ]);

    const overview = db.getLibraryOverview(SITE_NAME);
    expect(overview.optimized).toBe(1);
    expect(overview.unoptimized).toBe(1);
  });
});

// -- getStats -----------------------------------------------------------------

describe('getStats', () => {
  test('excludes failed operations from avgDurationMs, bytesIn, and bytesOut', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 500_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 500_000 },
    ]);

    db.recordProcessing({
      siteName: SITE_NAME,
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h1',
      resultHash: 'h2',
      bytesBefore: 500_000,
      bytesAfter: 300_000,
      resultWpId: null,
      ranAt: Date.now(),
      durationMs: 100,
      status: 'success',
      errorMessage: null,
    });

    // A failure with a huge duration/byte delta that must not pollute the
    // success-only aggregates.
    db.recordProcessing({
      siteName: SITE_NAME,
      wpId: 2,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h3',
      resultHash: null,
      bytesBefore: 9_000_000,
      bytesAfter: 9_000_000,
      resultWpId: null,
      ranAt: Date.now(),
      durationMs: 60_000,
      status: 'failure',
      errorMessage: 'codec error',
    });

    const stats = db.getStats(SITE_NAME);
    const op = stats.byOperation.find((o) => o.operation === 'optimize');
    expect(op).toBeDefined();
    expect(op?.avgDurationMs).toBe(100);
    expect(op?.bytesIn).toBe(500_000);
    expect(op?.bytesOut).toBe(300_000);
    expect(op?.bytesSaved).toBe(200_000);

    expect(stats.bytesIn).toBe(500_000);
    expect(stats.bytesSaved).toBe(200_000);
  });
});

// -- getFormatBreakdown -------------------------------------------------------

describe('getFormatBreakdown', () => {
  test('returns empty array when no attachments exist', () => {
    const formats = db.getFormatBreakdown(SITE_NAME);
    expect(formats).toHaveLength(0);
  });

  test('groups by MIME type and counts correctly', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 100_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 200_000 },
      { wpId: 3, mimeType: 'image/jpeg', sizeBytes: 150_000 },
      { wpId: 4, mimeType: 'image/png', sizeBytes: 300_000 },
      { wpId: 5, mimeType: 'image/webp', sizeBytes: 80_000 },
      { wpId: 6, mimeType: 'image/webp', sizeBytes: 90_000 },
    ]);

    const formats = db.getFormatBreakdown(SITE_NAME);
    expect(formats).toHaveLength(3);

    // Ordered by count DESC
    expect(formats[0].mimeType).toBe('image/jpeg');
    expect(formats[0].count).toBe(3);
    expect(formats[1].mimeType).toBe('image/webp');
    expect(formats[1].count).toBe(2);
    expect(formats[2].mimeType).toBe('image/png');
    expect(formats[2].count).toBe(1);
  });

  test('excludes attachments with null mime_type', () => {
    seedAttachments([{ wpId: 1, mimeType: 'image/jpeg', sizeBytes: 100_000 }]);
    // Insert one with null mime_type directly
    db.upsertAttachment({
      siteName: SITE_NAME,
      wpId: 99,
      sourceUrl: 'https://example.test/file.bin',
      sourceHash: null,
      sizeBytes: 50_000,
      width: null,
      height: null,
      mimeType: null,
      lastSeenAt: Date.now(),
    });

    const formats = db.getFormatBreakdown(SITE_NAME);
    expect(formats).toHaveLength(1);
    expect(formats[0].mimeType).toBe('image/jpeg');
  });
});

// -- getRecentOperations ------------------------------------------------------

describe('getRecentOperations', () => {
  test('returns empty array when no processing history exists', () => {
    const recent = db.getRecentOperations(SITE_NAME);
    expect(recent).toHaveLength(0);
  });

  test('groups operations by date and operation type', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 500_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 400_000 },
      { wpId: 3, mimeType: 'image/png', sizeBytes: 300_000 },
    ]);

    const today = Date.now();
    const yesterday = today - 86_400_000;

    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 500_000, bytesAfter: 300_000, ranAt: today },
      { wpId: 2, operation: 'optimize', bytesBefore: 400_000, bytesAfter: 250_000, ranAt: today },
      {
        wpId: 3,
        operation: 'convert',
        bytesBefore: 300_000,
        bytesAfter: 100_000,
        ranAt: yesterday,
      },
    ]);

    const recent = db.getRecentOperations(SITE_NAME);
    expect(recent.length).toBeGreaterThanOrEqual(2);

    // Most recent first
    const todayOp = recent.find((r) => r.operation === 'optimize');
    expect(todayOp).toBeDefined();
    expect(todayOp?.itemCount).toBe(2);
    expect(todayOp?.bytesSaved).toBe(350_000); // (500k-300k) + (400k-250k)
  });

  test('respects limit parameter', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 100_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 100_000 },
      { wpId: 3, mimeType: 'image/jpeg', sizeBytes: 100_000 },
    ]);

    const day1 = Date.now() - 86_400_000 * 3;
    const day2 = Date.now() - 86_400_000 * 2;
    const day3 = Date.now() - 86_400_000;

    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 100_000, bytesAfter: 50_000, ranAt: day1 },
      { wpId: 2, operation: 'convert', bytesBefore: 100_000, bytesAfter: 60_000, ranAt: day2 },
      { wpId: 3, operation: 'resize', bytesBefore: 100_000, bytesAfter: 40_000, ranAt: day3 },
    ]);

    const recent = db.getRecentOperations(SITE_NAME, 2);
    expect(recent).toHaveLength(2);
  });

  test('excludes failed operations', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 100_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 100_000 },
    ]);

    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 100_000, bytesAfter: 50_000 },
      {
        wpId: 2,
        operation: 'optimize',
        bytesBefore: 100_000,
        bytesAfter: 100_000,
        status: 'failure',
      },
    ]);

    const recent = db.getRecentOperations(SITE_NAME);
    // Only the successful one should appear
    const totalItems = recent.reduce((sum, r) => sum + r.itemCount, 0);
    expect(totalItems).toBe(1);
  });

  test('excludes reverted operations', () => {
    seedAttachments([
      { wpId: 1, mimeType: 'image/jpeg', sizeBytes: 100_000 },
      { wpId: 2, mimeType: 'image/jpeg', sizeBytes: 100_000 },
    ]);

    seedProcessing([
      { wpId: 1, operation: 'optimize', bytesBefore: 100_000, bytesAfter: 50_000 },
      { wpId: 2, operation: 'optimize', bytesBefore: 100_000, bytesAfter: 40_000 },
    ]);

    db.markProcessingReverted(SITE_NAME, 2, 'optimize');

    const recent = db.getRecentOperations(SITE_NAME);
    const totalItems = recent.reduce((sum, r) => sum + r.itemCount, 0);
    expect(totalItems).toBe(1);

    const optimizeOp = recent.find((r) => r.operation === 'optimize');
    expect(optimizeOp?.bytesSaved).toBe(50_000);
  });
});
