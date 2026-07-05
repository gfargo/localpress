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

  test('delete without --force throws actionable error when MEDIA_TRASH is unset', async () => {
    // The Docker test WP does not define MEDIA_TRASH, so a non-force delete
    // hits WP core's 501 rest_trash_not_supported. We translate that into an
    // actionable message rather than surfacing the raw REST error.
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .toBuffer();

    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'integration-test-trash-delete.jpg',
      title: 'Integration Test Trash Delete',
    });

    try {
      await expect(adapter.delete(uploaded.id)).rejects.toThrow(/MEDIA_TRASH|--force/);
    } finally {
      // The non-force delete above failed (nothing to trash), so force-delete
      // to avoid leaking media between test runs.
      await adapter.delete(uploaded.id, { force: true });
    }
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
    // Upload a throwaway attachment so we have a known attachment ID to embed
    // — reusing an existing library item risks pre-existing references from
    // other tests/runs skewing the assertion.
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 50, height: 50, channels: 3, background: { r: 0, g: 255, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'reference-scan-test.jpg',
      title: 'Reference Scan Test Image',
    });

    // Seed a real Gutenberg post embedding the attachment via a wp:image block.
    const auth = `Basic ${btoa(`${testSite.username}:${testSite.appPassword}`)}`;
    const content = `<!-- wp:image {"id":${uploaded.id}} --><figure class="wp-block-image"><img src="${uploaded.url}" class="wp-image-${uploaded.id}"/></figure><!-- /wp:image -->`;

    const createRes = await fetch(`${testSite.url}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Reference Scan Test Post',
        content,
        status: 'publish',
      }),
    });
    expect(createRes.ok).toBe(true);
    const createdPost = (await createRes.json()) as { id: number };

    try {
      const refs = await adapter.findReferences(uploaded.id, 'fast');
      const blockRefs = refs.filter((r) => r.type === 'gutenberg-block');
      expect(blockRefs.length).toBe(1);
      expect(blockRefs[0].postId).toBe(createdPost.id);
    } finally {
      await fetch(`${testSite.url}/wp-json/wp/v2/posts/${createdPost.id}?force=true`, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      await adapter.delete(uploaded.id, { force: true });
    }
  });

  test('force delete permanently removes an attachment', async () => {
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'delete-force-test.jpg',
      title: 'Delete Force Test',
    });

    await adapter.delete(uploaded.id, { force: true });

    await expect(adapter.getMedia(uploaded.id)).rejects.toThrow();
  });

  test('non-force delete without MEDIA_TRASH surfaces an actionable error', async () => {
    // The Docker test WordPress doesn't define MEDIA_TRASH, so WP itself
    // rejects trashing an attachment — the adapter translates this into an
    // actionable message instead of an opaque REST error.
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 30, g: 20, b: 10 } },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'delete-trash-test.jpg',
      title: 'Delete Trash Test',
    });

    try {
      await expect(adapter.delete(uploaded.id, { force: false })).rejects.toThrow(
        /MEDIA_TRASH|force/i,
      );
    } finally {
      // Clean up regardless of trash support.
      await adapter.delete(uploaded.id, { force: true }).catch(() => {});
    }
  });

  test('delete records a processing event that getLastProcessing can retrieve', async () => {
    const { default: sharp } = await import('sharp');
    const jpegBuffer = await sharp({
      create: { width: 20, height: 20, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
      filename: 'delete-record-test.jpg',
      title: 'Delete Record Test',
    });

    await adapter.delete(uploaded.id, { force: true });

    // processing_history has an FK on (site_name, wp_id) -> attachments, so the
    // attachment row must exist locally before recording a processing event for it.
    db.upsertAttachment({
      siteName: testSite.name,
      wpId: uploaded.id,
      sourceUrl: uploaded.url,
      sourceHash: null,
      sizeBytes: uploaded.sizeBytes ?? null,
      width: uploaded.width ?? null,
      height: uploaded.height ?? null,
      mimeType: uploaded.mimeType,
      lastSeenAt: Date.now(),
    });

    db.recordProcessing({
      siteName: testSite.name,
      wpId: uploaded.id,
      operation: 'delete',
      paramsJson: JSON.stringify({ force: true }),
      sourceHash: null,
      resultHash: null,
      bytesBefore: uploaded.sizeBytes ?? null,
      bytesAfter: null,
      resultWpId: null,
      ranAt: Date.now(),
      durationMs: 42,
      status: 'success',
      errorMessage: null,
    });

    const last = db.getLastProcessing(testSite.name, uploaded.id, 'delete');
    expect(last).not.toBeNull();
    expect(last?.operation).toBe('delete');
    expect(last?.status).toBe('success');
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
