# Migration & Low-Level Ops — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core logic

- [x] Implement the classic ZIP32 streaming writer (`ZipStreamWriter`) — local file header +
      data written straight to a `.tmp` file per entry, central directory + end-of-central-
      directory record on `finalize()`, atomic `renameSync` into place on success (Requirement 1)
- [x] Implement ZIP32 limit guards: `estimateEntryCount`/`estimateTotalBytes` preflight
      estimators plus in-stream hard checks in `ZipStreamWriter.writeEntry()` for the 65,535-
      entry cap and 4 GiB per-file/cumulative-offset cap, with `ZipLimitExceededError` and a
      shared actionable error message pointing at directory export (Requirement 1)
- [x] Implement CRC-32 computation for ZIP entries (Requirement 1)
- [x] Implement relative-path derivation from WordPress attachment URLs
      (`deriveRelativePath`, preserving `wp-content/uploads/YYYY/MM/…` structure) and the
      `--flat` flat-directory override (Requirement 1)
- [x] Implement the `ExportManifest`/`ExportManifestItem` shape (version 1) including
      per-item SHA-256 hashing of downloaded bytes (Requirement 1)
- [x] Implement the minimal ZIP reader (`parseZip`) supporting STORE and DEFLATE, with
      explicit errors for data-descriptor-streamed entries and unsupported compression
      methods (Requirement 2)
- [x] Implement the zip-slip extraction guard (reject entries resolving outside the temp
      extraction root, covering both absolute paths and `../` traversal) (Requirement 2)
- [x] Implement recursive image-file directory scanning (`collectImageFiles`) with hidden-dir
      and `node_modules` skipping and POSIX-normalized relative paths (Requirement 2)
- [x] Implement manifest indexing and matching (`buildManifestIndex`, `resolveManifestItem`) —
      relative-path-first, basename-fallback-only-when-unambiguous, `ambiguous` reporting for
      colliding basenames (Requirement 2)
- [x] Implement `slugify()` (lowercase, space/underscore-to-hyphen, punctuation stripping,
      hyphen-run collapsing, trim, 100-char cap) and `extractSlug()` best-effort current-slug
      derivation from filename (Requirement 4)
- [x] Implement `resolveDestPath()` for `pull` — filename uniquification against both
      already-claimed names in the current run and pre-existing files on disk, with
      `--force` override (Requirement 3)

## CLI command wiring

- [x] Wire `localpress export [ids...]` — explicit-ID and filter-based
      (`--all`/`--unoptimized`/`--type`/`--since`/`--larger-than`) item selection, paginated
      listing, client-side `--unoptimized` filtering against the local SQLite processing
      history, ZIP-vs-directory destination handling, `--include-sizes` variant export,
      `--flat` flat output, dry-run reporting, JSON output, exit codes (2 for no selection
      criteria, invalid-usage code for ZIP32 overruns, 1 for partial failures) (Requirement 1)
- [x] Wire `localpress import <paths...>` — mixed directory/file/ZIP path collection,
      manifest discovery (directory-adjacent or in-ZIP) with malformed-manifest tolerance,
      `--optimize`/`--to`/`--quality`/`--max-width`/`--max-height`/`--strip-metadata` pass-
      through into the shared image-optimization engine with per-file fallback-to-original on
      failure, `--preserve-metadata`/deprecated-`--preserve-ids` manifest metadata reapplication,
      `--title`/`--alt`/`--post` command-level defaults, bounded-concurrency upload processing
      (`--concurrency`), old-ID→new-ID mapping output with `references --update-to` follow-up
      hints, dry-run reporting, JSON output, exit codes (2 for missing path, 1 for partial
      failures) (Requirement 2)
- [x] Wire `localpress pull <ids...>` — per-ID download to `--to <dir>` (default cwd),
      collision-safe naming via `resolveDestPath`, `--force` overwrite, `--include-sizes`
      variant download, per-ID/variant failure tolerance, JSON output, exit code 1 on any
      failure (Requirement 3)
- [x] Wire `localpress push <path>` — plain upload path with `--title`/`--alt`/`--caption`/
      `--description`/`--post`; `--replace <id>` path resolving `replace-in-place` capability
      with fallback-to-new-upload (honoring global `--strict` to refuse the fallback),
      separate post-replace metadata update with warn-only failure handling, missing-file
      exit 2, JSON output (Requirement 3)
- [x] Wire `localpress rename <ids...>` — `--smart`/`--to` mutual-exclusivity validation,
      Ollama model resolution (`--model` > `config.defaults.captionModel` > default) and
      `preflightOllama()` fail-fast check for `--smart`, per-ID slug derivation and
      idempotent skip-if-unchanged detection, attachment upsert into local SQLite (dry-run
      included, for FK integrity), history-session open/capture/close wrapping the
      `updateMetadata({ slug })` call, dry-run gating via `resolveDryRun`, JSON output, exit
      code 1 on partial failures (Requirement 4)
