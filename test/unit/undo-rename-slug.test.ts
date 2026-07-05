/**
 * Unit tests for `restoreSnapshot` in the `undo` command — pins down the
 * rename-undo bug: a metadata-only snapshot carrying a captured `slug`
 * must forward it to `updateMetadata`, while snapshots that never had a
 * slug must leave it untouched.
 */

import { describe, expect, test } from 'bun:test';
import type { AdapterResolver } from '../../src/adapters/resolver.ts';
import type { UpdateMetadata, WpBackend } from '../../src/adapters/types.ts';
import { restoreSnapshot } from '../../src/cli/commands/undo.ts';
import type { SnapshotRecord } from '../../src/engine/history/types.ts';

function makeSnapshot(overrides: Partial<SnapshotRecord>): SnapshotRecord {
  return {
    id: 1,
    sessionId: 'session-1',
    siteName: 'testsite',
    wpId: 55,
    operation: 'rename',
    kind: 'metadata-only',
    blobPath: null,
    blobSize: 0,
    beforeMeta: { filename: 'photo.jpg', mimeType: 'image/jpeg' },
    beforeHash: null,
    createdAt: Date.now(),
    restoredAt: null,
    ...overrides,
  };
}

function makeStubResolver(updateMetadata: (id: number, meta: UpdateMetadata) => Promise<void>) {
  const fakeAdapter = {
    name: 'rest',
    capabilities: new Set(['update-meta']),
    updateMetadata,
  } as unknown as WpBackend;

  return {
    resolve: () => fakeAdapter,
    tryResolve: () => fakeAdapter,
  } as unknown as AdapterResolver;
}

describe('restoreSnapshot', () => {
  test('forwards the captured slug for a rename snapshot', async () => {
    let received: UpdateMetadata | null = null;
    const resolver = makeStubResolver(async (_id, meta) => {
      received = meta;
    });

    const snap = makeSnapshot({
      operation: 'rename',
      beforeMeta: { filename: 'photo.jpg', mimeType: 'image/jpeg', slug: 'old-slug' },
    });

    await restoreSnapshot(snap, resolver, false);

    expect(received).not.toBeNull();
    const meta = received as unknown as UpdateMetadata;
    expect(meta.slug).toBe('old-slug');
  });

  test('leaves slug undefined for a snapshot that never captured one', async () => {
    let received: UpdateMetadata | null = null;
    const resolver = makeStubResolver(async (_id, meta) => {
      received = meta;
    });

    const snap = makeSnapshot({
      operation: 'caption',
      beforeMeta: { filename: 'photo.jpg', mimeType: 'image/jpeg', altText: 'old alt' },
    });

    await restoreSnapshot(snap, resolver, false);

    expect(received).not.toBeNull();
    const meta = received as unknown as UpdateMetadata;
    expect(meta.slug).toBeUndefined();
    expect(meta.altText).toBe('old alt');
  });
});
