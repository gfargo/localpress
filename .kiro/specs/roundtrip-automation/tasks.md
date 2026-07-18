# Round-trip & Automation — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core engine logic

- [x] Implement platform-aware editor detection/launch — `open`/`open -a`/`xdg-open`/`cmd /c start`, detached+unref'd spawn (`src/engine/editor/detect.ts`: `openInEditor`, `describeEditor`) (Requirement 2)
- [x] Implement single-file debounced watcher with `awaitWriteFinish` stabilization and `change`+`add` event handling for atomic-save editors (`src/engine/editor/watcher.ts`: `watchFile`) (Requirements 2, 3)
- [x] Implement generic coalescing rerun guard (last-write-wins queueing while a run is in flight) shared by the single-file watcher and the directory watcher (`src/cli/utils/rerun-guard.ts`: `createRerunGuard`) (Requirement 3)
- [x] Add `watch_mappings` table (schema migration v3): `(site_name, watch_dir, rel_path)` primary key, `file_hash`, `wp_id`, `updated_at`, indexed on `(site_name, wp_id)` (`src/engine/state/schema.ts`) (Requirement 6)
- [x] Implement `SiteDb` CRUD over `watch_mappings` — `getWatchMapping`, `upsertWatchMapping`, `removeWatchMapping`, `listWatchMappings`, `summarizeWatchDirectories` (`src/engine/state/db.ts`) (Requirements 6, 7)

## CLI command wiring

- [x] `localpress edit <id>`: fetch metadata → download → open in editor → optional watch loop → readline-driven stop (Enter/Ctrl+C/stdin EOF) → cleanup (`src/cli/commands/edit.ts`) (Requirement 1)
- [x] `edit`: `--with <app>` editor override, `--no-watch` (open-only, prints manual `push --replace` instructions), `--keep-file`, `--to <dir>` download-destination override (`src/cli/commands/edit.ts`) (Requirements 1, 2)
- [x] `edit`: on each debounced save, SHA-256 hash the changed bytes, attempt `replace-in-place` via `resolver.tryResolve`, fall back to `upload` on `CapabilityUnavailableError` (respecting `--strict`), and persist both an `attachments` upsert and a `processing_history` row (`operation: 'edit'`) per sync (`src/cli/commands/edit.ts`) (Requirements 4, 8)
- [x] `localpress watch <directory>`: chokidar directory watch (ignore dotfiles/`.git`/`node_modules`, `ignoreInitial: true`), per-file debounce timers (default 800ms, `--debounce` override), per-file rerun guards keyed by path (`src/cli/commands/watch.ts`) (Requirements 3, 5)
- [x] `watch`: content-hash short-circuit against the stored `watch_mappings` hash to skip no-op mtime-only changes (`src/cli/commands/watch.ts`: `processFile`) (Requirement 4)
- [x] `watch`: new-file-vs-existing-mapping routing — upload new files, `replace-in-place` files with a known `wpId` (falling back to upload-as-new unless `--strict`), always upserting the mapping afterward (`src/cli/commands/watch.ts`: `processFile`) (Requirements 5, 6, 8)
- [x] `watch`: `--optimize`/`--to <format>`/`--quality`/`--max-width`/`--max-height` pipeline integration before upload/replace, including filename/MIME rewrite on format change and graceful skip for non-optimizable MIME types (`src/cli/commands/watch.ts`) (Requirement 5)
- [x] `watch`: `--delete` handling — best-effort undo snapshot capture (bytes + metadata via time-machine) before a force-delete (`force: true`, bypassing WP trash), mapping removal in both the `--delete` and non-`--delete` (warn-only) branches (`src/cli/commands/watch.ts`: `handleDelete`) (Requirements 6, 8)
- [x] `watch`: graceful SIGINT/SIGTERM shutdown — clear debounce timers, close chokidar watcher, close history session, close DB, exit 0 (`src/cli/commands/watch.ts`: `shutdown`) (Requirement 8)
- [x] `localpress watch-status`: read-only summary of `watch_mappings` grouped by directory (file count, last activity), explicit `running: false` / `runningDetectionImplemented: false` honesty flags, `--json` support (`src/cli/commands/watch-status.ts`) (Requirement 7)
- [x] Register all three commands in the CLI entry point (`src/cli/index.ts`: `registerEditCommand`, `registerWatchCommand`, `registerWatchStatusCommand`)

## MCP tool wiring

- [x] Expose `watch_status` as an MCP tool (read-only, fast, matches the single-shot request/response MCP tool model) (`src/cli/mcp/tools.ts`) (Requirement 7)
- [x] Deliberately do NOT expose `edit` or `watch` as MCP tools — both are long-running/interactive (readline prompt or indefinite watch loop) and don't fit MCP's typed single-shot tool contract; this is a considered scope boundary, not an oversight (Requirements 1, 3)

## Tests

- [x] Unit test for debounced single-file save detection against a real chokidar instance and temp file (`test/unit/editor-watcher.test.ts`: `fires onSave on an in-place change`) (Requirement 3)
- [x] Document (via `test.skip` + explanatory comment) the known sandbox limitation where delete+recreate atomic saves don't reliably re-emit inotify events in containerized test environments, while confirming the production code path is wired for it (`test/unit/editor-watcher.test.ts`: `fires onSave on delete+recreate`) (Requirement 3)

## Docs

- [x] Document `edit` and `watch` usage in the README quick-start and command table (`README.md`) (Requirements 1, 5)
- [x] Document round-trip/automation behavior and conventions in `CLAUDE.md`'s command inventory and locked-decisions sections (`CLAUDE.md`)
