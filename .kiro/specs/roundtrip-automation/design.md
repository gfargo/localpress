# Round-trip & Automation — Design

## Architecture

This subsystem follows localpress's standard three-layer architecture (CLI command layer → engine layer → adapter layer), with one additional cross-cutting piece: a persistent SQLite mapping table that lets the directory-watch use case survive process restarts.

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI command layer                                                │
│  src/cli/commands/edit.ts          src/cli/commands/watch.ts     │
│  src/cli/commands/watch-status.ts                                │
│  - argument/option parsing, output formatting (info/warn/error/  │
│    printJson), lifecycle orchestration (readline prompt, SIGINT) │
└───────────────────────────┬───────────────────────────────────────┘
                             │
┌───────────────────────────▼───────────────────────────────────────┐
│ Engine layer                                                       │
│  src/engine/editor/detect.ts   — editor discovery/launch           │
│  src/engine/editor/watcher.ts  — debounced single-file watch       │
│  src/engine/image/optimize.ts  — optional optimize/convert (watch) │
│  src/engine/state/db.ts        — SiteDb: watch_mappings, history   │
│  src/engine/history/index.ts   — undo snapshots (watch --delete)   │
│  src/cli/utils/rerun-guard.ts  — coalescing async trigger          │
└───────────────────────────┬───────────────────────────────────────┘
                             │