- [x] Wire `localpress regenerate [ids...] --all` — `regenerate-thumbnails` capability
      resolution with exit-6 actionable error when unavailable, explicit-ID dedup, `--all`
      paginated listing with bulk dry-run-by-default posture (requires `--apply`), bounded-
      concurrency (`--concurrency`) fan-out via `Promise.allSettled`, per-ID success/failure
      reporting, JSON output, exit code 1 on any failure (Requirement 5)

## MCP tool wiring

- [x] Register the `export` MCP tool (`src/cli/mcp/tools.ts`) mapping `ids`/`all`/
      `unoptimized`/`to`/`type`/`since`/`largerThan`/`includeSizes`/`flat` to the equivalent
      CLI flags (Requirement 1)
- [x] Register the `import` MCP tool mapping `source`/`optimize`/`to`/`quality`/`maxWidth`/
      `maxHeight`/`stripMetadata`/`title`/`altText`/`post`/`preserveMetadata`/`preserveIds`/
      `dryRun` to the equivalent CLI flags (Requirement 2)
- [x] Register the `pull` MCP tool mapping `ids`/`to` to the equivalent CLI flags
      (Requirement 3)
- [x] Register the `push` MCP tool mapping `file`/`replace`/`title`/`altText`/`caption` to
      the equivalent CLI flags (Requirement 3)
- [x] Register the `rename` MCP tool mapping `ids`/`smart`/`to`/`model`/`dryRun` to the
      equivalent CLI flags (Requirement 4)
- [x] Register the `regenerate` MCP tool mapping `ids`/`all` to the equivalent CLI flags
      (Requirement 5)

## Tests

- [x] `test/unit/export-import.test.ts` — ZIP round-trip (single/multiple/binary/empty/
      large/unicode-filename entries), zip-slip guard (relative + absolute traversal
      rejection, benign nested paths still extracting), CRC-32 correctness, image-extension
      detection, recursive directory scanning, export manifest shape + serialization
      round-trip, ZIP32 preflight estimator over-limit detection, `ZipStreamWriter`
      streaming + mid-stream abort/cleanup, real `collectImageFiles` same-basename-different-
      subdirectory resolution, real manifest matching (path-collision resolution, ambiguous-
      match reporting, unique-basename-without-relative-path resolution), real `parseZip`
      STORE/DEFLATE round-trip and explicit unsupported-format errors (Requirements 1, 2)
- [x] `test/unit/pull-collisions.test.ts` — `resolveDestPath` uniquification, variant
      collision handling, cascading suffixes, force-vs-skip pre-existing-file behavior
      (Requirement 3)
- [x] `test/unit/slugify.test.ts` — `slugify()` normalization rules across punctuation,
      whitespace, unicode, hyphen collapsing, truncation, and a real-world messy-title case
      (Requirement 4)
- [x] `test/unit/undo-rename-slug.test.ts` — rename snapshot slug forwarding/omission on
      undo restore (Requirement 4)
- [x] `test/unit/dry-run-wiring.test.ts` — confirms `rename`/`import`/`regenerate`/`pull`/
      `push`/`export` don't locally redeclare the global `--dry-run`/`--apply` flags
      (Requirements 1-5)
- [x] `test/unit/dry-run-honesty.test.ts` — confirms `rename.ts`, `import.ts`, and
      `regenerate.ts` each contain a recognized dry-run-gating pattern (`push.ts` is
      deliberately exempted as an explicit-ID, execute-immediately command) (Requirements 2, 4, 5)
- [x] `test/unit/mcp-schema-cli-parity.test.ts` — verifies MCP tool argument-to-flag mappings
      for `export`/`import`/`pull`/`push`/`rename`/`regenerate` match real CLI flags
      (Requirements 1-5)

## Docs

- [x] Document `export`/`import`/`pull`/`push`/`rename`/`regenerate` in `skill/SKILL.md`'s
      command reference with JSON schemas, as part of the full 37-command skill surface
- [x] Document the migration/backup workflow (`export` → `import --preserve-metadata` →
      `references --update-to`) and the MCP tool surface in `README.md`
- [x] Record shipping history for these commands across the `v1.12.0`–`v2.1.0` entries in
      `CHANGELOG.md` (replace-in-place format conversion, `export`/`import` commands,
      `--profile` on optimize, rename/vision-suite expansion, v2.1.0 dry-run/reference-rewrite
      safety hardening)
