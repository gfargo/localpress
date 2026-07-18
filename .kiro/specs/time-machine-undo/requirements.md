# Time-Machine / Undo

Backfilled spec documenting already-shipped functionality.

This subsystem is localpress's cross-cutting safety net: before any command mutates a WordPress attachment (file bytes or metadata), it captures a snapshot of the pre-change state to local SQLite + on-disk blob storage. The `history` command browses that archive (list, filter, interactive TUI); the `undo` command restores from it. It exists so that AI-driven or bulk operations (`optimize`, `convert`, `resize`, `remove-bg`, `caption`, `title`, `describe`, `classify`, `tag`, `vision`, `rename`, `metadata`, `delete`, `posts update`, `posts delete`, `push --replace`) are always reversible — a wrong bulk run, a bad AI caption, or an accidental delete can be undone without going back to WordPress backups.

## Requirement 1: Automatic pre-change snapshots for mutating commands

**User Story:** As a user (or an AI agent driving localpress via the MCP server), I want every destructive command to automatically save the pre-change state of each attachment it touches, so that I never have to manually back up before running `optimize`, `caption`, or similar bulk operations.

**Acceptance Criteria:**
- WHEN a mutating command (optimize, convert, resize, remove-bg, caption, title, describe, classify, tag, vision, rename, metadata, delete, posts update/delete, push --replace) begins processing items THE SYSTEM SHALL open a session record (`sessions` table) tagged with the command name and its invocation parameters before any WordPress mutation occurs.
- WHEN the command is about to mutate a specific attachment THE SYSTEM SHALL capture a snapshot of that attachment's pre-change state (via `store.capture`) before performing the mutation, so the snapshot always represents state that existed before the write.
- IF an item is skipped for idempotency reasons (e.g. already optimized with the same settings) THEN THE SYSTEM SHALL NOT capture a snapshot for that item, since no snapshot is needed for a no-op.
- IF snapshot capture itself fails (e.g. disk write error) THEN THE SYSTEM SHALL swallow the error and continue the user's operation rather than blocking it — snapshot failures must never prevent the requested work from happening.
- WHEN a command finishes processing all items THE SYSTEM SHALL close the session, recording the number of snapshots captured as `item_count`.
- IF a session's `item_count` is zero when closed (every item was skipped) THEN THE SYSTEM SHALL delete the empty session record so history stays uncluttered.

## Requirement 2: Binary snapshots for file-changing operations

**User Story:** As a user running `optimize`, `convert`, `resize`, `remove-bg`, or a replace-in-place `push`, I want the original file bytes preserved, so that undo can put back the exact original image if the processed result is unsatisfactory.

**Acceptance Criteria:**
- WHEN a command mutates the underlying file bytes of an attachment THE SYSTEM SHALL capture a 'binary' snapshot: the original file bytes written synchronously to a blob file on disk before `capture()` returns, plus a metadata JSON blob (filename, mimeType, alt text, title, caption, description, width, height, size, and slug when applicable) recorded in the `snapshots` row.
- WHEN a binary snapshot's blob is written THE SYSTEM SHALL store it at a path unique to that snapshot row (`<attachmentId>-<rowId><ext>` under the session's blob directory) so repeated snapshots of the same attachment within a session never collide.
- IF the same attachment is captured again within the same session with an unchanged pre-change content hash (`beforeHash`) while an earlier un-restored binary snapshot for it still exists THEN THE SYSTEM SHALL return the existing snapshot's ID instead of writing a redundant blob (in-session dedupe only — not across sessions).
- WHEN restoring a binary snapshot THE SYSTEM SHALL verify, before using the blob, that the file exists on disk, that its byte length matches the recorded `blob_size`, and (if a `beforeHash` was recorded) that its SHA-256 hash matches — refusing to restore from a missing, truncated, or corrupted blob.

## Requirement 3: Metadata-only snapshots for non-file-changing operations

