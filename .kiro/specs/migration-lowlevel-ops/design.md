# Migration & Low-Level Ops — Design

## Architecture

This subsystem follows localpress's standard three-layer shape and adds nothing new to it —
there is no dedicated "migration engine" module; the interesting logic lives directly in the
CLI command files.

```
CLI command layer          src/cli/commands/{export,import,pull,push,rename,regenerate}.ts
        │  parses flags, resolves the active site/config, orchestrates the operation,
        │  handles dry-run gating, output formatting (info/warn/error/printJson), exit codes
        ▼
Engine layer (partial)     src/engine/image/optimize.ts (import --optimize only)
                            src/engine/caption/ollama.ts (rename --smart only)
                            src/engine/history/index.ts (rename's undo snapshots)
                            src/engine/state/db.ts (SiteDb — local SQLite cache)
        ▼
Adapter layer               src/adapters/resolver.ts (AdapterResolver)
                            src/adapters/rest.ts (RestAdapter)
                            src/adapters/wp-cli.ts (WpCliAdapter)
        │  capability-gated calls into WordPress: listMedia, getMedia, upload,
        │  updateMetadata, replaceInPlace, regenerateThumbnails
        ▼
WordPress (REST API or WP-CLI over SSH)
```

Four of the six commands (`export`, `pull`, `push`, `import`) are close to pure adapter
consumers — they call `listMedia`/`getMedia`/`upload`/`replaceInPlace`/`updateMetadata` and
otherwise do their own file I/O (ZIP read/write, filesystem writes) directly in the command
file rather than through a shared engine module. `rename` is the one command in this group
that reaches into two other subsystems — the caption/Ollama engine (for `--smart`) and the
history/snapshot engine (for undo) — making it the connective tissue between "migration &
low-level ops" and both the AI vision suite and time-machine specs. `regenerate` is the
simplest of the six: it has no local file I/O at all, just a capability check and a loop
over `adapter.regenerateThumbnails(id)`.

None of these six commands read or write the localpress SQLite database as their primary
state — `export`/`import`/`pull`/`push`/`regenerate` are stateless with respect to it.
`rename` is the exception: it upserts the attachment row (for snapshot foreign-key
integrity) and, when history is enabled, opens/writes/closes a history session exactly like
`optimize`, `caption`, `metadata`, and `delete` do.

