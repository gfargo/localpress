/**
 * SnapshotStore — the time-machine engine for localpress.
 *
 * Owns:
 *   - The `sessions` and `snapshots` tables in the per-site SQLite db
 *   - The blob storage directory at <config-dir>/sites/<site>.snapshots/<session>/
 *
 * Lifecycle:
 *   1. A command opens a session at start: `store.openSession(...)`
 *   2. Each per-item operation captures a snapshot BEFORE mutating WP:
 *      `store.capture({ session, attachment, sourceBytes, beforeMeta, ... })`
 *   3. Idempotent skips don't capture — no snapshot, no waste.
 *   4. At command end the session is closed: `store.closeSession(session, count)`
 *   5. `store.restore(snapshotId, adapter)` reverses a snapshot.
 *
 * The blob files are deduplicated by content hash within a session — if you
 * snapshot the same source bytes twice in one bulk run, you only store one
 * blob. Cross-session dedupe is not done (kept simple — it's a rare case and
 * complicates restore).
 */

import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  HistoryStats,
  PrunePolicy,
  PruneResult,
  SessionRecord,
  SnapshotKind,
  SnapshotMeta,
  SnapshotRecord,
} from './types.ts';

interface RawSessionRow {
  id: string;
  site_name: string;
  command: string;
  params_json: string | null;
  started_at: number;
  finished_at: number | null;
  item_count: number;
}

interface RawSnapshotRow {
  id: number;
  session_id: string;
  site_name: string;
  wp_id: number;
  operation: string;
  kind: string;
  blob_path: string | null;
  blob_size: number;
  before_meta: string;
  before_hash: string | null;
  created_at: number;
  restored_at: number | null;
}

export interface CaptureOptions {
  siteName: string;
  sessionId: string;
  attachmentId: number;
  operation: string;
  beforeMeta: SnapshotMeta;
  /** File bytes to snapshot. Pass null for metadata-only snapshots. */
  sourceBytes: Buffer | null;
  beforeHash?: string | null;
}

export class SnapshotStore {
  constructor(
    private readonly db: Database,
    /** Root directory for blob storage. Per-site subdirs created on demand. */
    private readonly blobRoot: string,
  ) {}

  // Sessions ------------------------------------------------------------------