**User Story:** As a user running `caption`, `title`, `describe`, `tag`, `rename`, or `metadata`, I want the previous metadata values preserved without duplicating the (unchanged) image file on disk, so that undo is cheap and fast for text-only edits.

**Acceptance Criteria:**
- WHEN a command changes only WordPress metadata (alt text, title, caption, description, or slug) without touching file bytes THE SYSTEM SHALL capture a 'metadata-only' snapshot: `sourceBytes` is `null`, no blob file is written, and `blob_path`/`blob_size` are recorded as null/zero.
- WHEN a `rename` operation captures a snapshot THE SYSTEM SHALL include the pre-rename `slug` in `beforeMeta` so undo can restore the exact original slug.
- WHEN restoring a metadata-only snapshot THE SYSTEM SHALL call the backend's metadata-update capability with the recorded before-values (alt text, title, caption, description, and slug when present) and SHALL NOT attempt any file replacement.

## Requirement 4: Browsing history (list, filter, show, interactive)

**User Story:** As a user, I want to browse what has been captured — by session or by individual snapshot — so that I can find the right thing to undo before committing to a restore.

**Acceptance Criteria:**
- WHEN a user runs `localpress history` with no filters THE SYSTEM SHALL list recent sessions for the active site (command, item count, start time), most recent first, plus aggregate stats (snapshot count, session count, total bytes on disk).
- WHEN a user runs `localpress history` with `--session`, `--attachment`, or `--operation` THE SYSTEM SHALL list matching individual snapshots instead of sessions, each showing its operation, attachment ID, size (or "meta-only"), timestamp, and restored status.
- WHEN a user runs `localpress history show <id>` THE SYSTEM SHALL detect whether `<id>` is a numeric snapshot ID or an 8-character session-ID prefix, and SHALL display full details for the matching snapshot or session (including all snapshots within that session).
- WHEN a user runs `localpress history -i` THE SYSTEM SHALL launch an interactive Ink TUI with two drill-down views: a session list (navigable with arrow keys or j/k) and, on Enter, that session's snapshot list; Escape/Backspace returns to the session list, and q or Escape at the top level exits.
- WHEN `--json` is passed to any `history` subcommand THE SYSTEM SHALL emit the same data as structured JSON instead of formatted text, since the shape is consumed by the MCP server and other tooling.

## Requirement 5: Restoring a specific snapshot or attachment

**User Story:** As a user (or an AI agent), I want to target a precise snapshot or the most recent change to a specific attachment for restore, so I can fix one mistake without touching everything else that happened in the same session.

**Acceptance Criteria:**
- WHEN a user runs `localpress undo --snapshot <id>` THE SYSTEM SHALL restore exactly that snapshot (if it exists and belongs to the active site), executing immediately without a dry-run gate — mirroring the explicit-IDs-execute-immediately pattern used elsewhere in the CLI.
- WHEN a user runs `localpress undo --attachment <id>` THE SYSTEM SHALL look up the most recent un-restored snapshot for that attachment and restore it immediately, without a dry-run gate.
- IF `--attachment <id>` matches no un-restored snapshot THEN THE SYSTEM SHALL report an error and exit non-zero rather than silently doing nothing.
- WHEN a binary snapshot is restored and replace-in-place is available THE SYSTEM SHALL write the original bytes back to the live attachment; if the attachment's current format differs from the snapshot's original format (e.g. `optimize` converted PNG→WebP), THE SYSTEM SHALL pass the original extension/MIME type through so the file is renamed back and thumbnails are regenerated.
- WHEN a binary restore changes the attachment's URL back (format-restore case) THE SYSTEM SHALL warn the user that content may still reference the old (post-optimize) URL and suggest a full reference re-scan.
- WHEN a restore succeeds in place THE SYSTEM SHALL mark the snapshot as restored (`restored_at` set) and SHALL mark the corresponding `processing_history` row as reverted, so future idempotency checks and cumulative stats treat the attachment as unprocessed again.

## Requirement 6: Restoring the last session (bulk undo) with dry-run safety

