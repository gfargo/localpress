/**
 * Integration tests against a Dockerized WordPress instance.
 *
 * Prerequisites:
 *   1. docker compose -f test/integration/docker-compose.yml up -d
 *   2. docker compose -f test/integration/docker-compose.yml exec wordpress bash /usr/local/bin/setup-wp.sh
 *   3. Set WP_TEST_URL, WP_TEST_USER, WP_TEST_APP_PASSWORD env vars
 *      (the setup script prints these)
 *
 * Run:
 *   WP_TEST_URL=http://localhost:8880 WP_TEST_USER=admin WP_TEST_APP_PASSWORD="xxxx xxxx xxxx xxxx" bun test test/integration/
 *
 * These tests are skipped if the env vars are not set, so they won't
 * break CI unless the Docker environment is explicitly configured.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { AdapterResolver } from '../../src/adapters/resolver.ts';
import { RestAdapter } from '../../src/adapters/rest.ts';
import { CapabilityUnavailableError } from '../../src/adapters/types.ts';
import { SiteDb } from '../../src/engine/state/db.ts';
import type { SiteConfig } from '../../src/types.ts';

const WP_URL = process.env.WP_TEST_URL;
const WP_USER = process.env.WP_TEST_USER;
const WP_APP_PASSWORD = process.env.WP_TEST_APP_PASSWORD;

const canRun = Boolean(WP_URL && WP_USER && WP_APP_PASSWORD);

const testSite: SiteConfig = {
  name: 'integration-test',
  url: WP_URL ?? 'http://localhost:8880',
  username: WP_USER ?? 'admin',
  appPassword: WP_APP_PASSWORD ?? '',
  createdAt: new Date().toISOString(),
};

// Skip the entire suite if env vars aren't set.
describe.skipIf(!canRun)('WordPress REST API integration', () => {
  let adapter: RestAdapter;
  let db: SiteDb;

  beforeAll(() => {
    adapter = new RestAdapter(testSite);
    db = SiteDb.init(':memory:');
    db.ensureSite(testSite.name, testSite.url);
  });

  afterAll(() => {
    db.close();
  });

  test('can authenticate and list media', async () => {
    const items = await adapter.listMedia({ perPage: 10, page: 1 });
    expect(Array.isArray(items)).toBe(true);
    // The setup script uploads 3 test images.
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  test('can get a single media item', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    expect(items.length).toBeGreaterThanOrEqual(1);

    const item = await adapter.getMedia(items[0].id);
    expect(item.id).toBe(items[0].id);
    expect(item.url).toBeTruthy();
    expect(item.mimeType).toMatch(/^image\//);
  });

  test('can download an image from its URL', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = items[0];

    const response = await fetch(item.url);
    expect(response.ok).toBe(true);

    const bytes = await response.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test('can upload a new attachment', async () => {
    // Create a minimal JPEG in memory (1x1 pixel).
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();

    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'integration-test-upload.jpg',
      title: 'Integration Test Upload',
      altText: 'A red square',
    });

    expect(uploaded.id).toBeGreaterThan(0);
    expect(uploaded.mimeType).toBe('image/jpeg');

    // Clean up: delete the uploaded attachment.
    await adapter.delete(uploaded.id, { force: true });
  });

  test('can update metadata on an attachment', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = items[0];

    // Update alt text.
    await adapter.updateMetadata(item.id, {
      altText: 'Updated by integration test',
    });

    // Verify the update.
    const updated = await adapter.getMedia(item.id);
    expect(updated.altText).toBe('Updated by integration test');
  });

  test('rename then undo restores the original slug (rename/undo round trip)', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = await adapter.getMedia(items[0].id);
    const originalSlug = item.slug;
    expect(originalSlug).toBeTruthy();

    // Simulate `rename`: change the slug.
    await adapter.updateMetadata(item.id, { slug: 'integration-test-renamed-slug' });
    const renamed = await adapter.getMedia(item.id);
    expect(renamed.slug).toBe('integration-test-renamed-slug');

    // Simulate the fixed `undo` path: restore the captured pre-rename slug.
    await adapter.updateMetadata(item.id, { slug: originalSlug });
    const restored = await adapter.getMedia(item.id);
    expect(restored.slug).toBe(originalSlug);
  });

  test('replaceInPlace throws CapabilityUnavailableError', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = items[0];

    await expect(adapter.replaceInPlace(item.id, Buffer.from(''))).rejects.toThrow(
      CapabilityUnavailableError,
    );
  });

  test('AdapterResolver reports correct capabilities for REST-only site', () => {
    const resolver = new AdapterResolver(testSite);
    const availability = resolver.availability();

    expect(availability.rest).toBe(true);
    expect(availability.wpCli).toBe(false);
    expect(availability.mcp).toBe(false);

    const report = resolver.capabilityReport();
    const listCap = report.find((r) => r.capability === 'list');
    expect(listCap?.preferredAdapter).toBe('rest');

    const replaceCap = report.find((r) => r.capability === 'replace-in-place');
    expect(replaceCap?.preferredAdapter).toBeNull();
  });

  test('can find references (fast scan)', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = items[0];

    // Fast scan should return an array (possibly empty for test images).
    const refs = await adapter.findReferences(item.id, 'fast');
    expect(Array.isArray(refs)).toBe(true);
  });

  test('SQLite state tracking works end-to-end', async () => {
    const items = await adapter.listMedia({ perPage: 1, page: 1 });
    const item = items[0];

    // Upsert the attachment into our local DB.
    db.upsertAttachment({
      siteName: testSite.name,
      wpId: item.id,
      sourceUrl: item.url,
      sourceHash: 'test-hash-123',
      sizeBytes: item.sizeBytes ?? null,
      width: item.width ?? null,
      height: item.height ?? null,
      mimeType: item.mimeType,
      lastSeenAt: Date.now(),
    });

    // Record a processing event.
    const recordId = db.recordProcessing({
      siteName: testSite.name,
      wpId: item.id,
      operation: 'optimize',
      paramsJson: JSON.stringify({ quality: 80 }),
      sourceHash: 'test-hash-123',
      resultHash: 'test-hash-456',
      bytesBefore: 50000,
      bytesAfter: 20000,
      resultWpId: null,
      ranAt: Date.now(),
      durationMs: 150,
      status: 'success',
      errorMessage: null,
    });

    expect(recordId).toBeGreaterThan(0);

    // Verify the attachment is now in the processed set.
    const processed = db.listProcessedWpIds(testSite.name);
    expect(processed.has(item.id)).toBe(true);

    // Verify getLastProcessing returns the record.
    const last = db.getLastProcessing(testSite.name, item.id);
    expect(last).not.toBeNull();
    expect(last?.sourceHash).toBe('test-hash-123');
    expect(last?.bytesAfter).toBe(20000);
  });
});