┌───────────────────────────▼───────────────────────────────────────┐
│ Adapter layer                                                      │
│  src/adapters/resolver.ts — AdapterResolver.resolve/tryResolve     │
│  src/adapters/rest.ts     — always-available REST backend          │
│  src/adapters/wp-cli.ts   — opt-in SSH/WP-CLI backend               │
│    capabilities used here: 'get', 'upload', 'replace-in-place',    │
│    'delete'                                                        │
└─────────────────────────────────────────────────────────────────┘
```

`edit` and `watch` never call `RestAdapter`/`WpCliAdapter` directly. They go through `AdapterResolver.resolve(capability)` (throws if unavailable) or `AdapterResolver.tryResolve(capability)` (returns `null`) per CLAUDE.md's capability-resolution convention, and handle the `null`/`CapabilityUnavailableError` case explicitly rather than assuming WP-CLI is present. Both commands are long-running/interactive (they block on a readline prompt or run forever until Ctrl+C), which is why neither is exposed as an MCP tool — MCP tools in `src/cli/mcp/tools.ts` are single-shot request/response. `watch-status`, by contrast, is a fast synchronous read and *is* exposed as the `watch_status` MCP tool (registered around `src/cli/mcp/tools.ts:1313`), specifically so an agent can check "is automation already running here?" without needing to hold a live process.

## Key files/modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/edit.ts` | `localpress edit <id>` — download attachment, launch editor, watch single file, sync each save, readline-driven stop, cleanup. |
| `src/cli/commands/watch.ts` | `localpress watch <directory>` — chokidar directory watch, per-file debounce + rerun guard, optimize/convert pipeline, new-vs-replace routing, delete handling, SIGINT/SIGTERM shutdown. |
| `src/cli/commands/watch-status.ts` | `localpress watch-status` — read-only report over `watch_mappings`, grouped by directory. |
| `src/engine/editor/detect.ts` | `openInEditor()` (platform-specific `open`/`xdg-open`/`start`, detached+unref'd spawn) and `describeEditor()` for human-readable logging. |
| `src/engine/editor/watcher.ts` | `watchFile()` — chokidar wrapper for a *single* file, debounced via `setTimeout`, deduped via `createRerunGuard`, `awaitWriteFinish` enabled. Used only by `edit`. |
| `src/cli/utils/rerun-guard.ts` | `createRerunGuard()` — generic coalescing wrapper: while a call is in flight, further calls are queued (last-write-wins) and rerun once, rather than dropped or run concurrently. Used by both `watcher.ts` and `watch.ts` (per-file guards keyed by path). |
| `src/engine/state/schema.ts` | `watch_mappings` table DDL (migration v3) and its index on `(site_name, wp_id)`. |
| `src/engine/state/db.ts` | `SiteDb.getWatchMapping/upsertWatchMapping/removeWatchMapping/listWatchMappings/summarizeWatchDirectories` — all reads/writes against `watch_mappings`. |
| `src/engine/history/index.ts` | `openHistorySession/captureSnapshot/closeHistorySession` — used by `watch --delete` to snapshot an attachment's bytes/metadata before a force-delete, so `localpress undo` can restore it. |
| `src/adapters/resolver.ts` | `AdapterResolver` — picks REST vs WP-CLI per capability; `REST_PREFERRED` includes `get`/`upload`/`delete` (cheap single HTTP calls), while `replace-in-place` is WP-CLI-only (REST cannot replace attachment bytes, per CLAUDE.md's locked "Replace in place" decision). |

## Data flow

### `edit <id>` — one download, N syncs

1. `edit.ts` resolves the active site/config, then `resolver.resolve('get')` to fetch attachment metadata (throws and exits with code 4 if the ID doesn't resolve).
2. Downloads the attachment's `url` via `fetch`, writes bytes to `destDir/basename(filename)` (temp dir by default, or `--to`).
3. `openInEditor()` spawns the platform-appropriate opener detached; the CLI does not wait for the editor to exit.
4. If `--no-watch`, the command prints the manual `push --replace` instructions and returns — no further engine/adapter interaction.
5. Otherwise it opens the site DB (`SiteDb.init` + `ensureSite`) and calls `watchFile(localPath, { debounceMs: 800, onSave, onError, onReady })`.
6. On each debounced save (routed through `watchFile`'s internal `createRerunGuard`, so overlapping saves collapse to the latest): read the file's current bytes, SHA-256 hash them, try `resolver.tryResolve('replace-in-place')`. If available, `replaceInPlace(id, bytes)`; if not (or it threw `CapabilityUnavailableError` and `--strict` is off), fall back to `resolver.resolve('upload')` and warn that it landed as a new attachment. Either way, `db.upsertAttachment(...)` and `db.recordProcessing({ operation: 'edit', sourceHash, resultHash, ... })` persist the sync.
7. The main thread blocks on a `readline` interface waiting for Enter, Ctrl+C (SIGINT), or stdin EOF (`close` — needed so `edit 5 < /dev/null` in non-interactive contexts, like CI or agent-invoked shells, doesn't hang forever).
8. On stop: `watcher.close()`, `db.close()`, and temp-dir cleanup (`rmSync`) unless `--keep-file`/`--to` was given. Prints total sync count.

### `watch <directory>` — continuous directory sync

1. Validates the directory exists, opens `SiteDb`, optionally opens a time-machine `historySession` (only when `--delete` is passed and history is enabled in config).
2. Starts a chokidar watcher over the directory (`ignoreInitial: true`, dotfiles/`.git`/`node_modules` ignored, `awaitWriteFinish` stabilized to the debounce window).
3. `add`/`change` events go through `scheduleProcess(filePath, isNew)`: filters to `IMAGE_EXTENSIONS`, resets a per-file `setTimeout` debounce timer (default 800ms, `--debounce` override), and on fire calls a per-file `createRerunGuard`-wrapped `processFile`.
4. `processFile`: reads the file, hashes it, looks up any existing `watch_mappings` row for `(watchDir, relPath)`. If the hash matches the stored one, it's a no-op (editor touched mtime only) and returns early.
5. If `--optimize`/`--to` was passed and the MIME is optimizable, runs `optimizeImage()`; if the resulting format differs from the source, rewrites `filename`'s extension and tracks `formatChanged` so a downstream `replaceInPlace` call can pass `newMimeType`/`newExtension`.
6. Routing: if this is not a new file and a mapping with a `wpId` exists, try `replace-in-place`; on `CapabilityUnavailableError`, fall back to upload-as-new unless `--strict` (then skip with a warning). Otherwise (new file, or no prior mapping) upload as new. Either path ends with `db.upsertWatchMapping(site, watchDir, relPath, hash, resultId)`.
7. `unlink` events go to `handleDelete`: look up the mapping; if `--delete` is set, best-effort capture an undo snapshot (re-download current bytes via `resolver.resolve('get')` + `fetch`, `captureSnapshot(...)`) and then force-delete (`delete(mapping.wpId, { force: true })`) before removing the mapping. If `--delete` is not set, just warn and drop the now-stale mapping so a later file at that path isn't treated as a replace target for the deleted attachment's old ID.
8. SIGINT/SIGTERM triggers `shutdown()`: clears pending debounce timers, closes the chokidar watcher, closes the history session (flushing snapshot size accounting), closes the DB, and `process.exit(0)`.

### `watch-status` — read-only report

Single synchronous flow: open `SiteDb`, call `summarizeWatchDirectories(site.name)` (a `GROUP BY watch_dir` query returning file count + `MAX(updated_at)` per directory), close the DB, print. No adapter or network I/O at all — this command only ever reads local SQLite state.

## Key design decisions

- **`watch_mappings` as a dedicated schema v3 table** (per CLAUDE.md's "State management" locked decision — SQLite is the source of truth, schema migrations tracked in `src/engine/state/schema.ts`). Primary key `(site_name, watch_dir, rel_path)` with an index on `(site_name, wp_id)`. This is what makes directory-watch state survive process restarts: re-running `watch` against the same directory reads existing mappings instead of re-deriving "is this file new?" from scratch, and `watch-status` can report history without a live process.
- **Two independent debounce mechanisms** exist for a reason: `engine/editor/watcher.ts`'s `watchFile()` debounces a *single known file path* for `edit` (500ms default), while `watch.ts` debounces *per discovered file* in a directory (800ms default, `--debounce` configurable) using its own `Map<string, Timer>`. They share the `createRerunGuard` coalescing primitive from `src/cli/utils/rerun-guard.ts` but are otherwise separate implementations — `watch.ts` does not use `engine/editor/watcher.ts`.
- **`createRerunGuard` (last-write-wins coalescing)** is deliberately not a simple debounce: if a sync is already in flight when another save/change event fires, the new event is queued and replaces any previously queued one, then reruns exactly once after the in-flight run finishes. This bounds concurrency to one in-flight operation per file/path while guaranteeing the *latest* state is what eventually gets synced.
- **REST cannot replace attachment file bytes** (locked decision in CLAUDE.md), so both `edit` and `watch` always attempt `replace-in-place` via `tryResolve`/`resolve` and gracefully fall back to upload-as-new when only REST is available — this is the adapter-capability system doing its job rather than either command special-casing WP-CLI.
- **`watch --delete` always force-deletes**, never routes through WP's trash. The code comment in `watch.ts` explains why: retrying a non-force delete on every debounced removal event isn't practical, and stock WordPress doesn't have `MEDIA_TRASH` defined by default. To offset the destructiveness, a best-effort undo snapshot (bytes + metadata) is captured first via the time-machine (`src/engine/history/index.ts`), consistent with CLAUDE.md's "every mutating command snapshots before-state" invariant — though note this snapshot is best-effort (a failed download only warns, it doesn't block the delete).
- **`watch-status` honestly reports `running: false` always.** There is no PID-file or process-liveness mechanism implemented; the code comments in both `watch-status.ts` and `watch.ts`'s module doc explicitly flag this as a known gap rather than faking a signal. This is called out here because it's the one place this subsystem's behavior is intentionally incomplete rather than a bug.
- **`edit`'s stdin handling covers both interactive and non-interactic use.** The `readline` interface listens for `line` (Enter), `SIGINT` (Ctrl+C), and `close` (stdin EOF) — the last one specifically so a scripted/agent invocation like `edit 5 < /dev/null` terminates instead of hanging on a prompt that will never receive input.

## Error handling / edge cases actually implemented

- Invalid attachment ID (`NaN` after `parseInt`) → `error()` + `process.exit(2)` before any network call.
- Attachment metadata fetch failure → caught, `error()` + `process.exit(4)`.
- Attachment file download HTTP failure (`!response.ok`) → `error()` + `process.exit(1)` (via the general `process.exit`).
- `replace-in-place` throwing `CapabilityUnavailableError`: swallowed and falls through to upload-as-new, *unless* `--strict` is set, in which case it's rethrown (this branch exists identically in both `edit.ts` and `watch.ts`, though `watch.ts`'s `--strict` path skips-and-warns instead of throwing, since a directory watch must keep running).
- Upload/replace failure inside `edit`'s `onSave` handler is caught and logged per-save; the watcher keeps running for subsequent saves rather than crashing the whole session.
- `watch.ts` explicitly distinguishes `AnimatedImageError`/`UnsupportedFormatError` (deliberate skip, warn-and-continue) from all other errors (logged as a hard error for that file, but the watcher itself keeps running).
- `watch.ts`'s file-hash short-circuit prevents redundant uploads when an editor rewrites a file with identical bytes (only mtime changes).
- Both commands register `SIGINT`/`SIGTERM` (or, for `edit`, readline's `SIGINT`/`close`) handlers that close the watcher and DB handle before exiting, avoiding orphaned chokidar watches or unflushed SQLite connections.
- `watch --delete`'s snapshot capture failure (network error or non-OK response fetching the current file) is caught and only produces a warning ("undo will not restore the file") — it does not block the delete itself.

## Testing approach

- **`test/unit/editor-watcher.test.ts`** — the only test file specific to this area. It exercises `engine/editor/watcher.ts`'s `watchFile()` directly against a real temp file and a real chokidar instance (not mocked), with a short 80ms debounce to keep the suite fast. One test (`fires onSave on an in-place change`) verifies the debounced save-detection path end-to-end. A second test (`fires onSave on delete+recreate`) is explicitly `test.skip`'d with a comment explaining that containerized/sandboxed filesystems don't reliably re-emit inotify `add` events after unlink+recreate, even though the production code path (`watcher.on('add', scheduleRun)`) is wired up — this is a known test-environment limitation, not a code gap.
- No dedicated unit test file was found for `src/cli/commands/watch.ts`, `src/cli/commands/watch-status.ts`, `src/cli/commands/edit.ts`, or `src/engine/editor/detect.ts` specifically (searched `test/unit/**/*watch*` and `test/unit/**/*edit*` — only `editor-watcher.test.ts` matched). The `watch_mappings` persistence layer (`SiteDb.getWatchMapping`/`upsertWatchMapping`/`removeWatchMapping`/`summarizeWatchDirectories`) may be exercised indirectly by broader `test/unit/db*.test.ts`-style files if present, but this was not confirmed line-by-line — flagged here as a gap rather than assumed.
- `test/integration/wp-rest.test.ts` (Dockerized WordPress) was not confirmed to specifically exercise `edit`/`watch`/`watch-status` — these are long-running/interactive commands (readline prompts, indefinite watch loops) that are inherently awkward to drive in an automated integration suite, and no evidence of such coverage was found during this pass. This should be treated as an open question rather than a confirmed gap or confirmed presence.