**User Story:** As a user, I want `undo` with no arguments to default to reversing my most recent operation, but I want a chance to review what will change before anything is touched, so a careless `undo` doesn't cause a second unwanted mutation.

**Acceptance Criteria:**
- WHEN a user runs `localpress undo` with no session ID and no `--snapshot`/`--attachment` flag THE SYSTEM SHALL target the most recent session for the active site that still has at least one un-restored snapshot (an interrupted session that never explicitly closed is eligible).
- WHEN a user runs `localpress undo <session-prefix>` THE SYSTEM SHALL match sessions by an 8-character-or-longer ID prefix and target all of that session's un-restored snapshots.
- IF no matching session exists (or history is empty) THEN THE SYSTEM SHALL report that there is nothing to undo and exit cleanly rather than erroring.
- WHEN a session-targeted (bulk) undo runs without `--apply` THE SYSTEM SHALL perform a dry run: list what would be restored (attachment, operation, filename) without contacting WordPress, and instruct the user to re-run with `--apply` to execute.
- WHEN a session-targeted undo runs with `--apply` THE SYSTEM SHALL restore each un-restored snapshot in the session, report per-item success/partial/failure, and exit non-zero if any snapshot failed to restore.

## Requirement 7: Partial restore when replace-in-place is unavailable

**User Story:** As a user on a REST-only site (no SSH/WP-CLI configured), I want to know explicitly when `undo` couldn't restore a file in place, so I don't mistakenly believe the original attachment ID now holds the original bytes.

**Acceptance Criteria:**
- IF a binary snapshot's restore cannot use replace-in-place (capability unavailable, non-strict mode) THEN THE SYSTEM SHALL fall back to uploading the original bytes as a brand-new WordPress attachment and report the outcome as 'partial', not 'restored'.
- WHEN a restore outcome is 'partial' THE SYSTEM SHALL NOT mark the original snapshot as restored, leaving it available for a later retry once a replace-in-place-capable backend (SSH/WP-CLI) is configured.
- WHEN a restore outcome is 'partial' THE SYSTEM SHALL surface the new attachment ID to the user and note that references still point at the original (now-unchanged) attachment, suggesting `localpress references <old-id> --update-to <new-id>` as a follow-up.
- IF `--strict` is passed and replace-in-place is unavailable THEN THE SYSTEM SHALL throw rather than silently falling back to upload-as-new.

## Requirement 8: Retention policy and manual pruning

**User Story:** As a user with a large media library, I want old snapshots automatically capped so the time-machine archive doesn't grow unbounded on disk, while still being able to prune or wipe it manually when I want the space back.

**Acceptance Criteria:**
- WHEN history is enabled (the default) THE SYSTEM SHALL enforce a per-site retention cap on total snapshot bytes, defaulting to 2 GiB, configurable via `config set history.maxSizeBytes <bytes>`.
- WHEN a mutating command's session closes THE SYSTEM SHALL apply the configured size-based retention policy automatically, dropping the oldest snapshots first until total size is at or below the cap.
- WHEN a user runs `localpress history prune` THE SYSTEM SHALL apply retention rules on demand, combining any provided `--max-size`, `--older-than <days>`, and `--max-sessions <n>` clauses — a snapshot is dropped if it falls outside ANY supplied clause.
- WHEN snapshots are dropped (by auto-retention or `prune`) THE SYSTEM SHALL delete both the SQLite row and the on-disk blob file (best-effort), and SHALL remove now-empty session directories and now-empty session rows.
- WHEN a user runs `localpress history clear` without `--yes` (and no global `--yes`) THE SYSTEM SHALL refuse to proceed, warn how many snapshots/bytes would be deleted, and exit with a non-zero code requiring explicit confirmation.
- WHEN `history clear --yes` is confirmed THE SYSTEM SHALL delete every snapshot and session for the active site, including the site's entire blob directory.
- IF `history.enabled` is set to `false` in config THEN THE SYSTEM SHALL resolve retention as disabled and mutating commands SHALL NOT open history sessions or capture snapshots for that invocation.
