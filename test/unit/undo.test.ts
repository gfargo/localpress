/**
 * `restoreSnapshot` unit tests.
 *
 * Regression coverage for the format-change undo bug: restoring a snapshot
 * whose original mimeType differs from the attachment's *current* mimeType
 * (e.g. `optimize --to webp` converted photo.png → photo.webp) must pass
 * `newExtension`/`newMimeType` through to `replaceInPlace` so the file is
 * renamed back, post_mime_type is restored, and thumbnails regenerate.
 *
 * Uses fake adapters via the resolver's structural `ResolverLike` type —
 * no network, no WordPress, no SSH.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capability, MediaItem, ReplaceOptions, WpBackend } from '../../src/adapters/types.ts';
import type { ResolverLike } from '../../src/cli/commands/undo.ts';
import { restoreSnapshot } from '../../src/cli/commands/undo.ts';
import { SnapshotStore } from '../../src/engine/history/store.ts';
import type { SnapshotRecord } from '../../src/engine/history/types.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

let db: SiteDb;
let store: SnapshotStore;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-undo-test-'));
  db = SiteDb.init(join(tmpRoot, 'site.db'));
  db.ensureSite('testsite', 'https://example.test');
  store = new SnapshotStore(db.raw(), join(tmpRoot, 'snapshots'));
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

function makeFakeBackend(overrides: Partial<WpBackend> = {}): WpBackend {
  return {
    name: 'wp-cli',
    capabilities: new Set<Capability>(),
    listMedia: async () => {
      throw new Error('listMedia not stubbed');
    },
    listMediaPage: async () => {
      throw new Error('listMediaPage not stubbed');
    },
    getMedia: async () => {
      throw new Error('getMedia not stubbed');
    },
    upload: async () => {
      throw new Error('upload not stubbed');
    },
    replaceInPlace: async () => {
      throw new Error('replaceInPlace not stubbed');
    },
    updateMetadata: async () => {},
    delete: async () => {},
    regenerateThumbnails: async () => {},
    pruneOrphans: async () => {
      throw new Error('pruneOrphans not stubbed');
    },
    findReferences: async () => [],
    findUnattached: async () => [],
    ...overrides,
  };
}

function captureBinarySnapshot(filename: string, mimeType: string, bytes: Buffer): SnapshotRecord {
  const session = store.openSession('testsite', 'optimize', {});
  const id = store.capture({
    siteName: 'testsite',
    sessionId: session.id,
    attachmentId: 42,
    operation: 'optimize',
    sourceBytes: bytes,
    beforeMeta: { filename, mimeType },
  });
  store.closeSession(session.id);
  if (id === null) throw new Error('capture returned null unexpectedly');
  const snap = store.getSnapshot(id);
  if (!snap) throw new Error('snapshot not found');
  return snap;
}

describe('restoreSnapshot', () => {
  test('format change on undo: passes newExtension/newMimeType and warns about stale references', async () => {
    const bytes = Buffer.from('original png bytes');
    const snap = captureBinarySnapshot('photo.png', 'image/png', bytes);

    const captured: {
      call?: { id: number; file: Buffer; options: ReplaceOptions | undefined };
    } = {};
    const replaceBackend = makeFakeBackend({
      replaceInPlace: async (id, file, options): Promise<MediaItem> => {
        captured.call = { id, file, options };
        return {
          id,
          title: 'photo',
          filename: 'photo.png',
          url: 'https://example.test/wp-content/uploads/photo.png',
          mimeType: 'image/png',
          uploadedAt: '2024-01-01',
        };
      },
    });
    const getBackend = makeFakeBackend({
      getMedia: async (id): Promise<MediaItem> => ({
        id,
        title: 'photo',
        filename: 'photo.webp',
        url: 'https://example.test/wp-content/uploads/photo.webp',
        mimeType: 'image/webp',
        uploadedAt: '2024-01-01',
      }),
    });
    const metaBackend = makeFakeBackend({ updateMetadata: async () => {} });

    const resolver: ResolverLike = {
      resolve: (capability) => {
        if (capability === 'get') return getBackend;
        if (capability === 'update-meta') return metaBackend;
        if (capability === 'upload') throw new Error('should not need upload fallback');
        throw new Error(`unexpected resolve('${capability}')`);
      },
      tryResolve: (capability) => {
        if (capability === 'replace-in-place') return replaceBackend;
        if (capability === 'update-meta') return metaBackend;
        return null;
      },
    };

    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let warnedLines: string[];
    try {
      await restoreSnapshot(snap, resolver, store, false);
    } finally {
      // Capture calls BEFORE mockRestore() — it clears the recorded call history.
      warnedLines = writeSpy.mock.calls.map((c) => String(c[0]));
      writeSpy.mockRestore();
    }

    if (!captured.call) throw new Error('replaceInPlace was not called');
    expect(captured.call.file.toString()).toBe('original png bytes');
    expect(captured.call.options?.newExtension).toBe('.png');
    expect(captured.call.options?.newMimeType).toBe('image/png');
    expect(captured.call.options?.regenerateThumbnails).toBe(true);

    expect(warnedLines.some((line) => line.includes('references 42 --scope full'))).toBe(true);
    expect(warnedLines.some((line) => line.includes('photo.webp'))).toBe(true);
  });

  test('no format change: replaceInPlace is called without newExtension/newMimeType', async () => {
    const bytes = Buffer.from('same-format bytes');
    const snap = captureBinarySnapshot('photo.jpg', 'image/jpeg', bytes);

    const captured: {
      call?: { id: number; file: Buffer; options: ReplaceOptions | undefined };
    } = {};
    const replaceBackend = makeFakeBackend({
      replaceInPlace: async (id, file, options): Promise<MediaItem> => {
        captured.call = { id, file, options };
        return {
          id,
          title: 'photo',
          filename: 'photo.jpg',
          url: 'https://example.test/wp-content/uploads/photo.jpg',
          mimeType: 'image/jpeg',
          uploadedAt: '2024-01-01',
        };
      },
    });
    const getBackend = makeFakeBackend({
      getMedia: async (id): Promise<MediaItem> => ({
        id,
        title: 'photo',
        filename: 'photo.jpg',
        url: 'https://example.test/wp-content/uploads/photo.jpg',
        mimeType: 'image/jpeg',
        uploadedAt: '2024-01-01',
      }),
    });
    const metaBackend = makeFakeBackend({ updateMetadata: async () => {} });

    const resolver: ResolverLike = {
      resolve: (capability) => {
        if (capability === 'get') return getBackend;
        if (capability === 'update-meta') return metaBackend;
        throw new Error(`unexpected resolve('${capability}')`);
      },
      tryResolve: (capability) => {
        if (capability === 'replace-in-place') return replaceBackend;
        if (capability === 'update-meta') return metaBackend;
        return null;
      },
    };

    const writeSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let warnedLines: string[];
    try {
      await restoreSnapshot(snap, resolver, store, false);
    } finally {
      warnedLines = writeSpy.mock.calls.map((c) => String(c[0]));
      writeSpy.mockRestore();
    }

    if (!captured.call) throw new Error('replaceInPlace was not called');
    expect(captured.call.options?.newExtension).toBeUndefined();
    expect(captured.call.options?.newMimeType).toBeUndefined();

    expect(warnedLines.some((line) => line.includes('--scope full'))).toBe(false);
  });
});
