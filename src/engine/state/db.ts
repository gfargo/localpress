/**
 * SQLite state layer. Wraps `bun:sqlite` with localpress-specific helpers.
 *
 * Stub for v0.1; the migration runner and repository methods land in the
 * v0.1 implementation pass.
 */

// import { Database } from 'bun:sqlite';
import type { Database } from 'bun:sqlite';

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
 *   const db = await openSiteDb('production');
 *   const attachment = db.getAttachment(123);
 *   db.close();
 */
export class SiteDb {
  constructor(private readonly db: Database) {}

  /** Apply the initial schema and any pending migrations. */
  static async init(_dbPath: string): Promise<SiteDb> {
    // TODO(v0.1):
    //   1. const db = new Database(dbPath, { create: true })
    //   2. Execute INITIAL_SCHEMA
    //   3. Read current schema_version, run any MIGRATIONS with version > current
    //   4. Insert/update schema_version row
    throw new Error('SiteDb.init not yet implemented');
  }

  // Attachment CRUD -----------------------------------------------------------

  upsertAttachment(_record: AttachmentRecord): void {
    throw new Error('SiteDb.upsertAttachment not yet implemented');
  }

  getAttachment(_siteName: string, _wpId: number): AttachmentRecord | null {
    throw new Error('SiteDb.getAttachment not yet implemented');
  }

  listAttachments(_siteName: string): AttachmentRecord[] {
    throw new Error('SiteDb.listAttachments not yet implemented');
  }

  // Processing history --------------------------------------------------------

  recordProcessing(_record: Omit<ProcessingHistoryRecord, 'id'>): number {
    throw new Error('SiteDb.recordProcessing not yet implemented');
  }

  getLastProcessing(
    _siteName: string,
    _wpId: number,
    _operation?: string,
  ): ProcessingHistoryRecord | null {
    throw new Error('SiteDb.getLastProcessing not yet implemented');
  }

  // Lifecycle -----------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}

/** Read the current schema version stored in the DB. */
export function getStoredSchemaVersion(_db: Database): number {
  // TODO(v0.1): SELECT version FROM schema_version LIMIT 1
  throw new Error('getStoredSchemaVersion not yet implemented');
}

// Re-export for convenience.
export { SCHEMA_VERSION, INITIAL_SCHEMA, MIGRATIONS };
