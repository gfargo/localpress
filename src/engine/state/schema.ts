/**
 * SQLite schema for per-site attachment state and processing history.
 *
 * One database file per configured site, stored at:
 *   $XDG_CONFIG_HOME/localpress/sites/<name>.db
 *
 * The schema is intentionally minimal for v0.1. Migrations will be added
 * as we extend it for full reference scanning, multi-site bulk operations, etc.
 *
 * See docs/v1-plan.md §5 "State management" for the design rationale.
 */

/**
 * Schema version. Bumped on every migration.
 * On startup, the DB layer compares this against the stored value and applies
 * pending migrations.
 */
export const SCHEMA_VERSION = 2;

/**
 * Initial schema (v1). Idempotent — safe to run on every CLI invocation.
 * `IF NOT EXISTS` everywhere; new tables/columns go in subsequent migrations.
 */
export const INITIAL_SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS sites (
  name        TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  site_name        TEXT NOT NULL,
  wp_id            INTEGER NOT NULL,
  source_url       TEXT NOT NULL,
  source_hash      TEXT,
  size_bytes       INTEGER,
  width            INTEGER,
  height           INTEGER,
  mime_type        TEXT,
  last_seen_at     INTEGER NOT NULL,
  PRIMARY KEY (site_name, wp_id),
  FOREIGN KEY (site_name) REFERENCES sites(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_last_seen
  ON attachments(site_name, last_seen_at);

CREATE TABLE IF NOT EXISTS processing_history (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  site_name        TEXT NOT NULL,
  wp_id            INTEGER NOT NULL,
  operation        TEXT NOT NULL,
  params_json      TEXT,
  source_hash      TEXT,
  result_hash      TEXT,
  bytes_before     INTEGER,
  bytes_after      INTEGER,
  result_wp_id     INTEGER,
  ran_at           INTEGER NOT NULL,
  duration_ms      INTEGER,
  status           TEXT NOT NULL DEFAULT 'success',
  error_message    TEXT,
  FOREIGN KEY (site_name, wp_id) REFERENCES attachments(site_name, wp_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_processing_attachment
  ON processing_history(site_name, wp_id, ran_at DESC);

CREATE INDEX IF NOT EXISTS idx_processing_operation
  ON processing_history(site_name, operation, ran_at DESC);
`;

/**
 * Future migrations live here. Append new entries; never modify existing ones.
 * The migration runner applies any whose version > current.
 */
export interface Migration {
  version: number;
  description: string;
  up: string;
}

export const MIGRATIONS: Migration[] = [
  // Migration 1 IS the initial schema. Subsequent migrations start at 2.
  {
    version: 2,
    description: 'Add preferences key-value table for UI state persistence',
    up: `
      CREATE TABLE IF NOT EXISTS preferences (
        site_name  TEXT NOT NULL,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (site_name, key),
        FOREIGN KEY (site_name) REFERENCES sites(name) ON DELETE CASCADE
      );
    `,
  },
];
