/**
 * SQLite state layer. Wraps `bun:sqlite` with localpress-specific helpers.
 *
 * Per-site database stored at $XDG_CONFIG_HOME/localpress/sites/<name>.db.
 * Uses WAL mode for concurrent read safety and foreign keys for integrity.
 */

import { Database } from 'bun:sqlite';

import { INITIAL_SCHEMA, MIGRATIONS, SCHEMA_VERSION } from './schema.ts';

export interface AttachmentRecord {
  siteName: string;
  wpId: number;
  sourceUrl: string;
  sourceHash: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  lastSeenAt: number;
}

export interface ProcessingHistoryRecord {
  id: number;
  siteName: string;
  wpId: number;
  operation: string;
  paramsJson: string | null;
  sourceHash: string | null;
  resultHash: string | null;
  bytesBefore: number | null;
  bytesAfter: number | null;
  resultWpId: number | null;
  ranAt: number;
  durationMs: number | null;
  status: 'success' | 'failure';
  errorMessage: string | null;
}

/**
 * Per-site database connection.
 *
 * Usage:
 *   const db = SiteDb.init(':memory:');  // or a real path
 *   db.upsertAttachment({ ... });
 *   const attachment = db.getAttachment('mysite', 123);
 *   db.close();
 */
export class SiteDb {
  constructor(private readonly db: Database) {}

  /**
   * Open (or create) a site database, apply the initial schema,
   * and run any pending migrations.
   */
  static init(dbPath: string): SiteDb {
    const db = new Database(dbPath, { create: true });

    // Apply the initial schema (idempotent — uses IF NOT EXISTS).
    db.exec(INITIAL_SCHEMA);

    const stored = getStoredSchemaVersion(db);

    // Run any migrations newer than the stored version.
    for (const migration of MIGRATIONS) {
      if (migration.version > stored) {
        db.exec(migration.up);
      }
    }

    // Upsert the schema version.
    db.run(
      `INSERT INTO schema_version (version) VALUES (?)
       ON CONFLICT (version) DO UPDATE SET version = excluded.version`,
      [SCHEMA_VERSION],
    );

    return new SiteDb(db);
  }

  /**
   * Escape hatch for subsystems that need direct SQLite access (e.g. the
   * SnapshotStore, which owns its own tables but shares the per-site db).
   * Prefer the typed helpers on SiteDb when one exists for your use case.
   */
  raw(): Database {
    return this.db;
  }

  // Site CRUD -----------------------------------------------------------------

  /** Ensure a site row exists (needed for foreign keys on attachments). */
  ensureSite(name: string, url: string): void {
    this.db.run(
      `INSERT INTO sites (name, url, created_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET url = excluded.url`,
      [name, url, Date.now()],
    );
  }

  // Attachment CRUD -----------------------------------------------------------

  upsertAttachment(record: AttachmentRecord): void {
    this.db.run(
      `INSERT INTO attachments
         (site_name, wp_id, source_url, source_hash, size_bytes, width, height, mime_type, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_name, wp_id) DO UPDATE SET
         source_url   = excluded.source_url,
         source_hash  = excluded.source_hash,
         size_bytes   = excluded.size_bytes,
         width        = excluded.width,
         height       = excluded.height,
         mime_type    = excluded.mime_type,
         last_seen_at = excluded.last_seen_at`,
      [
        record.siteName,
        record.wpId,
        record.sourceUrl,
        record.sourceHash,
        record.sizeBytes,
        record.width,
        record.height,
        record.mimeType,
        record.lastSeenAt,
      ],
    );
  }

  getAttachment(siteName: string, wpId: number): AttachmentRecord | null {
    const row = this.db
      .query(
        `SELECT site_name, wp_id, source_url, source_hash, size_bytes,
                width, height, mime_type, last_seen_at
         FROM attachments
         WHERE site_name = ? AND wp_id = ?`,
      )
      .get(siteName, wpId) as RawAttachmentRow | null;

    return row ? mapAttachmentRow(row) : null;
  }

  listAttachments(siteName: string): AttachmentRecord[] {
    const rows = this.db
      .query(
        `SELECT site_name, wp_id, source_url, source_hash, size_bytes,
                width, height, mime_type, last_seen_at
         FROM attachments
         WHERE site_name = ?
         ORDER BY wp_id ASC`,
      )
      .all(siteName) as RawAttachmentRow[];

    return rows.map(mapAttachmentRow);
  }

