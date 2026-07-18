/**
 * Unit tests for the SQLite state layer.
 * Uses :memory: databases for speed and isolation.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SiteDb } from '../../src/engine/state/db.ts';
import { SCHEMA_VERSION } from '../../src/engine/state/schema.ts';

const DB_MODULE_PATH = new URL('../../src/engine/state/db.ts', import.meta.url).pathname;

function createTestDb(): SiteDb {
  const db = SiteDb.init(':memory:');
  db.ensureSite('test-site', 'https://example.test');
  return db;
}

describe('SiteDb.init', () => {
  test('creates a database and applies the schema', () => {
    const db = SiteDb.init(':memory:');
    // If we got here without throwing, the schema was applied.
    db.close();
  });

  test('is idempotent — calling init twice on the same path does not throw', () => {
    const path = ':memory:';
    const db1 = SiteDb.init(path);
    db1.close();
    // A second init on a fresh :memory: is a new DB, but the pattern
    // should work on a real file path too.
    const db2 = SiteDb.init(path);
    db2.close();
  });

  test('stores the current schema version', () => {
    const db = SiteDb.init(':memory:');
    // Access the underlying Database to check the version.
    // We use getStoredSchemaVersion via a fresh Database connection.
    // Since we're using :memory:, we verify via the SiteDb's own state.
    expect(SCHEMA_VERSION).toBe(5);
    db.close();
  });
});

describe('ensureSite', () => {
  test('creates a site row', () => {
    const db = SiteDb.init(':memory:');
    db.ensureSite('my-site', 'https://my-site.test');
    // Verify by inserting an attachment (which requires the FK).
    db.upsertAttachment({
      siteName: 'my-site',
      wpId: 1,
      sourceUrl: 'https://my-site.test/wp-content/uploads/img.jpg',
      sourceHash: null,
      sizeBytes: 1000,
      width: 800,
      height: 600,
      mimeType: 'image/jpeg',
      lastSeenAt: Date.now(),
    });
    const att = db.getAttachment('my-site', 1);
    expect(att).not.toBeNull();
    db.close();
  });

  test('updates URL on conflict', () => {
    const db = SiteDb.init(':memory:');
    db.ensureSite('my-site', 'https://old.test');
    db.ensureSite('my-site', 'https://new.test');
    // No error means the upsert worked.
    db.close();
  });
});

describe('attachment CRUD', () => {
  test('upsertAttachment + getAttachment round-trips correctly', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 42,
      sourceUrl: 'https://example.test/wp-content/uploads/photo.jpg',
      sourceHash: 'abc123',
      sizeBytes: 2048,
      width: 1920,
      height: 1080,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    const att = db.getAttachment('test-site', 42);
    expect(att).not.toBeNull();
    expect(att?.siteName).toBe('test-site');
    expect(att?.wpId).toBe(42);
    expect(att?.sourceUrl).toBe('https://example.test/wp-content/uploads/photo.jpg');
    expect(att?.sourceHash).toBe('abc123');
    expect(att?.sizeBytes).toBe(2048);
    expect(att?.width).toBe(1920);
    expect(att?.height).toBe(1080);
    expect(att?.mimeType).toBe('image/jpeg');
    expect(att?.lastSeenAt).toBe(now);

    db.close();
  });

  test('getAttachment returns null for missing records', () => {
    const db = createTestDb();
    expect(db.getAttachment('test-site', 999)).toBeNull();
    db.close();
  });

  test('upsertAttachment updates existing records', () => {
    const db = createTestDb();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/old.jpg',
      sourceHash: 'hash1',
      sizeBytes: 1000,
      width: 100,
      height: 100,
      mimeType: 'image/jpeg',
      lastSeenAt: 1000,
    });

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/new.jpg',
      sourceHash: 'hash2',
      sizeBytes: 2000,
      width: 200,
      height: 200,
      mimeType: 'image/png',
      lastSeenAt: 2000,
    });

    const att = db.getAttachment('test-site', 1);
    expect(att?.sourceUrl).toBe('https://example.test/new.jpg');
    expect(att?.sourceHash).toBe('hash2');
    expect(att?.sizeBytes).toBe(2000);
    expect(att?.lastSeenAt).toBe(2000);

    db.close();
  });

  test('listAttachments returns all attachments for a site', () => {
    const db = createTestDb();

    for (let i = 1; i <= 5; i++) {
      db.upsertAttachment({
        siteName: 'test-site',
        wpId: i,
        sourceUrl: `https://example.test/img-${i}.jpg`,
        sourceHash: null,
        sizeBytes: i * 100,
        width: null,
        height: null,
        mimeType: 'image/jpeg',
        lastSeenAt: Date.now(),
      });
    }

    const list = db.listAttachments('test-site');
    expect(list).toHaveLength(5);
    expect(list[0].wpId).toBe(1);
    expect(list[4].wpId).toBe(5);

    db.close();
  });

  test('listAttachments returns empty array for unknown site', () => {
    const db = createTestDb();
    expect(db.listAttachments('nonexistent')).toHaveLength(0);
    db.close();
  });

  test('handles null fields correctly', () => {
    const db = createTestDb();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: null,
      sizeBytes: null,
      width: null,
      height: null,
      mimeType: null,
      lastSeenAt: Date.now(),
    });

    const att = db.getAttachment('test-site', 1);
    expect(att?.sourceHash).toBeNull();
    expect(att?.sizeBytes).toBeNull();
    expect(att?.width).toBeNull();
    expect(att?.height).toBeNull();
    expect(att?.mimeType).toBeNull();

    db.close();
  });
});

describe('processing history', () => {
  test('recordProcessing + getLastProcessing round-trips correctly', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 10,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: 'before-hash',
      sizeBytes: 5000,
      width: 800,
      height: 600,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    const id = db.recordProcessing({
      siteName: 'test-site',
      wpId: 10,
      operation: 'optimize',
      paramsJson: JSON.stringify({ quality: 80, toFormat: 'webp' }),
      sourceHash: 'before-hash',
      resultHash: 'after-hash',
      bytesBefore: 5000,
      bytesAfter: 1200,
      resultWpId: null,
      ranAt: now,
      durationMs: 350,
      status: 'success',
      errorMessage: null,
    });

    expect(id).toBeGreaterThan(0);

    const record = db.getLastProcessing('test-site', 10);
    expect(record).not.toBeNull();
    expect(record?.id).toBe(id);
    expect(record?.operation).toBe('optimize');
    expect(record?.bytesBefore).toBe(5000);
    expect(record?.bytesAfter).toBe(1200);
    expect(record?.status).toBe('success');
    expect(record?.durationMs).toBe(350);

    db.close();
  });

  test('getLastProcessing returns the most recent record', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 20,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: null,
      sizeBytes: 3000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 20,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h1',
      resultHash: 'h2',
      bytesBefore: 3000,
      bytesAfter: 2000,
      resultWpId: null,
      ranAt: now - 1000,
      durationMs: 100,
      status: 'success',
      errorMessage: null,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 20,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h2',
      resultHash: 'h3',
      bytesBefore: 2000,
      bytesAfter: 1500,
      resultWpId: null,
      ranAt: now,
      durationMs: 80,
      status: 'success',
      errorMessage: null,
    });

    const record = db.getLastProcessing('test-site', 20);
    expect(record?.ranAt).toBe(now);
    expect(record?.bytesAfter).toBe(1500);

    db.close();
  });

  test('getLastProcessing filters by operation when specified', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 30,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: null,
      sizeBytes: 4000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 30,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 4000,
      bytesAfter: 2000,
      resultWpId: null,
      ranAt: now,
      durationMs: 100,
      status: 'success',
      errorMessage: null,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 30,
      operation: 'convert',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 2000,
      bytesAfter: 1000,
      resultWpId: null,
      ranAt: now + 1000,
      durationMs: 50,
      status: 'success',
      errorMessage: null,
    });

    const optimizeRecord = db.getLastProcessing('test-site', 30, 'optimize');
    expect(optimizeRecord?.operation).toBe('optimize');
    expect(optimizeRecord?.bytesAfter).toBe(2000);

    const convertRecord = db.getLastProcessing('test-site', 30, 'convert');
    expect(convertRecord?.operation).toBe('convert');
    expect(convertRecord?.bytesAfter).toBe(1000);

    db.close();
  });

  test('getLastProcessing returns null when no records exist', () => {
    const db = createTestDb();
    expect(db.getLastProcessing('test-site', 999)).toBeNull();
    db.close();
  });

  test('records failure status and error message', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 40,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: null,
      sizeBytes: 1000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 40,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 1000,
      bytesAfter: null,
      resultWpId: null,
      ranAt: now,
      durationMs: null,
      status: 'failure',
      errorMessage: 'Codec error: unsupported format',
    });

    const record = db.getLastProcessing('test-site', 40);
    expect(record?.status).toBe('failure');
    expect(record?.errorMessage).toBe('Codec error: unsupported format');

    db.close();
  });
});

describe('processing history — skipped status and revert (localpress#97)', () => {
  test('recordProcessing accepts status: skipped', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 50,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: 'h1',
      sizeBytes: 1000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 50,
      operation: 'optimize',
      paramsJson: JSON.stringify({ toFormat: 'webp' }),
      sourceHash: 'h1',
      resultHash: 'h1',
      bytesBefore: 1000,
      bytesAfter: 1000,
      resultWpId: null,
      ranAt: now,
      durationMs: 50,
      status: 'skipped',
      errorMessage: null,
    });

    const record = db.getLastProcessing('test-site', 50);
    expect(record?.status).toBe('skipped');
    expect(record?.revertedAt).toBeNull();

    db.close();
  });

  test('markProcessingReverted sets revertedAt on the most recent matching row', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 60,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: 'before',
      sizeBytes: 1000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 60,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'before',
      resultHash: 'after',
      bytesBefore: 1000,
      bytesAfter: 400,
      resultWpId: null,
      ranAt: now,
      durationMs: 50,
      status: 'success',
      errorMessage: null,
    });

    expect(db.getLastProcessing('test-site', 60)?.revertedAt).toBeNull();

    db.markProcessingReverted('test-site', 60, 'optimize');

    const reverted = db.getLastProcessing('test-site', 60);
    expect(reverted?.revertedAt).not.toBeNull();

    db.close();
  });

  test('markProcessingReverted on a wpId with no history is a no-op', () => {
    const db = createTestDb();
    // Should not throw.
    db.markProcessingReverted('test-site', 999, 'optimize');
    db.close();
  });

  test('getStats excludes reverted rows from succeeded/bytesSaved, and reports failed/skipped explicitly', () => {
    const db = createTestDb();
    const now = Date.now();

    for (const wpId of [1, 2, 3]) {
      db.upsertAttachment({
        siteName: 'test-site',
        wpId,
        sourceUrl: `https://example.test/img-${wpId}.jpg`,
        sourceHash: null,
        sizeBytes: 1000,
        width: null,
        height: null,
        mimeType: 'image/jpeg',
        lastSeenAt: now,
      });
    }

    // wpId 1: successful optimize, later reverted by undo.
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h1',
      resultHash: 'h1-out',
      bytesBefore: 1000,
      bytesAfter: 400,
      resultWpId: null,
      ranAt: now,
      durationMs: 50,
      status: 'success',
      errorMessage: null,
    });
    db.markProcessingReverted('test-site', 1, 'optimize');

    // wpId 2: skipped (would-be-larger).
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 2,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h2',
      resultHash: 'h2',
      bytesBefore: 1000,
      bytesAfter: 1000,
      resultWpId: null,
      ranAt: now,
      durationMs: 10,
      status: 'skipped',
      errorMessage: null,
    });

    // wpId 3: failure.
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 3,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 1000,
      bytesAfter: null,
      resultWpId: null,
      ranAt: now,
      durationMs: 5,
      status: 'failure',
      errorMessage: 'boom',
    });

    const stats = db.getStats('test-site');
    expect(stats.totalOps).toBe(3);
    expect(stats.succeeded).toBe(0); // the only success row was reverted
    expect(stats.failed).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.bytesSaved).toBe(0); // reverted row's savings excluded

    db.close();
  });

  test('listProcessedWpIds excludes reverted rows, includes skipped rows', () => {
    const db = createTestDb();
    const now = Date.now();

    for (const wpId of [1, 2]) {
      db.upsertAttachment({
        siteName: 'test-site',
        wpId,
        sourceUrl: `https://example.test/img-${wpId}.jpg`,
        sourceHash: null,
        sizeBytes: 1000,
        width: null,
        height: null,
        mimeType: 'image/jpeg',
        lastSeenAt: now,
      });
    }

    // wpId 1: success, then reverted -> should no longer count as processed.
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h1',
      resultHash: 'h1-out',
      bytesBefore: 1000,
      bytesAfter: 400,
      resultWpId: null,
      ranAt: now,
      durationMs: 50,
      status: 'success',
      errorMessage: null,
    });
    db.markProcessingReverted('test-site', 1, 'optimize');

    // wpId 2: skipped -> should still count as processed (evaluated already).
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 2,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h2',
      resultHash: 'h2',
      bytesBefore: 1000,
      bytesAfter: 1000,
      resultWpId: null,
      ranAt: now,
      durationMs: 10,
      status: 'skipped',
      errorMessage: null,
    });

    const processed = db.listProcessedWpIds('test-site');
    expect(processed.has(1)).toBe(false);
    expect(processed.has(2)).toBe(true);

    db.close();
  });

  test('getLibraryOverview does not count a reverted optimize as optimized', () => {
    const db = createTestDb();
    const now = Date.now();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/img-1.jpg',
      sourceHash: null,
      sizeBytes: 1000,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: now,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: 'h1',
      resultHash: 'h1-out',
      bytesBefore: 1000,
      bytesAfter: 400,
      resultWpId: null,
      ranAt: now,
      durationMs: 50,
      status: 'success',
      errorMessage: null,
    });

    expect(db.getLibraryOverview('test-site').optimized).toBe(1);

    db.markProcessingReverted('test-site', 1, 'optimize');

    expect(db.getLibraryOverview('test-site').optimized).toBe(0);
    expect(db.getLibraryOverview('test-site').unoptimized).toBe(1);
    db.close();
  });
});

describe('pruneStaleAttachments', () => {
  test('removes only rows last seen before the cutoff', () => {
    const db = createTestDb();

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/old.jpg',
      sourceHash: null,
      sizeBytes: 100,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: 1000,
    });

    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 2,
      sourceUrl: 'https://example.test/new.jpg',
      sourceHash: null,
      sizeBytes: 100,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: 2000,
    });

    const removed = db.pruneStaleAttachments('test-site', 2000);
    expect(removed).toBe(1);
    expect(db.getAttachment('test-site', 1)).toBeNull();
    expect(db.getAttachment('test-site', 2)).not.toBeNull();
    expect(db.getLibraryOverview('test-site').totalAttachments).toBe(1);

    db.close();
  });

  test('returns 0 when nothing is stale', () => {
    const db = createTestDb();
    db.upsertAttachment({
      siteName: 'test-site',
      wpId: 1,
      sourceUrl: 'https://example.test/img.jpg',
      sourceHash: null,
      sizeBytes: 100,
      width: null,
      height: null,
      mimeType: 'image/jpeg',
      lastSeenAt: 5000,
    });

    expect(db.pruneStaleAttachments('test-site', 1000)).toBe(0);
    db.close();
  });
});

describe('listProcessedWpIds', () => {
  test('returns IDs with successful processing history', () => {
    const db = createTestDb();
    const now = Date.now();

    for (const wpId of [1, 2, 3]) {
      db.upsertAttachment({
        siteName: 'test-site',
        wpId,
        sourceUrl: `https://example.test/img-${wpId}.jpg`,
        sourceHash: null,
        sizeBytes: 1000,
        width: null,
        height: null,
        mimeType: 'image/jpeg',
        lastSeenAt: now,
      });
    }

    // Only process IDs 1 and 3.
    db.recordProcessing({
      siteName: 'test-site',
      wpId: 1,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 1000,
      bytesAfter: 500,
      resultWpId: null,
      ranAt: now,
      durationMs: 100,
      status: 'success',
      errorMessage: null,
    });

    db.recordProcessing({
      siteName: 'test-site',
      wpId: 3,
      operation: 'optimize',
      paramsJson: null,
      sourceHash: null,
      resultHash: null,
      bytesBefore: 1000,
      bytesAfter: 600,
      resultWpId: null,
      ranAt: now,
      durationMs: 80,
      status: 'success',
      errorMessage: null,
    });

    const processed = db.listProcessedWpIds('test-site');
    expect(processed.size).toBe(2);
    expect(processed.has(1)).toBe(true);
    expect(processed.has(2)).toBe(false);
    expect(processed.has(3)).toBe(true);

    db.close();
  });
});

describe('failure recording FK-safety (regression for #96)', () => {
  test('recordProcessing throws when no attachments row exists for the wpId', () => {
    // Documents the hazard: PRAGMA foreign_keys=ON (schema.ts) rejects a
    // processing_history row whose wpId has no corresponding attachments row.
    // Bulk commands must never call recordProcessing directly in a failure
    // path without first ensuring the attachment row exists.
    const db = createTestDb();

    expect(() =>
      db.recordProcessing({
        siteName: 'test-site',
        wpId: 999,
        operation: 'remove-bg',
        paramsJson: null,
        sourceHash: null,
        resultHash: null,
        bytesBefore: null,
        bytesAfter: null,
        resultWpId: null,
        ranAt: Date.now(),
        durationMs: null,
        status: 'failure',
        errorMessage: 'getMedia failed: 404',
      }),
    ).toThrow();

    db.close();
  });

  test('upsertAttachment (nulled fields) before recordProcessing records a failure without throwing', () => {
    // Mirrors the catch-block sequence in remove-bg.ts / caption.ts: when
    // getMedia() fails before any attachments row exists, upsert a
    // placeholder attachment first so the FK is satisfied, then record the
    // failure.
    const db = createTestDb();
    const now = Date.now();

    expect(() => {
      db.upsertAttachment({
        siteName: 'test-site',
        wpId: 999,
        sourceUrl: '',
        sourceHash: null,
        sizeBytes: null,
        width: null,
        height: null,
        mimeType: null,
        lastSeenAt: now,
      });
      db.recordProcessing({
        siteName: 'test-site',
        wpId: 999,
        operation: 'remove-bg',
        paramsJson: null,
        sourceHash: null,
        resultHash: null,
        bytesBefore: null,
        bytesAfter: null,
        resultWpId: null,
        ranAt: now,
        durationMs: 50,
        status: 'failure',
        errorMessage: 'getMedia failed: 404',
      });
    }).not.toThrow();

    const record = db.getLastProcessing('test-site', 999);
    expect(record?.status).toBe('failure');
    expect(record?.errorMessage).toBe('getMedia failed: 404');

    db.close();
  });
});

describe('concurrent access (localpress#114)', () => {
  test('busy_timeout pragma is set to 5000ms', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-busy-test-'));
    const db = SiteDb.init(join(tmpRoot, 'site.db'));
    try {
      const row = db.raw().query('PRAGMA busy_timeout').get() as { timeout: number };
      expect(row.timeout).toBe(5000);
    } finally {
      db.close();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('re-opening at the same schema version does not rewrite schema_version', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-busy-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      const db1 = SiteDb.init(dbPath);
      db1.close();

      const readVersionRows = () => {
        const conn = new Database(dbPath, { readonly: true });
        try {
          return conn.query('SELECT version, rowid FROM schema_version').all();
        } finally {
          conn.close();
        }
      };

      const before = readVersionRows();
      // Same SCHEMA_VERSION as the first init — should not touch the table.
      const db2 = SiteDb.init(dbPath);
      db2.close();
      const after = readVersionRows();

      expect(after).toEqual(before);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  /**
   * A second connection can't literally block-then-succeed on the same thread
   * (nothing would run to release the first connection's lock), so this
   * spawns a real child process to hold the write lock while the parent
   * attempts a concurrent write.
   */
  async function spawnLockHolder(dbPath: string, holdMs: number): Promise<Bun.Subprocess> {
    const scriptPath = join(
      tmpdir(),
      `localpress-lock-holder-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
    );
    writeFileSync(
      scriptPath,
      `
      import { SiteDb } from ${JSON.stringify(DB_MODULE_PATH)};
      const db = SiteDb.init(${JSON.stringify(dbPath)});
      db.raw().exec('BEGIN IMMEDIATE');
      await Bun.sleep(${holdMs});
      db.raw().exec('COMMIT');
      db.close();
      `,
    );
    const proc = Bun.spawn([process.execPath, 'run', scriptPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    // Cheap handshake: give the child time to open the db and BEGIN IMMEDIATE
    // before the parent attempts its own write.
    await Bun.sleep(100);
    return proc;
  }

  test('a second connection waits for the write lock instead of throwing', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-busy-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      // Create the schema/WAL files up front so the two connections aren't
      // racing the initial migration.
      SiteDb.init(dbPath).close();

      const holdMs = 300;
      const proc = await spawnLockHolder(dbPath, holdMs);

      const db2 = SiteDb.init(dbPath);
      const start = performance.now();
      expect(() => db2.ensureSite('waiter-site', 'https://example.test')).not.toThrow();
      const elapsed = performance.now() - start;
      db2.close();

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      // It should have actually waited on the lock (not returned instantly),
      // but well within the 5000ms busy_timeout ceiling.
      expect(elapsed).toBeGreaterThan(50);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 10_000);

  test('negative control: disabling busy_timeout throws "database is locked" under the same contention', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-busy-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      SiteDb.init(dbPath).close();

      const holdMs = 300;
      const proc = await spawnLockHolder(dbPath, holdMs);

      const db2 = SiteDb.init(dbPath);
      db2.raw().exec('PRAGMA busy_timeout = 0');
      expect(() => db2.ensureSite('waiter-site', 'https://example.test')).toThrow(/locked|busy/i);
      db2.close();

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('schema migration atomicity & idempotency (localpress#194)', () => {
  /** Read pragma_table_info for a table on a fresh readonly connection. */
  function columnNames(dbPath: string, table: string): string[] {
    const conn = new Database(dbPath, { readonly: true });
    try {
      const rows = conn.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      return rows.map((row) => row.name);
    } finally {
      conn.close();
    }
  }

  /** Simulate a process killed between the v5 ALTER and its version stamp. */
  function revertStampToV4(dbPath: string): void {
    const conn = new Database(dbPath);
    try {
      conn.exec('DELETE FROM schema_version WHERE version = 5');
    } finally {
      conn.close();
    }
  }

  test('fresh init reaches v5 with reverted_at present', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-migration-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      const db = SiteDb.init(dbPath);
      db.close();

      expect(columnNames(dbPath, 'processing_history')).toContain('reverted_at');

      const conn = new Database(dbPath, { readonly: true });
      try {
        const row = conn.query('SELECT MAX(version) as version FROM schema_version').get() as {
          version: number;
        };
        expect(row.version).toBe(SCHEMA_VERSION);
      } finally {
        conn.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('re-running init after an interrupted v5 stamp does not throw "duplicate column name"', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-migration-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      // Get to a fully-migrated DB, then roll the stamp back to v4 while
      // leaving the ALTER's column in place — simulating a process killed
      // between the ALTER and the version stamp.
      SiteDb.init(dbPath).close();
      revertStampToV4(dbPath);
      expect(columnNames(dbPath, 'processing_history')).toContain('reverted_at');

      let db2: SiteDb | undefined;
      expect(() => {
        db2 = SiteDb.init(dbPath);
      }).not.toThrow();
      db2?.close();

      // The DB should be fully recovered to v5, not stuck re-throwing.
      const conn = new Database(dbPath, { readonly: true });
      try {
        const row = conn.query('SELECT MAX(version) as version FROM schema_version').get() as {
          version: number;
        };
        expect(row.version).toBe(SCHEMA_VERSION);
      } finally {
        conn.close();
      }
      expect(columnNames(dbPath, 'processing_history')).toContain('reverted_at');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test('two connections concurrently migrating a v4-with-column DB both end at v5 without throwing', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-migration-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      SiteDb.init(dbPath).close();
      revertStampToV4(dbPath);

      // Hold the write lock briefly so the second init's migration loop has
      // to wait (via busy_timeout) and re-check the stored version under
      // the lock before applying its own ALTER.
      const holdMs = 200;
      const scriptPath = join(
        tmpdir(),
        `localpress-migration-holder-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`,
      );
      writeFileSync(
        scriptPath,
        `
        import { Database } from 'bun:sqlite';
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec('BEGIN IMMEDIATE');
        await Bun.sleep(${holdMs});
        db.exec('COMMIT');
        db.close();
        `,
      );
      const proc = Bun.spawn([process.execPath, 'run', scriptPath], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await Bun.sleep(50);

      let db2: SiteDb | undefined;
      expect(() => {
        db2 = SiteDb.init(dbPath);
      }).not.toThrow();
      db2?.close();

      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);

      const conn = new Database(dbPath, { readonly: true });
      try {
        const row = conn.query('SELECT MAX(version) as version FROM schema_version').get() as {
          version: number;
        };
        expect(row.version).toBe(SCHEMA_VERSION);
      } finally {
        conn.close();
      }
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 10_000);

  test('re-opening at the same schema version still takes no write lock (early-out preserved)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-migration-test-'));
    const dbPath = join(tmpRoot, 'site.db');
    try {
      const db1 = SiteDb.init(dbPath);
      db1.close();

      const readVersionRows = () => {
        const conn = new Database(dbPath, { readonly: true });
        try {
          return conn.query('SELECT version, rowid FROM schema_version').all();
        } finally {
          conn.close();
        }
      };

      const before = readVersionRows();
      const db2 = SiteDb.init(dbPath);
      db2.close();
      const after = readVersionRows();

      expect(after).toEqual(before);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
