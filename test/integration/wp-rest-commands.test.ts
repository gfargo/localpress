/**
 * CLI-subprocess integration tests against the Dockerized WordPress instance.
 *
 * Unlike wp-rest.test.ts (which drives the RestAdapter directly), these tests
 * spawn `localpress` as a real subprocess via the harness in
 * test/integration/helpers/cli.ts — exercising actual command wiring (option
 * parsing, JSON output shape, dry-run/apply semantics), not just the REST
 * calls underneath.
 *
 * Same prerequisites as wp-rest.test.ts: Docker WP up, WP_TEST_URL/
 * WP_TEST_USER/WP_TEST_APP_PASSWORD set. Skipped otherwise.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RestAdapter } from '../../src/adapters/rest.ts';
import type { SiteConfig } from '../../src/types.ts';
import { type CliHarness, createCliHarness } from './helpers/cli.ts';

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

/** Parse ndjson stderr (--json mode emits one {level, message} object per line). */
function parseStderrLines(stderr: string): Array<{ level: string; message: string }> {
  return stderr
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { level: string; message: string };
      } catch {
        return null;
      }
    })
    .filter((v): v is { level: string; message: string } => v !== null);
}

describe.skipIf(!canRun)('CLI subprocess integration', () => {
  let harness: CliHarness;
  let adapter: RestAdapter;

  beforeAll(async () => {
    harness = await createCliHarness({
      url: testSite.url,
      username: testSite.username,
      appPassword: testSite.appPassword,
    });
    adapter = new RestAdapter(testSite);
  });

  afterAll(() => {
    harness.cleanup();
  });

  describe('optimize idempotency + undo round-trip', () => {
    test('second optimize run skips unchanged source; undo restores via upload-as-new fallback', async () => {
      const { default: sharp } = await import('sharp');
      const jpegBuffer = await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 120, g: 130, b: 140 } },
      })
        .jpeg({ quality: 100 })
        .toBuffer();
      const uploaded = await adapter.upload(Buffer.from(jpegBuffer), {
        filename: 'optimize-cli-idempotency-test.jpg',
        title: 'Optimize CLI Idempotency Test',
      });

      const restoredAttachmentIds: number[] = [];

      try {
        const first = await harness.runJson<{
          processed: number;
          failures: number;
          results: Array<{ id: number; resultWpId: number | null }>;
        }>(['optimize', String(uploaded.id)]);

        expect(first.failures).toBe(0);
        expect(first.processed).toBe(1);
        // REST-only site: no replace-in-place capability, so the optimized
        // copy lands as a brand-new attachment, not the same ID.
        expect(first.results[0]?.resultWpId).not.toBeNull();
        expect(first.results[0]?.resultWpId).not.toBe(uploaded.id);
        if (first.results[0]?.resultWpId) restoredAttachmentIds.push(first.results[0].resultWpId);

        // Second run: same source bytes at the same URL → idempotency skip.
        const second = await harness.runJson<{ processed: number; failures: number }>([
          'optimize',
          String(uploaded.id),
        ]);
        expect(second.failures).toBe(0);
        expect(second.processed).toBe(0);

        // Undo the single most recent snapshot for this attachment.
        const undoResult = await harness.run([
          'undo',
          '--attachment',
          String(uploaded.id),
          '--json',
        ]);
        expect(undoResult.exitCode).toBe(0);
        const undoJson = JSON.parse(undoResult.stdout) as {
          restored: number;
          failures: number;
          results: Array<{ status: string; attachmentId: number }>;
        };
        expect(undoJson.failures).toBe(0);
        expect(undoJson.restored).toBe(1);
        expect(undoJson.results[0].status).toBe('restored');
        expect(undoJson.results[0].attachmentId).toBe(uploaded.id);

        // The restore itself also falls back to upload-as-new on REST-only
        // sites — capture that attachment ID from the warn() line for cleanup.
        const warnLines = parseStderrLines(undoResult.stderr);
        const restoreWarn = warnLines.find((l) => /uploaded as new attachment/i.test(l.message));
        const match = restoreWarn?.message.match(/#(\d+)/);
        if (match) restoredAttachmentIds.push(Number(match[1]));
      } finally {
        await adapter.delete(uploaded.id, { force: true }).catch(() => {});
        for (const id of restoredAttachmentIds) {
          await adapter.delete(id, { force: true }).catch(() => {});
        }
      }
    }, 60_000);
  });

  describe('posts CRUD, including a custom post type with a non-default rest_base', () => {
    test('create/list/show/update/delete round-trip for built-in posts', async () => {
      const created = await harness.runJson<{
        action: string;
        post: { id: number; title: string };
      }>(['posts', 'create', '--title', 'CLI Test Post', '--content', '<p>hello</p>']);
      expect(created.action).toBe('created');
      const id = created.post.id;

      try {
        const list = await harness.runJson<{ items: Array<{ id: number }> }>([
          'posts',
          'list',
          '--status',
          'draft',
          '--per-page',
          '100',
        ]);
        expect(list.items.some((p) => p.id === id)).toBe(true);

        const shown = await harness.runJson<{ id: number; title: string }>([
          'posts',
          'show',
          String(id),
        ]);
        expect(shown.id).toBe(id);
        expect(shown.title).toBe('CLI Test Post');

        const updated = await harness.runJson<{ action: string; post: { title: string } }>([
          'posts',
          'update',
          String(id),
          '--title',
          'CLI Test Post (edited)',
        ]);
        expect(updated.action).toBe('updated');
        expect(updated.post.title).toBe('CLI Test Post (edited)');
      } finally {
        const deleted = await harness.runJson<{ action: string; id: number }>([
          'posts',
          'delete',
          String(id),
          '--force',
        ]);
        expect(deleted.action).toBe('deleted');
      }
    }, 30_000);

    test('custom post type routes through its rest_base, not the type slug', async () => {
      // The Docker test WP registers `lp_item` with rest_base `lp-items` (see
      // setup-wp.sh). typeEndpoint() forwards --type verbatim as the URL
      // segment, so passing the actual rest_base is what makes this route —
      // proving the CLI doesn't assume type-name-as-slug.
      const created = await harness.runJson<{ action: string; post: { id: number } }>([
        'posts',
        'create',
        '--type',
        'lp-items',
        '--title',
        'CLI CPT Test Item',
        '--status',
        'publish',
      ]);
      expect(created.action).toBe('created');
      const id = created.post.id;

      try {
        const list = await harness.runJson<{ items: Array<{ id: number }> }>([
          'posts',
          'list',
          '--type',
          'lp-items',
          '--per-page',
          '100',
        ]);
        expect(list.items.some((p) => p.id === id)).toBe(true);
      } finally {
        await harness.runJson(['posts', 'delete', String(id), '--type', 'lp-items', '--force']);
      }
    }, 30_000);
  });

  describe('import: Zip Slip rejection + filename collision', () => {
    test('rejects a path-traversal archive entry but still imports legitimate entries', async () => {
      const { default: sharp } = await import('sharp');
      const scratchDir = mkdtempSync(join(tmpdir(), 'localpress-import-zipslip-'));
      const uploadedIds: number[] = [];

      try {
        const goodImage = await sharp({
          create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } },
        })
          .jpeg()
          .toBuffer();

        const zipPath = join(scratchDir, 'malicious.zip');
        writeFileSync(
          zipPath,
          buildZipSync([
            { path: 'good.jpg', data: Buffer.from(goodImage) },
            // Path traversal: resolves outside the extraction temp dir.
            { path: '../../evil.jpg', data: Buffer.from(goodImage) },
          ]),
        );

        const result = await harness.run(['import', zipPath, '--json']);
        expect(result.exitCode).toBe(0);
        const json = JSON.parse(result.stdout) as {
          imported: number;
          failures: number;
          items: Array<{ attachmentId: number; filename: string }>;
        };

        // The legitimate entry still imports.
        expect(json.imported).toBe(1);
        expect(json.failures).toBe(0);
        for (const item of json.items) uploadedIds.push(item.attachmentId);

        // The traversal entry is rejected with a warning, not silently written.
        const warnLines = parseStderrLines(result.stderr);
        expect(warnLines.some((l) => /skipping unsafe archive entry/i.test(l.message))).toBe(true);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
        for (const id of uploadedIds) await adapter.delete(id, { force: true }).catch(() => {});
      }
    }, 30_000);

    test('importing the same file twice creates two distinct attachments', async () => {
      const { default: sharp } = await import('sharp');
      const scratchDir = mkdtempSync(join(tmpdir(), 'localpress-import-collision-'));
      const uploadedIds: number[] = [];

      try {
        const imageBytes = await sharp({
          create: { width: 30, height: 30, channels: 3, background: { r: 9, g: 8, b: 7 } },
        })
          .jpeg()
          .toBuffer();
        const filePath = join(scratchDir, 'collision-test.jpg');
        writeFileSync(filePath, imageBytes);

        const first = await harness.runJson<{
          imported: number;
          items: Array<{ attachmentId: number }>;
        }>(['import', filePath]);
        const second = await harness.runJson<{
          imported: number;
          items: Array<{ attachmentId: number }>;
        }>(['import', filePath]);

        expect(first.imported).toBe(1);
        expect(second.imported).toBe(1);
        uploadedIds.push(first.items[0].attachmentId, second.items[0].attachmentId);

        const distinctIds = new Set(uploadedIds);
        expect(distinctIds.size).toBe(2);
      } finally {
        rmSync(scratchDir, { recursive: true, force: true });
        for (const id of uploadedIds) await adapter.delete(id, { force: true }).catch(() => {});
      }
    }, 30_000);
  });
});

