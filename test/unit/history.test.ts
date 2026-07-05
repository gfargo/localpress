/**
 * SnapshotStore unit tests.
 *
 * Exercises the time-machine lifecycle against an in-memory SQLite db and a
 * temporary blob directory. No network, no WordPress.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotStore } from '../../src/engine/history/store.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

let db: SiteDb;
let store: SnapshotStore;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'localpress-history-test-'));
  // Real SQLite file inside the tmp dir so foreign keys work.
  db = SiteDb.init(join(tmpRoot, 'site.db'));
  db.ensureSite('testsite', 'https://example.test');
  store = new SnapshotStore(db.raw(), join(tmpRoot, 'snapshots'));
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('SnapshotStore', () => {
  test('open, capture binary, and close a session', () => {
    const session = store.openSession('testsite', 'optimize', { quality: 80 });
    const bytes = Buffer.from('hello world content');
    const id = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 42,
      operation: 'optimize',
      sourceBytes: bytes,
      beforeMeta: { filename: 'photo.jpg', mimeType: 'image/jpeg', altText: 'before' },
    });
    expect(id).not.toBeNull();
    store.closeSession(session.id);

    const fetched = store.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.itemCount).toBe(1);
    expect(fetched?.finishedAt).not.toBeNull();

    const snaps = store.listSnapshots('testsite');
    expect(snaps.length).toBe(1);
    expect(snaps[0].kind).toBe('binary');
    expect(snaps[0].blobSize).toBe(bytes.length);
    expect(snaps[0].beforeMeta.altText).toBe('before');

    // The blob file should exist and contain the captured bytes.
    expect(snaps[0].blobPath).not.toBeNull();
    const onDisk = readFileSync(snaps[0].blobPath as string);
    expect(onDisk.toString()).toBe('hello world content');
  });

  test('blob is written synchronously before capture() returns (durability)', () => {
    // Regression for the fire-and-forget bug: the DB row must never point at a
    // blob that isn't on disk yet. capture() writes synchronously, so the file
    // exists the instant it returns — no event-loop tick required.
    const session = store.openSession('testsite', 'optimize', { quality: 80 });
    const bytes = Buffer.from('durable snapshot bytes');
    store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 7,
      operation: 'optimize',
      sourceBytes: bytes,
      beforeMeta: { filename: 'a.jpg', mimeType: 'image/jpeg' },
    });

    const snap = store.listSnapshots('testsite').find((s) => s.wpId === 7);
    expect(snap?.blobPath).not.toBeNull();
    // No await between capture() and this read.
    expect(existsSync(snap?.blobPath as string)).toBe(true);
    expect(readFileSync(snap?.blobPath as string).toString()).toBe('durable snapshot bytes');
  });

  test('metadata-only capture stores no blob', () => {
    const session = store.openSession('testsite', 'caption');
    store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 99,
      operation: 'caption',
      sourceBytes: null,
      beforeMeta: { filename: 'a.jpg', mimeType: 'image/jpeg', altText: 'old caption' },
    });
    store.closeSession(session.id);

    const snaps = store.listSnapshots('testsite');
    expect(snaps[0].kind).toBe('metadata-only');
    expect(snaps[0].blobPath).toBeNull();
    expect(snaps[0].blobSize).toBe(0);
  });

  test('empty session is dropped on close', () => {
    const session = store.openSession('testsite', 'optimize');
    store.closeSession(session.id);
    expect(store.getSession(session.id)).toBeNull();
  });

  test('size-cap prune drops oldest snapshots first', () => {
    const session = store.openSession('testsite', 'optimize');
    for (let i = 0; i < 5; i++) {
      store.capture({
        siteName: 'testsite',
        sessionId: session.id,
        attachmentId: 100 + i,
        operation: 'optimize',
        sourceBytes: Buffer.alloc(1000), // 1 KB each
        beforeMeta: { filename: `${100 + i}.jpg`, mimeType: 'image/jpeg' },
      });
    }
    store.closeSession(session.id);
    expect(store.getStats('testsite').totalBytes).toBe(5000);

    // Cap at 2500 bytes — drop loop terminates when total ≤ 2500. Starting
    // at 5000, we drop three snapshots to reach 2000 ≤ 2500.
    const result = store.prune('testsite', { maxSizeBytes: 2500 });
    expect(result.droppedSnapshots).toBe(3);
    expect(result.freedBytes).toBe(3000);

    const remaining = store.listSnapshots('testsite');
    expect(remaining.length).toBe(2);
    // Newest two survive — attachments 103 and 104.
    const ids = remaining.map((s) => s.wpId).sort();
    expect(ids).toEqual([103, 104]);
  });

  test('age-cap prune drops snapshots older than threshold', () => {
    const session = store.openSession('testsite', 'optimize');
    store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 1,
      operation: 'optimize',
      sourceBytes: Buffer.alloc(100),
      beforeMeta: { filename: '1.jpg', mimeType: 'image/jpeg' },
    });
    store.closeSession(session.id);

    // Backdate by manipulating the db directly.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.raw().run('UPDATE snapshots SET created_at = ?', [oneHourAgo]);

    const result = store.prune('testsite', { olderThan: Date.now() - 30 * 60 * 1000 });
    expect(result.droppedSnapshots).toBe(1);
    expect(store.listSnapshots('testsite').length).toBe(0);
  });

  test('clear() wipes everything for the site', () => {
    const session = store.openSession('testsite', 'optimize');
    store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 7,
      operation: 'optimize',
      sourceBytes: Buffer.alloc(50),
      beforeMeta: { filename: '7.jpg', mimeType: 'image/jpeg' },
    });
    store.closeSession(session.id);

    const result = store.clear('testsite');
    expect(result.droppedSnapshots).toBe(1);
    expect(store.listSnapshots('testsite').length).toBe(0);
    expect(store.listSessions('testsite').length).toBe(0);
    expect(store.getStats('testsite').totalBytes).toBe(0);
  });

  test('getLastSnapshotForAttachment returns most recent un-restored', () => {
    const session = store.openSession('testsite', 'optimize');
    const id1 = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 5,
      operation: 'optimize',
      sourceBytes: Buffer.from('a'),
      beforeMeta: { filename: '5.jpg', mimeType: 'image/jpeg' },
    });
    // simulate a later capture
    const id2 = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 5,
      operation: 'optimize',
      sourceBytes: Buffer.from('b'),
      beforeMeta: { filename: '5.jpg', mimeType: 'image/jpeg' },
    });
    store.closeSession(session.id);

    if (id1 === null || id2 === null) throw new Error('capture returned null unexpectedly');
    const latest = store.getLastSnapshotForAttachment('testsite', 5);
    expect(latest?.id).toBe(id2);

    // Mark id2 as restored — getLastSnapshotForAttachment should now return id1.
    store.markRestored(id2);
    const next = store.getLastSnapshotForAttachment('testsite', 5);
    expect(next?.id).toBe(id1);

    // Regression: repeated captures of the same attachment in one session must
    // not share a blob path — each row's blob is independently readable.
    const snap1 = store.getSnapshot(id1);
    const snap2 = store.getSnapshot(id2);
    if (snap1 === null || snap2 === null) throw new Error('snapshot not found');
    expect(snap1.blobPath).not.toBeNull();
    expect(snap2.blobPath).not.toBeNull();
    expect(snap1.blobPath).not.toBe(snap2.blobPath);
    expect(store.readBlob(snap1).toString()).toBe('a');
    expect(store.readBlob(snap2).toString()).toBe('b');
  });

  test('recapturing the same attachment + beforeHash in one session skips a redundant blob', () => {
    const session = store.openSession('testsite', 'optimize');
    const id1 = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 9,
      operation: 'optimize',
      sourceBytes: Buffer.from('original bytes'),
      beforeMeta: { filename: '9.jpg', mimeType: 'image/jpeg' },
      beforeHash: 'sha256:same',
    });
    const id2 = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 9,
      operation: 'optimize',
      sourceBytes: Buffer.from('original bytes'),
      beforeMeta: { filename: '9.jpg', mimeType: 'image/jpeg' },
      beforeHash: 'sha256:same',
    });
    store.closeSession(session.id);

    expect(id2).toBe(id1);
    expect(store.listSnapshots('testsite', { attachmentId: 9 }).length).toBe(1);
  });

  test('stats include count, sessions, and total bytes', () => {
    const session = store.openSession('testsite', 'convert');
    for (let i = 0; i < 3; i++) {
      store.capture({
        siteName: 'testsite',
        sessionId: session.id,
        attachmentId: 200 + i,
        operation: 'convert',
        sourceBytes: Buffer.alloc(250),
        beforeMeta: { filename: `${200 + i}.png`, mimeType: 'image/png' },
      });
    }
    store.closeSession(session.id);

    const stats = store.getStats('testsite');
    expect(stats.snapshotCount).toBe(3);
    expect(stats.sessionCount).toBe(1);
    expect(stats.totalBytes).toBe(750);
    expect(stats.oldestSnapshotAt).not.toBeNull();
  });

  test('readBlob returns the captured bytes', () => {
    const session = store.openSession('testsite', 'optimize');
    const id = store.capture({
      siteName: 'testsite',
      sessionId: session.id,
      attachmentId: 1,
      operation: 'optimize',
      sourceBytes: Buffer.from('captured-content'),
      beforeMeta: { filename: 'x.jpg', mimeType: 'image/jpeg' },
    });
    if (id === null) throw new Error('capture returned null unexpectedly');
    const snap = store.getSnapshot(id);
    if (snap === null) throw new Error('snapshot not found');
    const bytes = store.readBlob(snap);
    expect(bytes.toString()).toBe('captured-content');
  });
});