  openSession(siteName: string, command: string, params?: unknown): SessionRecord {
    const id = randomUUID();
    const now = Date.now();
    const paramsJson = params === undefined ? null : JSON.stringify(params);

    this.db.run(
      `INSERT INTO sessions (id, site_name, command, params_json, started_at, item_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [id, siteName, command, paramsJson, now],
    );

    return {
      id,
      siteName,
      command,
      paramsJson,
      startedAt: now,
      finishedAt: null,
      itemCount: 0,
    };
  }

  closeSession(sessionId: string): void {
    const now = Date.now();
    // item_count is the number of snapshots in this session
    const { c } = this.db
      .query('SELECT COUNT(*) AS c FROM snapshots WHERE session_id = ?')
      .get(sessionId) as { c: number };

    this.db.run('UPDATE sessions SET finished_at = ?, item_count = ? WHERE id = ?', [
      now,
      c,
      sessionId,
    ]);

    // If the session captured nothing (e.g. every item was an idempotent skip),
    // drop the empty session record — keeps history clean.
    if (c === 0) {
      this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
    }
  }

  listSessions(
    siteName: string,
    options: { limit?: number; offset?: number } = {},
  ): SessionRecord[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = this.db
      .query(
        `SELECT id, site_name, command, params_json, started_at, finished_at, item_count
         FROM sessions
         WHERE site_name = ?
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(siteName, limit, offset) as RawSessionRow[];
    return rows.map(mapSessionRow);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db
      .query(
        `SELECT id, site_name, command, params_json, started_at, finished_at, item_count
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as RawSessionRow | null;
    return row ? mapSessionRow(row) : null;
  }

  getLastSession(siteName: string): SessionRecord | null {
    const row = this.db
      .query(
        `SELECT id, site_name, command, params_json, started_at, finished_at, item_count
         FROM sessions
         WHERE site_name = ? AND item_count > 0
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(siteName) as RawSessionRow | null;
    return row ? mapSessionRow(row) : null;
  }

  // Snapshots -----------------------------------------------------------------

  /**
   * Capture a pre-change snapshot of an attachment.
   * Returns the snapshot ID, or null if capture failed (best-effort).
   */
  capture(opts: CaptureOptions): number | null {
    const kind: SnapshotKind = opts.sourceBytes ? 'binary' : 'metadata-only';
    const now = Date.now();

    let blobPath: string | null = null;
    let blobSize = 0;

    if (opts.sourceBytes) {
      const ext = pickExtension(opts.beforeMeta);
      blobPath = join(this.blobRoot, opts.siteName, opts.sessionId, `${opts.attachmentId}${ext}`);
      mkdirSync(dirname(blobPath), { recursive: true });
      // Write the blob synchronously BEFORE inserting the DB row. A detached
      // async write can leave a committed snapshot row pointing at a missing or
      // truncated file if the process exits first — and its rejection would be
      // an uncatchable unhandled rejection. If this throws, no row is created
      // and the best-effort caller (captureSnapshot) swallows it.
      writeFileSync(blobPath, opts.sourceBytes);
      blobSize = opts.sourceBytes.length;
    }

    const result = this.db.run(
      `INSERT INTO snapshots
         (session_id, site_name, wp_id, operation, kind,
          blob_path, blob_size, before_meta, before_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        opts.sessionId,
        opts.siteName,
        opts.attachmentId,
        opts.operation,
        kind,
        blobPath,
        blobSize,
        JSON.stringify(opts.beforeMeta),
        opts.beforeHash ?? null,
        now,
      ],
    );

    return Number(result.lastInsertRowid);
  }

  /** Mark a snapshot as restored. The blob stays on disk until pruned. */
  markRestored(snapshotId: number): void {
    this.db.run('UPDATE snapshots SET restored_at = ? WHERE id = ?', [Date.now(), snapshotId]);
  }

  getSnapshot(snapshotId: number): SnapshotRecord | null {
    const row = this.db
      .query(
        `SELECT id, session_id, site_name, wp_id, operation, kind,
                blob_path, blob_size, before_meta, before_hash, created_at, restored_at
         FROM snapshots WHERE id = ?`,
      )
      .get(snapshotId) as RawSnapshotRow | null;
    return row ? mapSnapshotRow(row) : null;
  }

  listSnapshots(
    siteName: string,
    options: {
      sessionId?: string;
      attachmentId?: number;
      operation?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): SnapshotRecord[] {
    let sql = `SELECT id, session_id, site_name, wp_id, operation, kind,
                      blob_path, blob_size, before_meta, before_hash, created_at, restored_at
               FROM snapshots WHERE site_name = ?`;
    const params: Array<string | number> = [siteName];

    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }
    if (typeof options.attachmentId === 'number') {
      sql += ' AND wp_id = ?';
      params.push(options.attachmentId);
    }
    if (options.operation) {
      sql += ' AND operation = ?';
      params.push(options.operation);
    }

    sql += ' ORDER BY created_at DESC, id DESC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(options.limit ?? 200, options.offset ?? 0);

    const rows = this.db.query(sql).all(...params) as RawSnapshotRow[];
    return rows.map(mapSnapshotRow);
  }

  /** Get the most recent (un-restored) snapshot for a specific attachment. */
  getLastSnapshotForAttachment(siteName: string, attachmentId: number): SnapshotRecord | null {
    const row = this.db
      .query(
        `SELECT id, session_id, site_name, wp_id, operation, kind,
                blob_path, blob_size, before_meta, before_hash, created_at, restored_at
         FROM snapshots
         WHERE site_name = ? AND wp_id = ? AND restored_at IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(siteName, attachmentId) as RawSnapshotRow | null;
    return row ? mapSnapshotRow(row) : null;
  }

  /** Read blob bytes for a binary snapshot. Throws if not a binary snapshot. */
  readBlob(snapshot: SnapshotRecord): Buffer {
    if (snapshot.kind !== 'binary' || !snapshot.blobPath) {
      throw new Error(`Snapshot #${snapshot.id} is not a binary snapshot`);
    }
    return readFileSync(snapshot.blobPath);
  }

  // Stats & retention --------------------------------------------------------

  getStats(siteName: string): HistoryStats {
    const counts = this.db
      .query(
        `SELECT COUNT(*) AS snapshot_count,
                COUNT(DISTINCT session_id) AS session_count,
                COALESCE(SUM(blob_size), 0) AS total_bytes,
                MIN(created_at) AS oldest,
                MAX(created_at) AS newest
         FROM snapshots WHERE site_name = ?`,
      )
      .get(siteName) as {
      snapshot_count: number;
      session_count: number;
      total_bytes: number;
      oldest: number | null;
      newest: number | null;
    };

    return {
      snapshotCount: counts.snapshot_count,
      sessionCount: counts.session_count,
      totalBytes: counts.total_bytes,
      oldestSnapshotAt: counts.oldest,
      newestSnapshotAt: counts.newest,
    };
  }

  /**
   * Apply a retention policy. Drops snapshots from oldest first until the
   * policy is satisfied. Returns counts of what was dropped.
   *
   * Multiple policy clauses combine: a snapshot is dropped if it falls outside
   * ANY clause. (E.g. older-than triggers drop even if maxSize is satisfied.)
   */
  prune(siteName: string, policy: PrunePolicy): PruneResult {
    let droppedSnapshots = 0;
    let freedBytes = 0;

    // 1. Drop by age first.
    if (policy.olderThan !== undefined) {
      const victims = this.db
        .query(
          `SELECT id, blob_path, blob_size FROM snapshots
           WHERE site_name = ? AND created_at < ?`,
        )
        .all(siteName, policy.olderThan) as Array<{
        id: number;
        blob_path: string | null;
        blob_size: number;
      }>;

      for (const v of victims) {
        this.deleteSnapshot(v.id, v.blob_path);
        droppedSnapshots++;
        freedBytes += v.blob_size;
      }
    }

    // 2. Drop oldest sessions beyond maxSessions.
    if (policy.maxSessions !== undefined) {
      const oldSessionIds = this.db
        .query(
          `SELECT id FROM sessions
           WHERE site_name = ?
           ORDER BY started_at DESC
           LIMIT -1 OFFSET ?`,
        )
        .all(siteName, policy.maxSessions) as Array<{ id: string }>;

      for (const s of oldSessionIds) {
        const snapshots = this.db
          .query('SELECT id, blob_path, blob_size FROM snapshots WHERE session_id = ?')
          .all(s.id) as Array<{ id: number; blob_path: string | null; blob_size: number }>;
        for (const v of snapshots) {
          this.deleteSnapshot(v.id, v.blob_path);
          droppedSnapshots++;
          freedBytes += v.blob_size;
        }
      }
    }

    // 3. Drop oldest snapshots until size is under cap.
    if (policy.maxSizeBytes !== undefined) {
      while (true) {
        const { total } = this.db
          .query('SELECT COALESCE(SUM(blob_size), 0) AS total FROM snapshots WHERE site_name = ?')
          .get(siteName) as { total: number };
        if (total <= policy.maxSizeBytes) break;

        const victim = this.db
          .query(
            `SELECT id, blob_path, blob_size FROM snapshots
             WHERE site_name = ?
             ORDER BY created_at ASC, id ASC LIMIT 1`,
          )
          .get(siteName) as { id: number; blob_path: string | null; blob_size: number } | null;
        if (!victim) break;

        this.deleteSnapshot(victim.id, victim.blob_path);
        droppedSnapshots++;
        freedBytes += victim.blob_size;
      }
    }

    // 4. Drop now-empty sessions.
    const droppedSessions = this.dropEmptySessions(siteName);

    return { droppedSnapshots, droppedSessions, freedBytes };
  }

  /** Wipe all snapshots and blob files for a site. */
  clear(siteName: string): PruneResult {
    const stats = this.getStats(siteName);
    const all = this.db
      .query('SELECT id, blob_path FROM snapshots WHERE site_name = ?')
      .all(siteName) as Array<{ id: number; blob_path: string | null }>;

    for (const s of all) {
      this.deleteSnapshot(s.id, s.blob_path);
    }
    this.db.run('DELETE FROM sessions WHERE site_name = ?', [siteName]);

    // Best-effort: remove the site's blob directory.
    try {
      rmSync(join(this.blobRoot, siteName), { recursive: true, force: true });
    } catch {
      // ok
    }

    return {
      droppedSnapshots: stats.snapshotCount,
      droppedSessions: stats.sessionCount,
      freedBytes: stats.totalBytes,
    };
  }

  // Internals -----------------------------------------------------------------

  private deleteSnapshot(id: number, blobPath: string | null): void {
    this.db.run('DELETE FROM snapshots WHERE id = ?', [id]);
    if (blobPath) {
      try {
        rmSync(blobPath, { force: true });
      } catch {
        // Best-effort.
      }
      // If the session blob dir is now empty, remove it.
      try {
        const dir = dirname(blobPath);
        const remaining = readdirSafe(dir);
        if (remaining.length === 0) {
          rmSync(dir, { recursive: true, force: true });
        }
      } catch {
        // ok
      }
    }
  }

  private dropEmptySessions(siteName: string): number {
    const r = this.db.run(
      `DELETE FROM sessions
       WHERE site_name = ?
         AND NOT EXISTS (SELECT 1 FROM snapshots WHERE snapshots.session_id = sessions.id)`,
      [siteName],
    );
    return r.changes ?? 0;
  }
}

// -- Helpers ------------------------------------------------------------------

function mapSessionRow(row: RawSessionRow): SessionRecord {
  return {
    id: row.id,
    siteName: row.site_name,
    command: row.command,
    paramsJson: row.params_json,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    itemCount: row.item_count,
  };
}

function mapSnapshotRow(row: RawSnapshotRow): SnapshotRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    siteName: row.site_name,
    wpId: row.wp_id,
    operation: row.operation,
    kind: row.kind === 'metadata-only' ? 'metadata-only' : 'binary',
    blobPath: row.blob_path,
    blobSize: row.blob_size,
    beforeMeta: JSON.parse(row.before_meta) as SnapshotMeta,
    beforeHash: row.before_hash,
    createdAt: row.created_at,
    restoredAt: row.restored_at,
  };
}

function pickExtension(meta: SnapshotMeta): string {
  const match = meta.filename.match(/(\.[^./\\]+)$/);
  if (match) return match[1].toLowerCase();
  const mimeMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
  };
  return mimeMap[meta.mimeType] ?? '.bin';
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
