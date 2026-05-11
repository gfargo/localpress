/**
 * History subsystem entry points.
 *
 * Re-exports the SnapshotStore + types, plus the helpers commands use to
 * minimize per-command integration code:
 *
 *   - `openHistorySession(db, site, command, params)` — start a session
 *   - `captureSnapshot(...)` — capture a pre-change snapshot for one attachment
 *   - `closeHistorySession(...)` — close (and auto-prune to policy)
 *   - `getHistoryBlobRoot(configDir)` — resolves the blob root path
 *
 * Commands should treat this as the public API; don't reach into SnapshotStore
 * directly unless you need bulk operations (history/undo commands do).
 */

import { join } from 'node:path';
import type { SiteDb } from '../state/db.ts';
import { SnapshotStore } from './store.ts';
import type { CaptureOptions } from './store.ts';
import type { SessionRecord } from './types.ts';

export { SnapshotStore } from './store.ts';
export type { CaptureOptions } from './store.ts';
export type {
  HistoryStats,
  PrunePolicy,
  PruneResult,
  SessionRecord,
  SnapshotKind,
  SnapshotMeta,
  SnapshotRecord,
} from './types.ts';

/**
 * Default retention policy: cap total snapshot size at 2 GB per site.
 * Override via `config set history.maxSizeBytes <bytes>`.
 */
export const DEFAULT_MAX_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

/** Root directory for blob storage, given the localpress config dir. */
export function getHistoryBlobRoot(configDir: string): string {
  return join(configDir, 'snapshots');
}

/**
 * Resolve the configured retention settings, falling back to defaults.
 * Returns null for maxSizeBytes if history is disabled entirely.
 */
export function resolveHistoryConfig(historyConfig?: HistoryConfig): {
  enabled: boolean;
  maxSizeBytes: number;
} {
  return {
    enabled: historyConfig?.enabled !== false,
    maxSizeBytes: historyConfig?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES,
  };
}

/** Shape stored in config.json under `history`. */
export interface HistoryConfig {
  enabled?: boolean;
  maxSizeBytes?: number;
}

/** Construct a SnapshotStore bound to a site's SQLite db. */
export function openSnapshotStore(db: SiteDb, configDir: string): SnapshotStore {
  // SnapshotStore wants the underlying bun:sqlite Database, not the SiteDb
  // wrapper. We expose it via a getter on SiteDb (added in db.ts).
  return new SnapshotStore(db.raw(), getHistoryBlobRoot(configDir));
}

/**
 * Helper used by every destructive command:
 *
 *   const session = openHistorySession(db, blobRoot, site.name, 'optimize', { profile });
 *   try {
 *     for (const item of items) {
 *       // ... do work ...
 *       captureSnapshot({ store, sessionId: session.id, ... });
 *       // ... mutate WP ...
 *     }
 *   } finally {
 *     closeHistorySession(store, session, { maxSizeBytes });
 *   }
 */
export function openHistorySession(
  store: SnapshotStore,
  siteName: string,
  command: string,
  params?: unknown,
): SessionRecord {
  return store.openSession(siteName, command, params);
}

export function closeHistorySession(
  store: SnapshotStore,
  session: SessionRecord,
  retention: { maxSizeBytes?: number } = {},
): void {
  store.closeSession(session.id);
  if (retention.maxSizeBytes && retention.maxSizeBytes > 0) {
    store.prune(session.siteName, { maxSizeBytes: retention.maxSizeBytes });
  }
}

/** Thin wrapper for the common capture pattern. Errors are swallowed (best-effort). */
export function captureSnapshot(store: SnapshotStore, opts: CaptureOptions): number | null {
  try {
    return store.capture(opts);
  } catch {
    // Snapshot failures must never block a user operation. Log nothing for
    // now — a future enhancement could surface via stderr.
    return null;
  }
}