// -- Minimal ZIP builder (STORE method, no compression) for test fixtures ----

function buildZipSync(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBuf = Buffer.from(entry.path, 'utf-8');
    const data = entry.data;

    const localHeader = Buffer.alloc(30 + pathBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    const crc = crc32(data);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(pathBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    pathBuf.copy(localHeader, 30);

    parts.push(localHeader, data);

    const cdEntry = Buffer.alloc(46 + pathBuf.length);
    cdEntry.writeUInt32LE(0x02014b50, 0);
    cdEntry.writeUInt16LE(20, 4);
    cdEntry.writeUInt16LE(20, 6);
    cdEntry.writeUInt16LE(0, 8);
    cdEntry.writeUInt16LE(0, 10);
    cdEntry.writeUInt16LE(0, 12);
    cdEntry.writeUInt16LE(0, 14);
    cdEntry.writeUInt32LE(crc, 16);
    cdEntry.writeUInt32LE(data.length, 20);
    cdEntry.writeUInt32LE(data.length, 24);
    cdEntry.writeUInt16LE(pathBuf.length, 28);
    cdEntry.writeUInt16LE(0, 30);
    cdEntry.writeUInt16LE(0, 32);
    cdEntry.writeUInt16LE(0, 34);
    cdEntry.writeUInt16LE(0, 36);
    cdEntry.writeUInt32LE(0, 38);
    cdEntry.writeUInt32LE(offset, 42);
    pathBuf.copy(cdEntry, 46);

    centralDir.push(cdEntry);
    offset += localHeader.length + data.length;
  }

  const centralDirBuf = Buffer.concat(centralDir);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirBuf.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, centralDirBuf, endRecord]);
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
