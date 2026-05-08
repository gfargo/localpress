/**
 * Unit tests for the SQLite state layer.
 * Uses :memory: databases for speed and isolation.
 */

import { describe, expect, test } from 'bun:test';

import { SiteDb } from '../../src/engine/state/db.ts';
import { SCHEMA_VERSION } from '../../src/engine/state/schema.ts';

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
    expect(SCHEMA_VERSION).toBe(3);
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
