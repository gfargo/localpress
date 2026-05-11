/**
 * Types for the time-machine / undo subsystem.
 *
 * A "session" is one command invocation. A "snapshot" is the pre-change state
 * of one attachment captured during that session. A session has zero or more
 * snapshots; each snapshot belongs to exactly one session.
 *
 * Snapshots come in two flavors:
 *   - 'binary': we stored the original file bytes on disk. Used for ops that
 *     mutate the actual image file (optimize, convert, resize, remove-bg,
 *     push --replace).
 *   - 'metadata-only': no file bytes stored — the op only changed WP metadata
 *     (alt text, title, caption). Used for caption.
 */

export type SnapshotKind = 'binary' | 'metadata-only';

/** WP metadata captured at snapshot time. Used to restore on undo. */
export interface SnapshotMeta {
  filename: string;
  mimeType: string;
  altText?: string;
  title?: string;
  caption?: string;
  description?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface SessionRecord {
  id: string;
  siteName: string;
  command: string;
  paramsJson: string | null;
  startedAt: number;
  finishedAt: number | null;
  itemCount: number;
}

export interface SnapshotRecord {
  id: number;
  sessionId: string;
  siteName: string;
  wpId: number;
  operation: string;
  kind: SnapshotKind;
  /** Absolute path to the blob file on disk. Null for metadata-only snapshots. */
  blobPath: string | null;
  blobSize: number;
  beforeMeta: SnapshotMeta;
  beforeHash: string | null;
  createdAt: number;
  restoredAt: number | null;
}

export interface HistoryStats {
  snapshotCount: number;
  sessionCount: number;
  totalBytes: number;
  oldestSnapshotAt: number | null;
  newestSnapshotAt: number | null;
}

export interface PrunePolicy {
  /** Drop snapshots until total size is ≤ this many bytes. */
  maxSizeBytes?: number;
  /** Drop snapshots older than this Unix timestamp. */
  olderThan?: number;
  /** Keep only the N most recent sessions; drop older ones. */
  maxSessions?: number;
}

export interface PruneResult {
  droppedSnapshots: number;
  droppedSessions: number;
  freedBytes: number;
}
