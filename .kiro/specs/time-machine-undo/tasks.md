# Time-Machine / Undo — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core engine (state + storage)

- [x] Add schema v4 migration: `sessions` table (id, site_name, command, params_json, started_at, finished_at, item_count) + `snapshots` table (id, session_id, site_name, wp_id, operation, kind, blob_path, blob_size, before_meta, before_hash, created_at, restored_at), with supporting indexes (`idx_sessions_site_started`, `idx_snapshots_site_created`, `idx_snapshots_session`, `idx_snapshots_wp_id`) and `ON DELETE CASCADE` FKs — `src/engine/state/schema.ts` (Req 1, 2, 3)
- [x] Add schema v5 migration: `processing_history.reverted_at` column so undo can exclude reverted rows from idempotency/stats — `src/engine/state/schema.ts` (Req 5)
- [x] Implement `SnapshotStore` session lifecycle: `openSession`, `closeSession` (with empty-session auto-delete), `listSessions`, `getSession`, `getLastSession` (interrupted-session-aware, restored-session-skipping query) — `src/engine/history/store.ts` (Req 1, 6)
- [x] Implement `SnapshotStore.capture()`: binary vs. metadata-only branch on `sourceBytes`, synchronous blob write before DB pointer update, unique per-row blob filenames, in-session hash-based dedupe via `findActiveSnapshotByHash` — `src/engine/history/store.ts` (Req 2, 3)
- [x] Implement snapshot read/query methods: `getSnapshot`, `listSnapshots` (session/attachment/operation filters), `getLastSnapshotForAttachment`, `markRestored` — `src/engine/history/store.ts` (Req 4, 5)
- [x] Implement `readBlob()` with existence, byte-length, and SHA-256 hash verification before returning bytes — `src/engine/history/store.ts` (Req 2)
- [x] Implement retention: `getStats`, `prune()` (age / max-sessions / max-size clauses, OR-combined, oldest-first eviction), `clear()` (full wipe + blob directory removal), best-effort blob/dir cleanup in `deleteSnapshot`/`dropEmptySessions` — `src/engine/history/store.ts` (Req 8)
- [x] Add `db.markProcessingReverted(siteName, wpId, operation)` to flip `reverted_at` on the most recent matching `processing_history` row — `src/engine/state/db.ts` (Req 5)
- [x] Expose `SiteDb.raw()` so `SnapshotStore` can be constructed directly against the underlying `bun:sqlite` handle — `src/engine/state/db.ts` (supports all)
- [x] Build the command-facing convenience API: `openSnapshotStore`, `openHistorySession`, `captureSnapshot` (best-effort, swallows errors), `closeHistorySession` (close + auto-prune), `resolveHistoryConfig`, `getHistoryBlobRoot`, `DEFAULT_MAX_SIZE_BYTES` — `src/engine/history/index.ts` (Req 1, 8)

## CLI command wiring