  /** List attachment IDs that have been processed (have processing_history). */
  listProcessedWpIds(siteName: string): Set<number> {
    const rows = this.db
      .query(
        `SELECT DISTINCT wp_id FROM processing_history
         WHERE site_name = ? AND status = 'success'`,
      )
      .all(siteName) as Array<{ wp_id: number }>;

    return new Set(rows.map((r) => r.wp_id));
  }

  // Processing history --------------------------------------------------------

  recordProcessing(record: Omit<ProcessingHistoryRecord, 'id'>): number {
    const result = this.db.run(
      `INSERT INTO processing_history
         (site_name, wp_id, operation, params_json, source_hash, result_hash,
          bytes_before, bytes_after, result_wp_id, ran_at, duration_ms, status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.siteName,
        record.wpId,
        record.operation,
        record.paramsJson,
        record.sourceHash,
        record.resultHash,
        record.bytesBefore,
        record.bytesAfter,
        record.resultWpId,
        record.ranAt,
        record.durationMs,
        record.status,
        record.errorMessage,
      ],
    );

    return Number(result.lastInsertRowid);
  }

  getLastProcessing(
    siteName: string,
    wpId: number,
    operation?: string,
  ): ProcessingHistoryRecord | null {
    let sql = `SELECT id, site_name, wp_id, operation, params_json, source_hash,
                      result_hash, bytes_before, bytes_after, result_wp_id,
                      ran_at, duration_ms, status, error_message
               FROM processing_history
               WHERE site_name = ? AND wp_id = ?`;
    const params: Array<string | number> = [siteName, wpId];

    if (operation) {
      sql += ' AND operation = ?';
      params.push(operation);
    }

    sql += ' ORDER BY ran_at DESC LIMIT 1';

    const row = this.db.query(sql).get(...params) as RawProcessingRow | null;
    return row ? mapProcessingRow(row) : null;
  }

  // Stats ---------------------------------------------------------------------

  getStats(siteName: string): SiteStats {
    const ops = this.db
      .query(
        `SELECT operation,
              COUNT(*)                                          AS total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
              SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN bytes_before > bytes_after THEN bytes_before - bytes_after ELSE 0 END) AS bytes_saved,
              SUM(bytes_before)                                 AS bytes_in,
              SUM(bytes_after)                                  AS bytes_out,
              SUM(duration_ms)                                  AS total_ms,
              MAX(ran_at)                                       AS last_ran_at
       FROM processing_history
       WHERE site_name = ?
       GROUP BY operation
       ORDER BY total DESC`,
      )
      .all(siteName) as RawOpStat[];

    const totals = this.db
      .query(
        `SELECT COUNT(DISTINCT wp_id)                                       AS files_touched,
              SUM(CASE WHEN bytes_before > bytes_after THEN bytes_before - bytes_after ELSE 0 END) AS bytes_saved,
              SUM(bytes_before)                                           AS bytes_in,
              COUNT(*)                                                    AS total_ops,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)        AS succeeded,
              MAX(ran_at)                                                 AS last_ran_at
       FROM processing_history
       WHERE site_name = ?`,
      )
      .get(siteName) as RawTotalStat | null;

    return {
      siteName,
      filesTouched: totals?.files_touched ?? 0,
      totalOps: totals?.total_ops ?? 0,
      succeeded: totals?.succeeded ?? 0,
      bytesSaved: totals?.bytes_saved ?? 0,
      bytesIn: totals?.bytes_in ?? 0,
      lastRanAt: totals?.last_ran_at ?? null,
      byOperation: ops.map((r) => ({
        operation: r.operation,
        total: r.total,
        succeeded: r.succeeded,
        failed: r.failed,
        bytesSaved: r.bytes_saved ?? 0,
        bytesIn: r.bytes_in ?? 0,
        bytesOut: r.bytes_out ?? 0,
        avgDurationMs: r.total_ms && r.succeeded ? Math.round(r.total_ms / r.succeeded) : null,
        lastRanAt: r.last_ran_at,
      })),
    };
  }

  // Library overview -----------------------------------------------------------

  /** Get total attachment count and total size for a site. */
  getLibraryOverview(siteName: string): LibraryOverview {
    const row = this.db
      .query(
        `SELECT COUNT(*)          AS total_attachments,
                COALESCE(SUM(size_bytes), 0) AS total_size_bytes
         FROM attachments
         WHERE site_name = ?`,
      )
      .get(siteName) as { total_attachments: number; total_size_bytes: number } | null;

    const processedCount = this.db
      .query(
        `SELECT COUNT(DISTINCT wp_id) AS optimized
         FROM processing_history
         WHERE site_name = ? AND status = 'success'`,
      )
      .get(siteName) as { optimized: number } | null;

    const totalAttachments = row?.total_attachments ?? 0;
    const optimized = processedCount?.optimized ?? 0;

    return {
      totalAttachments,
      totalSizeBytes: row?.total_size_bytes ?? 0,
      optimized,
      unoptimized: totalAttachments - optimized,
    };
  }

  /** Get format breakdown (MIME type counts) for a site. */
  getFormatBreakdown(siteName: string): FormatCount[] {
    const rows = this.db
      .query(
        `SELECT mime_type, COUNT(*) AS count
         FROM attachments
         WHERE site_name = ? AND mime_type IS NOT NULL
         GROUP BY mime_type
         ORDER BY count DESC`,
      )
      .all(siteName) as Array<{ mime_type: string; count: number }>;

    return rows.map((r) => ({
      mimeType: r.mime_type,
      count: r.count,
    }));
  }

  /** Get recent operations grouped by date and operation type. */
  getRecentOperations(siteName: string, limit = 10): RecentOperation[] {
    const rows = this.db
      .query(
        `SELECT DATE(ran_at / 1000, 'unixepoch') AS date,
                operation,
                COUNT(*)                          AS item_count,
                SUM(CASE WHEN bytes_before > bytes_after THEN bytes_before - bytes_after ELSE 0 END) AS bytes_saved
         FROM processing_history
         WHERE site_name = ? AND status = 'success'
         GROUP BY date, operation
         ORDER BY date DESC, item_count DESC
         LIMIT ?`,
      )
      .all(siteName, limit) as Array<{
      date: string;
      operation: string;
      item_count: number;
      bytes_saved: number | null;
    }>;

    return rows.map((r) => ({
      date: r.date,
      operation: r.operation,
      itemCount: r.item_count,
      bytesSaved: r.bytes_saved ?? 0,
    }));
  }

  // Lifecycle -----------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  // Preferences (key-value) ---------------------------------------------------

  /** Get a preference value. Returns null if not set. */
  getPref(siteName: string, key: string): string | null {
    const row = this.db
      .query('SELECT value FROM preferences WHERE site_name = ? AND key = ?')
      .get(siteName, key) as { value: string } | null;
    return row?.value ?? null;
  }

  /** Set a preference value. Upserts. */
  setPref(siteName: string, key: string, value: string): void {
    this.db.run(
      `INSERT INTO preferences (site_name, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (site_name, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [siteName, key, value, Date.now()],
    );
  }