## Key files/modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/export.ts` | `export` command: item selection (explicit IDs or filtered listing), ZIP32-aware streaming archive writer (`ZipStreamWriter`), directory writer, manifest construction. Exports `ZIP32_MAX_ENTRIES`, `ZIP32_MAX_SIZE`, `ZipLimitExceededError`, `estimateEntryCount`, `estimateTotalBytes`, `ZipStreamWriter` for reuse/testing. |
| `src/cli/commands/import.ts` | `import` command: path collection (directory walk, ZIP extraction, explicit files), manifest discovery/parsing/indexing, per-file optimize-then-upload pipeline with bounded concurrency, minimal ZIP reader (`parseZip`) with zip-slip protection. Exports `collectImageFiles`, `buildManifestIndex`, `resolveManifestItem`, `parseZip`, and the `ExportManifest`/`ImportFile`/`ManifestIndex` types for reuse/testing. |
| `src/cli/commands/pull.ts` | `pull` command: per-ID download to a local directory, filename collision handling. Exports `resolveDestPath` for testing. |
| `src/cli/commands/push.ts` | `push` command: single-file upload, `--replace` in-place-with-fallback flow (shared shape with `optimize`'s replace path, but not literally shared code). |
| `src/cli/commands/rename.ts` | `rename` command: `--smart`/`--to` slug derivation, idempotency check, history snapshot capture, `updateMetadata({ slug })` call. Exports `slugify` for reuse/testing. |
| `src/cli/commands/regenerate.ts` | `regenerate` command: ID resolution (explicit or `--all` + pagination), dry-run-by-default for `--all`, bounded-concurrency `regenerateThumbnails` calls. |
| `src/adapters/types.ts` | Declares the `WpBackend` interface and the `Capability` union (`upload`, `update-meta`, `replace-in-place`, `regenerate-thumbnails`, …) these commands depend on, plus `UploadMetadata`/`UpdateMetadata`/`ReplaceOptions`/`CapabilityUnavailableError`. |
| `src/adapters/resolver.ts` | `AdapterResolver` — picks WP-CLI vs REST per capability. `regenerate-thumbnails` is WP-CLI-only (REST always throws `CapabilityUnavailableError`); `replace-in-place` likewise requires WP-CLI. `upload`/`update-meta`/`get`/`list` are REST-preferred even when WP-CLI is configured (single HTTP call vs. per-item SSH round trip). |
| `src/engine/caption/ollama.ts` | `generateCaption()` — used by `rename --smart` with `kind: 'title'`. |
| `src/engine/caption/run-bulk.ts` | `preflightOllama()` — used by `rename --smart` to fail fast with a clear message if Ollama/the model isn't reachable, before any downloads happen. |
| `src/engine/history/index.ts` | `openHistorySession`/`captureSnapshot`/`closeHistorySession`/`resolveHistoryConfig`/`openSnapshotStore` — used by `rename` only, among these six commands. |
| `src/cli/utils/run-mode.ts` | `resolveDryRun(parentOpts, defaultDryRun)` — the shared dry-run/`--apply` resolution helper; used by `rename` (default: execute) and referenced implicitly by `export`/`import`/`regenerate`'s own inline `parentOpts.dryRun`/`parentOpts.apply` checks. |
| `src/cli/mcp/tools.ts` | Registers MCP tools `export`, `import`, `pull`, `push`, `rename`, `regenerate` (lines ~897–1175), each a thin argv-building wrapper that shells back into the CLI via `runCli()`. |

## Data flow

### Export: manifest format and archive construction

1. Item selection: explicit IDs are fetched one by one via `adapter.getMedia(id)`
   (`get` capability); filter-based selection (`--all`/`--unoptimized`/`--type`/`--since`/
   `--larger-than`) pages through `adapter.listMediaPage()` (`list` capability) until
   exhausted, then applies the `--unoptimized` filter client-side against
   `SiteDb.listProcessedWpIds()`.
2. Destination decision: `--to foo.zip` → ZIP mode; `--to foo/` or omitted → directory mode
   (default name `localpress-export-<Date.now()>`).
3. ZIP-mode preflight (before any network I/O): `estimateEntryCount()` (exact — item count +
   requested variants + 1 for `manifest.json`) is checked against `ZIP32_MAX_ENTRIES`
   (0xffff); `estimateTotalBytes()` (best-effort, since WordPress doesn't always populate
   `sizeBytes`) is checked against `ZIP32_MAX_SIZE` (0xffffffff, 4 GiB). Either overrun
   aborts immediately with `ExitCode.InvalidUsage`.
4. Download loop: each item's `url` is fetched with the platform `fetch()`; bytes are hashed
   with `createHash('sha256')`; the relative path is derived from the WordPress URL's
   `/wp-content/uploads/…` suffix via `deriveRelativePath()` (or just the filename under
   `--flat`). In ZIP mode, `ZipStreamWriter.writeEntry()` appends a local file header + data
   straight to a `.tmp` file on disk (STORE — uncompressed — for simplicity and speed); in
   directory mode, `Bun.write()` writes the file directly. `ZipStreamWriter` re-validates the
   4 GiB per-file and cumulative-offset limits and the 65,535-entry cap *during* the stream
   (the hard backstop for cases the preflight estimate under-counted), throwing
   `ZipLimitExceededError` if crossed — the caller catches this, calls `.abort()` (which
   deletes the `.tmp` file only if the stream was actually opened), and exits with
   `ExitCode.InvalidUsage`.
5. Manifest assembly: one `ExportManifestItem` per successfully downloaded item
   (`id`, `filename`, `relativePath`, `url`, `mimeType`, `width`/`height`, `sizeBytes`,
   `altText`, `caption`, `description`, `title`, `uploadedAt`, `sha256`), wrapped in
   `{ version: 1, site, siteUrl, exportedAt, items, totalBytes }` and written as
   `manifest.json` — the last entry into the ZIP (via `writeEntry`) or a plain file in
   directory mode.
6. Finalize: ZIP mode writes the central directory + end-of-central-directory record, then
   `renameSync(tmpPath, destPath)` — so a reader never observes a partially-written archive
   at the final path. Per-item and per-variant failures are logged and counted but don't
   abort the run; the command exits 1 (not 0) if any occurred, after still writing the
   manifest for what succeeded.

### Import: round-trip integrity back into WordPress

1. Path collection: for each input path, directories are recursively walked
   (`collectImageFiles`) collecting recognized image extensions with a POSIX-normalized path
   relative to that directory (hidden dirs and `node_modules` skipped); `.zip` files are
   extracted via the hand-rolled `parseZip()` reader (STORE + DEFLATE only; a data-descriptor
   or unrecognized-compression entry throws a hard, explicit error rather than silently
   dropping content) into a temp directory (`mkdtempSync`), with a zip-slip guard rejecting
   any entry that would resolve outside that temp root; bare image files are taken as-is with
   `relativePath: null`.
2. Manifest discovery: a `manifest.json` found alongside a directory input, or inside a ZIP,
   is parsed into the same `ExportManifest` shape `export` writes — this is the round-trip
   contract between the two commands. A present-but-corrupt manifest only warns; import still
   proceeds without metadata.
3. Manifest indexing (only when `--preserve-metadata`/`--preserve-ids` and a manifest exist):
   `buildManifestIndex()` builds two maps — `byRelativePath` (exact) and `byBasename`, where a
   basename claimed by more than one manifest entry is deliberately stored as `null` so it can
   never be used as a silent, possibly-wrong fallback. `resolveManifestItem()` then tries
   relative-path match first, falls back to basename only if unambiguous, and reports
   `ambiguous: true` (triggering a warning + default-metadata fallback in the caller) when a
   basename collision blocks the fallback.
4. Per-file pipeline (bounded concurrency, default `cpus().length - 1`, override via global
   `--concurrency`): read bytes → optionally run through `optimizeImage()` (same engine as
   `optimize`, `--optimize`/`--to`/`--max-width`/`--max-height`/`--strip-metadata`; a failed
   optimize warns and falls back to uploading the original bytes) → resolve `UploadMetadata`
   (manifest match, else `--title`/`--alt` command defaults, else nothing) → `adapter.upload()`
   (`upload` capability).
5. Round-trip integrity signal: for every file whose upload matched a manifest entry, the
   command tracks `oldId` (from the manifest) against the new `attachmentId` returned by
   `upload()`. The final summary prints every `oldId → newId` pair plus the literal
   `localpress references <oldId> --update-to <newId>` command — import does **not**
   automatically rewrite post content/meta references; that is left to the `references`
   command by design, keeping "create the new attachments" and "repoint what pointed at the
   old ones" as separate, individually-reviewable steps. SHA-256 hashes captured in the
   manifest by `export` are not currently re-verified against re-uploaded bytes by `import` —
   they exist in the manifest as a durable record/audit trail rather than being checked
   automatically anywhere in this code path.

### Pull / Push: unprocessed single-file movement

`pull` mirrors `export`'s download loop but with no manifest, no ZIP, and no filtering
beyond explicit IDs — it exists as a lower-ceremony primitive. Its one piece of non-trivial
logic is `resolveDestPath()`: given a destination directory, a proposed filename, an
attachment ID, a `Set` of names already claimed in the current run, and the `--force` flag,
it returns a uniquified path (appending `-<id>`, then `-2`, `-3`, … if still colliding) and a
`skipped` flag (true when the path exists on disk and `--force` was not passed) — so two
different attachments that happen to share a filename never overwrite each other, and
pre-existing local files are protected by default.

`push` is the write-side counterpart: without `--replace` it's a bare `upload()` call. With
`--replace <id>`, it first tries `resolver.tryResolve('replace-in-place')` — if available
(WP-CLI/SSH configured), it calls `replaceInPlace()` to swap the file bytes under the same
attachment ID/URL, then separately applies any of `--title`/`--alt`/`--caption`/
`--description` via `updateMetadata()` (a metadata-step failure here only warns — the file
replacement already succeeded and is not rolled back). If `replace-in-place` isn't available,
`push` falls back to uploading as a new attachment (unless the global `--strict` flag
demands the true in-place path or nothing) and directs the user to `references <id>` to find
what needs repointing — the same fallback-with-fallback-notice pattern used by `optimize`'s
replace path (not shared code, but a shared design shape between the two commands).

### Rename: slug derivation and undo

`--to <name>` skips straight to `slugify()`; `--smart` first runs `preflightOllama()` (fails
fast with an actionable message if Ollama or the configured model isn't reachable, before
any per-item downloads), then per attachment: downloads the image, calls
`generateCaption(buf, { kind: 'title', model, ollamaUrl })`, and slugifies the returned
caption text. Either path then compares the new slug against a best-effort `extractSlug()`
of the current filename; an unchanged slug short-circuits to `skipped: true` with no
WordPress call, making repeated runs idempotent. When a real change is about to happen and
the run isn't a dry run, `rename` opens a history session (if history is enabled) tagged
`'rename'` with `{ mode, to }` params, captures a metadata-only snapshot (no binary blob —
just filename/MIME/alt/title/caption/description/previous-slug) via `captureSnapshot()`,
then calls `metaAdapter.updateMetadata(id, { slug: newSlug })`. The attachment is always
upserted into the local SQLite cache first (even in dry-run) purely so
`processing_history`/snapshot foreign keys have a row to point at.

### Regenerate: capability-gated fan-out

No local state at all: resolve `regenerate-thumbnails` (WP-CLI only; `tryResolve` returns
`null` on REST-only sites, producing an actionable "configure SSH" error + exit 6), resolve
the ID set (explicit IDs, deduplicated, or a full paginated `listMedia` sweep under `--all`),
apply the bulk-default-dry-run posture (unadorned `--all` without `--apply`/`--dry-run`
prints the would-be count and stops), then fan out `adapter.regenerateThumbnails(id)` calls
in batches sized by `--concurrency` using `Promise.allSettled` so one failure doesn't abort
the batch.

## Key design decisions

- **No shared "migration engine" module.** Unlike image processing or captioning, this
  functional area didn't accumulate enough shared logic to justify an `src/engine/` module
  of its own — `export`/`import`'s ZIP handling, manifest shape, and path-matching logic all
  live directly in the two command files (and are exported from them for unit testing) rather
  than being factored out prematurely.
- **Hand-rolled minimal ZIP reader/writer instead of a dependency.** `export` writes STORE
  (uncompressed) entries via a purpose-built `ZipStreamWriter`; `import` reads STORE and
  DEFLATE via a purpose-built `parseZip()`. This keeps the binary self-contained (no native
  ZIP library dependency to bundle/compile for 5 platforms) at the cost of not supporting the
  full ZIP format — data-descriptor-streamed entries and non-DEFLATE compression are
  explicitly rejected with a message pointing at extracting via a standard tool first, rather
  than silently mishandling them.
- **ZIP32, not ZIP64.** The archive format is classic ZIP32 (32-bit offsets/sizes, 16-bit
  entry count) by deliberate choice — `export.ts`'s own doc comments and the
  `ZIP32_MAX_ENTRIES`/`ZIP32_MAX_SIZE` constants make the ceiling explicit, and both a
  preflight estimate and a mid-stream hard check exist so an oversized request fails fast
  and cleanly (pointing the user at directory export instead) rather than producing a
  corrupt or silently-truncated archive.
- **Relative-path-first, basename-fallback-only-if-unambiguous metadata matching.** Both
  `export` (writing `relativePath`) and `import` (`buildManifestIndex`/`resolveManifestItem`)
  were built around the fact that WordPress's `YYYY/MM` upload structure means two different
  attachments can share a basename (`photo.jpg` uploaded in different months). The basename
  index intentionally stores `null` for any basename claimed by more than one manifest entry
  so it can never silently resolve to the wrong item.
- **Import never rewrites references itself.** `import` prints exact
  `references --update-to` follow-up commands instead of calling `references` internally —
  keeping "get new attachments into WordPress" and "repoint what used the old ones"
  independently reviewable/dry-runnable steps, consistent with the general "don't surprise
  the user" bulk-safety posture documented in CLAUDE.md.
- **`rename` only ever touches the slug, never the file.** This is a hard limitation, not an
  oversight — true filename renaming would require filesystem access (WP-CLI) or a
  media-replace plugin, neither of which localpress assumes; it's called out in the code
  comment, the command description, and the user-facing completion message.
- **`regenerate` is WP-CLI-only by capability design, not by accident.** There is no REST
  API for triggering WordPress's `wp media regenerate`; `RestAdapter.regenerateThumbnails()`
  unconditionally throws `CapabilityUnavailableError('regenerate-thumbnails', 'rest')`, so
  the resolver naturally routes this command to the WP-CLI adapter or fails clearly.
- **Bulk-safety defaults follow the documented convention, command by command.**
  `export`/`import` (explicit-ID-or-filtered selection, no forced dry-run default — but both
  honor a user-passed `--dry-run`) and `regenerate --all` (dry-run by default, requires
  `--apply`) intentionally diverge because `export`/`import`/`pull`/`push` operate on a set
  the user already explicitly named or filtered, while `regenerate --all` and `optimize --all`
  share the "don't surprise the user with a library-wide mutation" posture from CLAUDE.md.
  `rename` takes explicit IDs only (no bulk `--all` mode) so it executes immediately by
  default like `push`/`convert`/`resize`, while still honoring an explicit `--dry-run` via
  `resolveDryRun`.

## Error handling / edge cases

- **Export:** ZIP32 overruns are checked twice — a fast preflight before any download, and a
  hard mid-stream check in `ZipStreamWriter` (since per-item sizes aren't always known from
  WordPress metadata) — both surfacing the same actionable message pointing at directory
  export as the escape hatch. Per-item/per-variant download failures are non-fatal and
  counted; the manifest is still written for whatever succeeded, and the process exits 1 if
  any failures occurred. A `ZipLimitExceededError` mid-stream triggers `zipWriter.abort()`,
  which safely no-ops if the underlying write stream was never actually opened (i.e. the
  very first entry was rejected before any bytes were written), so no stray `.tmp` file is
  left behind in that case, and unlinks it otherwise.
- **Import:** missing input paths fail fast (exit 2) before any file is touched. A malformed
  `manifest.json` only warns. ZIP entries that fall outside the extraction root (zip-slip) are
  individually skipped with a warning rather than aborting the whole extraction; ZIP entries
  using unsupported streaming/compression throw a hard, explicit error. Per-file optimize
  failures fall back to the unoptimized original rather than dropping the file. Per-file
  upload failures are counted and don't stop the batch; the run exits 1 if any occurred.
  Ambiguous basename matches degrade to command-level defaults with an explicit warning
  rather than picking an arbitrary manifest entry.
- **Pull:** filename collisions (same run, or against pre-existing files) are resolved via
  `resolveDestPath`'s uniquification instead of overwriting; pre-existing files are protected
  unless `--force`. Per-ID and per-variant failures are non-fatal and counted.
- **Push:** a missing local file exits 2 before any network call. A `replace-in-place`
  attempt that raises `CapabilityUnavailableError` falls through to the new-attachment
  path (unless `--strict`); any other error type propagates rather than being swallowed
  into a fallback. A metadata-update failure *after* a successful file replace only warns —
  the file swap is not rolled back.
- **Rename:** requires exactly one of `--smart`/`--to` (exit 2 otherwise, before any
  network/DB access). `--smart` preflights Ollama reachability once, up front, rather than
  failing per-item partway through a batch. Idempotent no-op detection (slug already matches)
  avoids redundant WordPress writes. Individual failures (vision call error, un-slugifiable
  proposed name, `updateMetadata` error) are caught per-ID, logged, and counted; the command
  exits 1 if any occurred while still completing the remaining IDs and closing the history
  session.
- **Regenerate:** missing the `regenerate-thumbnails` capability is treated as a distinct,
  clearly-messaged failure mode (exit 6, "configure SSH") rather than a generic error.
  `--all` without `--apply`/`--dry-run` is a safe no-op preview by default. Individual
  attachment failures (via `Promise.allSettled`) don't abort the batch; the run exits 1 if
  any occurred.

## Testing approach

- `test/unit/export-import.test.ts` — the primary coverage for this area: ZIP round-trip
  correctness (single/multiple files, binary data, empty files, large files, unicode
  filenames), the zip-slip guard (relative traversal and absolute-path entries rejected,
  nested benign paths still extract correctly), CRC-32 correctness, image-extension
  detection, recursive directory scanning, export manifest shape and (de)serialization,
  the ZIP32 preflight estimators (`estimateEntryCount`/`estimateTotalBytes`, including the
  over-limit cases), `ZipStreamWriter` (streaming write producing an archive its own reader
  can parse, and aborting/cleaning up `.tmp` on a mid-stream 4 GiB overflow), real
  `collectImageFiles` behavior for same-basename-different-subdirectory files, real manifest
  metadata matching (`resolveManifestItem` resolving path collisions correctly, reporting
  ambiguous matches, and still resolving unique basenames without a relative path), and real
  `parseZip` behavior (STORE and DEFLATE round-trip, explicit errors for unsupported
  compression and data-descriptor-streamed entries).
- `test/unit/pull-collisions.test.ts` — `resolveDestPath`: same-basename-different-attachment
  uniquification, `--include-sizes` variant collisions, cascading numeric-suffix fallback,
  skip-vs-overwrite behavior for pre-existing files with/without `--force`, and the
  unaffected-single-file plain-basename case.
- `test/unit/slugify.test.ts` — `slugify()` in isolation: lowercasing, space/underscore-to-
  hyphen conversion, punctuation stripping, hyphen-run collapsing, leading/trailing-hyphen
  trimming, unicode handling, 100-character truncation, and a real-world messy-title case.
- `test/unit/undo-rename-slug.test.ts` — `restoreSnapshot()`'s rename-specific path: forwards
  the captured slug from a rename snapshot on undo, and leaves `slug` undefined when
  restoring a snapshot that never captured one (covers the time-machine side of `rename`,
  which is otherwise the time-machine-undo spec's territory).
- `test/unit/dry-run-wiring.test.ts` and `test/unit/dry-run-honesty.test.ts` — cross-command
  static/behavioral checks that `rename.ts`, `import.ts`, and `regenerate.ts` (all listed
  explicitly in `MUTATING_COMMANDS`) contain a recognized dry-run-gating pattern, and that
  none of the six commands in this area redeclare the global `--dry-run`/`--apply` flags
  locally (which would shadow the shared root-level definitions). Per `dry-run-honesty.test.ts`'s
  own comment, `push` is deliberately excluded from the mandatory list as an "explicit-ID,
  execute-immediately" command in the same category as `convert`/`resize`/`remove-bg`.
- `test/unit/mcp-schema-cli-parity.test.ts` — verifies every flag referenced in the MCP tool
  handlers (including the `export`/`import`/`pull`/`push`/`rename`/`regenerate` tools in
  `src/cli/mcp/tools.ts`) exists on the corresponding real CLI command, catching drift
  between the MCP surface and the CLI flags documented above.
- **Not directly covered by a dedicated integration test observed in this pass:** an
  end-to-end `export` → `import --preserve-metadata` round trip against a live Dockerized
  WordPress instance, or a live `push --replace`/`regenerate` run over WP-CLI/SSH.
  `test/integration/wp-rest.test.ts` was checked and does not reference these six commands
  directly (it exercises the REST adapter more generally); the unit tests above validate
  the pure-logic pieces (ZIP handling, manifest matching, slugify, destination-path
  resolution) but not a live network round trip through these specific commands. Flagging
  this as a gap rather than asserting coverage that wasn't found.