- [x] Wire `captureSnapshot`/`openHistorySession`/`closeHistorySession` into every mutating command's per-item loop, capturing after the idempotency check and before the WordPress write: `optimize`, `convert`, `resize`, `remove-bg`, `caption`, `title`, `describe`, `classify`, `tag`, `vision`, `rename`, `metadata`, `delete`, `posts update`, `posts delete`, `push --replace` — `src/cli/commands/*.ts` (Req 1, 2, 3)
- [x] Implement `history` command: default session list + stats, `--session`/`--attachment`/`--operation` snapshot filters, `--limit`, `--json` — `src/cli/commands/history.ts` (Req 4)
- [x] Implement `history show <id>` with numeric-vs-session-prefix dispatch — `src/cli/commands/history.ts` (Req 4)
- [x] Implement `history prune` with `--max-size`/`--older-than`/`--max-sessions` overrides — `src/cli/commands/history.ts` (Req 8)
- [x] Implement `history clear` with `--yes` confirmation gate (exit code 2 without it) — `src/cli/commands/history.ts` (Req 8)
- [x] Implement `history -i` interactive launch (renders `HistoryBrowser`, handles empty-history case) — `src/cli/commands/history.ts` (Req 4)
- [x] Build `HistoryBrowser` Ink TUI: session list view, drill-down snapshot view, arrow/j-k navigation, Esc/Backspace back, q quit — `src/cli/components/HistoryBrowser.tsx` (Req 4)
- [x] Implement `undo` command: target resolution (`--snapshot`, `--attachment`, session prefix, default-to-last-session), dry-run-unless-`--apply` gate for bulk/session targets, immediate execution for explicit single-item targets, per-result reporting (restored/partial/failed/skipped), non-zero exit on any failure — `src/cli/commands/undo.ts` (Req 5, 6, 7)
- [x] Implement `restoreSnapshot()`: metadata-only branch (`updateMetadata` with before-values, conditional slug forwarding), binary branch (blob read + integrity check, format-change detection via live `getMedia`, `replaceInPlace` with `newExtension`/`newMimeType`/`regenerateThumbnails`, stale-URL warning, upload-as-new fallback marked `'partial'`, `--strict` propagation of `CapabilityUnavailableError`) — `src/cli/commands/undo.ts` (Req 2, 3, 5, 7)
- [x] Call `store.markRestored()` + `db.markProcessingReverted()` only on fully in-place `'restored'` outcomes, explicitly skipping both for `'partial'` outcomes so the snapshot stays retryable — `src/cli/commands/undo.ts` (Req 5, 7)
- [x] Add `history.enabled` / `history.maxSizeBytes` config keys with validation — `src/cli/commands/config.ts` (Req 8)

## MCP tool wiring

- [x] Add `history_list` MCP tool (session: filter, attachment: filter, operation: enum filter, limit) shelling out to `localpress history` — `src/cli/mcp/tools.ts` (Req 4)
- [x] Add `history_show` MCP tool (session-prefix or snapshot-ID lookup) — `src/cli/mcp/tools.ts` (Req 4)
- [x] Add `undo` MCP tool (sessionId, snapshot, attachment, apply) mapping directly to the CLI's targeting modes and dry-run gate — `src/cli/mcp/tools.ts` (Req 5, 6, 7)
- [x] Add `history_prune` MCP tool (maxSize, olderThan, maxSessions overrides) — `src/cli/mcp/tools.ts` (Req 8)
- [x] Add `localpress://history` MCP resource for read-only agent context (recent sessions/snapshots, retention status) — `src/cli/mcp/resources.ts` (Req 4)

## Tests

- [x] `SnapshotStore` unit tests: session lifecycle, binary/metadata-only capture, synchronous blob durability, empty-session pruning, size/age-cap prune, clear, last-snapshot-for-attachment (including restored-fallback), in-session hash dedupe, stats, slug round-trip, interrupted/restored `getLastSession` cases, all `readBlob` integrity failure modes — `test/unit/history.test.ts` (Req 1, 2, 3, 4, 6, 8)
- [x] `restoreSnapshot()` unit tests against fake adapters: format-change restore options + stale-URL warning, same-format restore (no extra options, no warning), in-place `'restored'` outcome, REST-only `'partial'` fallback with new attachment ID (regression #119) — `test/unit/undo.test.ts` (Req 5, 7)
- [x] `restoreSnapshot()` rename-slug regression tests: slug forwarded when captured, left undefined when not captured — `test/unit/undo-rename-slug.test.ts` (Req 3, 5)
- [x] Integration test against live Dockerized WordPress validating the REST slug round-trip that `undo` relies on for rename restores — `test/integration/wp-rest.test.ts` (Req 3, 5)

## Docs

- [x] Document `history`/`undo` commands, restore mechanics, and the four MCP tools + resource in the skill reference — `skill/SKILL.md`
- [x] Document the time-machine feature set, config keys, and MCP surface additions in the changelog — `CHANGELOG.md` (v1.15.0–v1.15.2 entries, v2.1.0/v2.2.0 correctness fixes)
- [x] Record schema v4/v5, the shared safety-net convention, and locked architectural decisions (SQLite source of truth, "always undoable") in the maintainer handoff doc — `CLAUDE.md`