  // Watch mappings (file→attachment tracking) ---------------------------------

  /** Get the watch mapping for a file path in a watched directory. */
  getWatchMapping(siteName: string, watchDir: string, relPath: string): WatchMapping | null {
    const row = this.db
      .query(
        `SELECT site_name, watch_dir, rel_path, file_hash, wp_id, updated_at
         FROM watch_mappings
         WHERE site_name = ? AND watch_dir = ? AND rel_path = ?`,
      )
      .get(siteName, watchDir, relPath) as RawWatchMappingRow | null;

    return row ? mapWatchMappingRow(row) : null;
  }

  /** Upsert a watch mapping (file→attachment). */
  upsertWatchMapping(
    siteName: string,
    watchDir: string,
    relPath: string,
    fileHash: string,
    wpId: number,
  ): void {
    this.db.run(
      `INSERT INTO watch_mappings (site_name, watch_dir, rel_path, file_hash, wp_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (site_name, watch_dir, rel_path) DO UPDATE SET
         file_hash  = excluded.file_hash,
         wp_id      = excluded.wp_id,
         updated_at = excluded.updated_at`,
      [siteName, watchDir, relPath, fileHash, wpId, Date.now()],
    );
  }

  /** Remove a watch mapping (e.g. when a file is deleted). */
  removeWatchMapping(siteName: string, watchDir: string, relPath: string): void {
    this.db.run(
      `DELETE FROM watch_mappings
       WHERE site_name = ? AND watch_dir = ? AND rel_path = ?`,
      [siteName, watchDir, relPath],
    );
  }

  /** List all watch mappings for a directory. */
  listWatchMappings(siteName: string, watchDir: string): WatchMapping[] {
    const rows = this.db
      .query(
        `SELECT site_name, watch_dir, rel_path, file_hash, wp_id, updated_at
         FROM watch_mappings
         WHERE site_name = ? AND watch_dir = ?
         ORDER BY rel_path ASC`,
      )
      .all(siteName, watchDir) as RawWatchMappingRow[];

    return rows.map(mapWatchMappingRow);
  }

