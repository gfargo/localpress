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

  // Lifecycle -----------------------------------------------------------------

  close(): void {
    this.db.close();
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