  /**
   * Summary of every directory that has ever been watched on a site.
   * Returns one row per unique watch_dir with file count + most-recent
   * activity timestamp. Used by `watch-status` to report orchestration state.
   */
  summarizeWatchDirectories(
    siteName: string,
  ): Array<{ watchDir: string; fileCount: number; lastActivityAt: number }> {
    const rows = this.db
      .query(
        `SELECT watch_dir, COUNT(*) AS file_count, MAX(updated_at) AS last_activity
         FROM watch_mappings
         WHERE site_name = ?
         GROUP BY watch_dir
         ORDER BY last_activity DESC`,
      )
      .all(siteName) as Array<{
      watch_dir: string;
      file_count: number;
      last_activity: number;
    }>;
    return rows.map((r) => ({
      watchDir: r.watch_dir,
      fileCount: r.file_count,
      lastActivityAt: r.last_activity,
    }));
  }
}

// -- Internal row types and mappers -------------------------------------------

interface RawAttachmentRow {
  site_name: string;
  wp_id: number;
  source_url: string;
  source_hash: string | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  last_seen_at: number;
}

function mapAttachmentRow(row: RawAttachmentRow): AttachmentRecord {
  return {
    siteName: row.site_name,
    wpId: row.wp_id,
    sourceUrl: row.source_url,
    sourceHash: row.source_hash,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    mimeType: row.mime_type,
    lastSeenAt: row.last_seen_at,
  };
}

interface RawProcessingRow {
  id: number;
  site_name: string;
  wp_id: number;
  operation: string;
  params_json: string | null;
  source_hash: string | null;
  result_hash: string | null;
  bytes_before: number | null;
  bytes_after: number | null;
  result_wp_id: number | null;
  ran_at: number;
  duration_ms: number | null;
  status: 'success' | 'failure';
  error_message: string | null;
}

function mapProcessingRow(row: RawProcessingRow): ProcessingHistoryRecord {
  return {
    id: row.id,
    siteName: row.site_name,
    wpId: row.wp_id,
    operation: row.operation,
    paramsJson: row.params_json,
    sourceHash: row.source_hash,
    resultHash: row.result_hash,
    bytesBefore: row.bytes_before,
    bytesAfter: row.bytes_after,
    resultWpId: row.result_wp_id,
    ranAt: row.ran_at,
    durationMs: row.duration_ms,
    status: row.status,
    errorMessage: row.error_message,
  };
}

// -- Stats types --------------------------------------------------------------

export interface OperationStat {
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  bytesSaved: number;
  bytesIn: number;
  bytesOut: number;
  avgDurationMs: number | null;
  lastRanAt: number;
}

export interface SiteStats {
  siteName: string;
  filesTouched: number;
  totalOps: number;
  succeeded: number;
  bytesSaved: number;
  bytesIn: number;
  lastRanAt: number | null;
  byOperation: OperationStat[];
}

interface RawOpStat {
  operation: string;
  total: number;
  succeeded: number;
  failed: number;
  bytes_saved: number | null;
  bytes_in: number | null;
  bytes_out: number | null;
  total_ms: number | null;
  last_ran_at: number;
}

interface RawTotalStat {
  files_touched: number;
  bytes_saved: number | null;
  bytes_in: number | null;
  total_ops: number;
  succeeded: number;
  last_ran_at: number | null;
}

// -- Library overview types ---------------------------------------------------

export interface LibraryOverview {
  totalAttachments: number;
  totalSizeBytes: number;
  optimized: number;
  unoptimized: number;
}

export interface FormatCount {
  mimeType: string;
  count: number;
}

export interface RecentOperation {
  date: string;
  operation: string;
  itemCount: number;
  bytesSaved: number;
}

/** Read the current schema version stored in the DB. Returns 0 if no version row exists. */
export function getStoredSchemaVersion(db: Database): number {
  try {
    const row = db
      .query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | null;
    return row?.version ?? 0;
  } catch {
    // Table may not exist yet on first run.
    return 0;
  }
}

// Re-export for convenience.
export { SCHEMA_VERSION, INITIAL_SCHEMA, MIGRATIONS };

// -- Watch mapping types ------------------------------------------------------

export interface WatchMapping {
  siteName: string;
  watchDir: string;
  relPath: string;
  fileHash: string;
  wpId: number;
  updatedAt: number;
}

interface RawWatchMappingRow {
  site_name: string;
  watch_dir: string;
  rel_path: string;
  file_hash: string;
  wp_id: number;
  updated_at: number;
}

function mapWatchMappingRow(row: RawWatchMappingRow): WatchMapping {
  return {
    siteName: row.site_name,
    watchDir: row.watch_dir,
    relPath: row.rel_path,
    fileHash: row.file_hash,
    wpId: row.wp_id,
    updatedAt: row.updated_at,
  };
}
