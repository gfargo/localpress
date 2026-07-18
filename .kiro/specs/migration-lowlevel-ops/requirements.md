# Migration & Low-Level Ops

Backfilled spec documenting already-shipped functionality.

This subsystem covers six CLI commands that move media files and their metadata across the
boundary between the local filesystem and a WordPress site: `export`, `import`, `pull`,
`push`, `rename`, and `regenerate`. Together they exist for three purposes: (1) **migration
and backup** — `export` bundles attachments plus a metadata manifest into a portable ZIP or
directory, and `import` reverses that, re-uploading files and reapplying the manifest's
metadata, including a same-site or cross-site round trip; (2) **low-level single-file
control** — `pull` and `push` are the "no processing, just move bytes" primitives underneath
higher-level commands, useful for manual review, scripting, or ad hoc replacement; and (3)
**WordPress-side bookkeeping** — `rename` changes an attachment's slug/permalink, and
`regenerate` re-derives WordPress's thumbnail/medium/large image sizes after a bulk edit or
theme change. All six are thin CLI wrappers over the adapter layer (`AdapterResolver`) and,
where they mutate WordPress state, participate in localpress's shared dry-run and
time-machine (undo) conventions.

## Requirement 1: Export media as a portable archive with a metadata manifest

**User Story:** As a user or agent preparing a site migration or backup, I want to export
selected media items to a ZIP or directory with a machine-readable manifest of their
metadata, so that I can move or archive the library and later restore alt text, titles,
captions, and descriptions without re-deriving them.

**Acceptance Criteria:**
- WHEN `localpress export` is run with explicit attachment IDs THE SYSTEM SHALL fetch and
  export exactly those items, logging (not aborting on) any ID that fails to resolve.
- WHEN `localpress export` is run with `--all`, `--unoptimized`, `--type`, `--since`, or
  `--larger-than` (and no explicit IDs) THE SYSTEM SHALL paginate through the full matching
  set from the WordPress REST API before exporting. IF `--unoptimized` is combined with other
  filters THEN THE SYSTEM SHALL further exclude, client-side, any item whose WordPress ID is
  already present in the local SQLite `processing_history` (treating every item as
  unoptimized if the site database does not yet exist).
- IF no IDs and none of `--all`/`--unoptimized`/`--type`/`--since`/`--larger-than` are given
  THEN THE SYSTEM SHALL print a usage error and exit with code 2 rather than exporting
  nothing or everything by default.
- WHEN `--to <path>` ends in `.zip` THE SYSTEM SHALL stream a classic ZIP32 archive directly
  to disk (via a `.tmp` file renamed into place on success), never buffering the whole
  archive or a downloaded file list in memory. WHEN `--to <path>` does not end in `.zip` (or
  is omitted) THE SYSTEM SHALL write to a directory instead, defaulting to
  `localpress-export-<timestamp>` when `--to` is not given.
- WHEN exporting to ZIP THE SYSTEM SHALL preflight the requested entry count against the
  ZIP32 65,535-entry cap and the best-effort-estimated total size against the 4 GiB ZIP32 size
  cap, aborting before any download starts (exit code matching `ExitCode.InvalidUsage`) if
  either would be exceeded. IF the size estimate under-counts (WordPress does not always
  report `sizeBytes`) and the *actual* per-file or cumulative size crosses the 4 GiB ZIP32
  limit mid-stream THEN THE SYSTEM SHALL abort, delete the partial `.tmp` file, and exit
  with the same invalid-usage code — the streaming writer is the authoritative backstop, not
  just the preflight estimate.
- WHEN each item is exported THE SYSTEM SHALL compute a SHA-256 hash of the downloaded bytes
  and record it, alongside filename, relative path, URL, MIME type, dimensions, size, alt
  text, caption, description, title, and upload timestamp, as one entry in a top-level
  `manifest.json` (schema `version: 1`) written into the archive/directory once all
  downloads complete.
- WHEN `--include-sizes` is passed THE SYSTEM SHALL also download each item's registered
  thumbnail/medium/large variant files (best-effort — a failed variant download is warned,
  not fatal, and does not fail the overall export).
- WHEN `--flat` is passed THE SYSTEM SHALL write every file (including variants) into a
  single flat directory/archive root instead of preserving the WordPress
  `wp-content/uploads/YYYY/MM/…` structure derived from each item's URL.
- WHEN `--dry-run` is set (global flag) THE SYSTEM SHALL report what would be exported
  (count and destination, plus item list under `--json`) without downloading or writing
  anything.
- WHEN the export completes with one or more per-item download failures THE SYSTEM SHALL
  still write the manifest for the items that succeeded, print a failure count, and exit
  with code 1.

## Requirement 2: Import local files or a previous export back into WordPress

**User Story:** As a user or agent restoring a backup or bulk-loading external images, I
want to import a directory, file list, or ZIP archive into the WordPress media library,
optionally optimizing on the way in and reapplying metadata from a matching export manifest,
so that a migrated library ends up both smaller and no worse-documented than the original.

**Acceptance Criteria:**
- WHEN `localpress import` is given one or more paths THE SYSTEM SHALL accept any mix of
  directories (recursively scanned for recognized image extensions, skipping hidden
  directories and `node_modules`), individual image files, and `.zip` archives.
- IF a given path does not exist THEN THE SYSTEM SHALL print an error and exit with code 2
  before importing anything from any of the supplied paths.
- WHEN a directory or ZIP contains a `manifest.json` matching the `ExportManifest` shape
  (as written by `localpress export`) THE SYSTEM SHALL parse it and make it available for
  metadata matching, warning (not failing) if the file is present but unparseable.
- WHEN `--optimize` or `--to <format>` is passed THE SYSTEM SHALL run each file through the
  same optimization pipeline used by `localpress optimize` (quality, format conversion,
  `--max-width`/`--max-height`, `--strip-metadata`) before upload; IF optimization fails for
  a given file THEN THE SYSTEM SHALL warn and upload the original bytes rather than skipping
  the file.
- WHEN `--preserve-metadata` (or its deprecated alias `--preserve-ids`, which emits a
  deprecation warning) is passed AND a manifest was found THE SYSTEM SHALL reapply each
  matched item's title, alt text, caption, and description from the manifest to the newly
  created attachment. Matching SHALL be resolved by the file's path relative to the import
  root first; only when no relative-path match exists does it fall back to basename, and
  only when that basename is unambiguous across the manifest (a basename shared by multiple
  manifest entries with no relative-path match SHALL warn and fall back to command-level
  `--title`/`--alt` defaults rather than guessing which entry applies).
- WHEN `--preserve-metadata` is not passed, or no manifest match is found for a file, THE
  SYSTEM SHALL apply the command-level `--title`/`--alt` defaults (if given) instead.
- WHEN a `.zip` archive is imported THE SYSTEM SHALL extract it to a temporary directory,
  rejecting (with a warning, not aborting the whole import) any entry whose resolved path
  would escape the extraction directory (zip-slip protection covering both absolute paths
  and `../` traversal). IF an archive entry uses a streamed data descriptor or an
  unsupported compression method (anything other than STORE or DEFLATE) THEN THE SYSTEM
  SHALL raise an explicit error naming the offending entry and instructing the user to
  extract with a standard tool first, rather than silently importing nothing.
- WHEN uploads run THE SYSTEM SHALL process files concurrently, bounded by
  `--concurrency` (default: CPU count minus one), and SHALL continue past individual
  upload failures, tallying them into a failure count and exiting with code 1 if any
  occurred.
- WHEN metadata was reapplied from a manifest THE SYSTEM SHALL print (and, under `--json`,
  return) an old-ID → new-ID mapping for every successfully matched item, together with the
  exact `localpress references <oldId> --update-to <newId>` command needed to repoint any
  content that referenced the original attachment — import never rewrites references itself.
- WHEN `--dry-run` is set (global flag) THE SYSTEM SHALL report the file count and site
  without optimizing or uploading anything.

## Requirement 3: Pull and push individual files without processing

**User Story:** As a user or agent needing direct, unprocessed control over a single file,
I want to download an attachment's raw bytes to disk or upload a local file as a new or
replacement attachment, so that I can inspect files manually, script around them, or swap
in an externally-edited version without going through the optimize/caption pipeline.

**Acceptance Criteria:**
- WHEN `localpress pull <ids...>` is run THE SYSTEM SHALL download each attachment's source
  file, unmodified, to `--to <dir>` (default: current working directory), creating the
  directory if needed.
- WHEN two requested attachments would produce the same local filename, or a requested
  filename already exists on disk, THE SYSTEM SHALL uniquify the local name (append the
  attachment ID, then a numeric suffix if still colliding) rather than silently
  overwriting a different attachment's file.
- IF a target file already exists on disk AND `--force` was not passed THEN THE SYSTEM
  SHALL skip that download (leaving the existing file untouched) and report it as skipped;
  WHEN `--force` is passed THE SYSTEM SHALL overwrite it.
- WHEN `--include-sizes` is passed THE SYSTEM SHALL also download each item's registered
  thumbnail/medium/large variants (best-effort; a failed variant download only warns).
- WHEN one or more attachment downloads fail THE SYSTEM SHALL continue with the remaining
  IDs and exit with code 1 after reporting the failures.
- WHEN `localpress push <path>` is run without `--replace` THE SYSTEM SHALL upload the file
  as a brand-new attachment, applying any of `--title`/`--alt`/`--caption`/`--description`/
  `--post` supplied.
- WHEN `localpress push <path> --replace <id>` is run AND the resolved adapter supports the
  `replace-in-place` capability THE SYSTEM SHALL replace the existing attachment's file
  bytes in place (preserving its ID and URL), then separately apply any metadata flags via
  an `update-meta` call — warning, but not failing the overall push, if that metadata step
  errors after a successful file replace.
- IF `replace-in-place` is unavailable for the site (no WP-CLI/SSH configured) THEN THE
  SYSTEM SHALL fall back to uploading the file as a new attachment, warn that this is not a
  true replacement, and point at `localpress references <id>` to find where the old
  attachment is used. IF the global `--strict` flag is set THEN THE SYSTEM SHALL instead
  refuse the fallback, print an actionable error, and exit with code 6.
- IF the local file at `<path>` does not exist THEN THE SYSTEM SHALL error and exit with
  code 2 before attempting any network call.

## Requirement 4: Rename an attachment's slug (permalink)

**User Story:** As a user or agent cleaning up auto-generated filenames like
`screenshot-2026-05-06-at-5-20-18-pm`, I want to rename an attachment's WordPress slug
either explicitly or from an AI-generated name, so that its permalink is human-readable —
without needing to understand how the name itself gets generated.

> This command is documented here from the **rename mechanics** angle (what actually
> changes in WordPress, and the safety/idempotency guarantees around it). The `--smart`
> flag's underlying AI title-generation call (via the Ollama vision pipeline shared with
> `caption`/`title`/`describe`/`classify`/`tag`/`vision`) is the same machinery documented
> in the AI vision suite spec — see that spec for model resolution, Ollama preflight checks,
> and captioning behavior in general. This spec does not re-derive those details.

**Acceptance Criteria:**
- WHEN `localpress rename <ids...>` is run THE SYSTEM SHALL require exactly one of `--smart`
  or `--to <name>`; IF neither or both are given THEN THE SYSTEM SHALL print a usage error
  and exit with code 2 without contacting WordPress.
- WHEN `--to <name>` is given THE SYSTEM SHALL slugify the supplied string (lowercase,
  spaces/underscores to hyphens, strip non-`[a-z0-9-]` characters, collapse repeated
  hyphens, trim leading/trailing hyphens, cap at 100 characters) without any AI call.
- WHEN `--smart` is given THE SYSTEM SHALL download the attachment's image, generate a
  title via the Ollama vision model (`--model` > `config.defaults.captionModel` >
  `moondream` default), and slugify the result the same way as the explicit path.
- WHEN the newly derived slug is identical to the attachment's current slug (best-effort
  derived from its filename) THE SYSTEM SHALL skip the update entirely and report the item
  as skipped rather than issuing a no-op WordPress write — making repeated runs idempotent.
- WHEN a rename actually changes the slug AND the run is not a dry run THE SYSTEM SHALL
  capture a metadata-only time-machine snapshot (filename, MIME type, alt text, title,
  caption, description, and previous slug) before calling `updateMetadata` with the new
  slug, so `localpress undo` can restore the previous slug afterward.
- THE SYSTEM SHALL update only the WordPress slug (`post_name` / permalink) — it SHALL NOT
  rename the underlying uploaded file on disk or change the attachment's file URL; this
  limitation is surfaced to the user in the command's own help text and in its completion
  message.
- WHEN `--dry-run` is set (global flag, via the shared `resolveDryRun` helper, default
  posture is to execute immediately since `rename` takes explicit IDs) THE SYSTEM SHALL
  still upsert the attachment into the local SQLite cache (for FK integrity) but SHALL NOT
  call `updateMetadata` or write a snapshot, printing what would change instead.
- WHEN one or more renames fail (e.g. the vision call errors, or no usable slug can be
  derived from the proposed name) THE SYSTEM SHALL continue with the remaining IDs and exit
  with code 1 after reporting the failures.

## Requirement 5: Regenerate WordPress thumbnail sizes

**User Story:** As a user or agent who has bulk-optimized images without regenerating
thumbnails, changed themes (registering new image sizes), or is fixing broken/missing
thumbnails, I want to trigger WordPress's own thumbnail regeneration for one or more
attachments, so that all registered image sizes stay in sync with the current source file.

**Acceptance Criteria:**
- WHEN `localpress regenerate` is run THE SYSTEM SHALL require either explicit attachment
  IDs or `--all`; IF neither is given THEN THE SYSTEM SHALL print a usage error with example
  invocations and exit with code 2.
- THE SYSTEM SHALL require the `regenerate-thumbnails` capability, which only the WP-CLI
  (SSH) adapter provides — the REST adapter always throws `CapabilityUnavailableError` for
  it. IF no adapter on the resolved site supports it THEN THE SYSTEM SHALL error, direct the
  user to configure SSH and run `localpress doctor`, and exit with code 6, without attempting
  any regeneration.
- WHEN `--all` is passed without the global `--apply` or `--dry-run` flag THE SYSTEM SHALL
  default to dry-run: list every attachment ID that would be regenerated and stop, printing
  the count (and, under `--json`, the full ID list) without calling WordPress.
- WHEN `--all --apply` is passed THE SYSTEM SHALL page through the full media library (100
  items per page) to build the ID set, then execute.
- WHEN executing THE SYSTEM SHALL process attachments concurrently, bounded by
  `--concurrency` (default: CPU count minus one), calling `wp media regenerate` per
  attachment via the WP-CLI adapter and continuing past individual failures.
- WHEN the run completes THE SYSTEM SHALL report a per-ID success/failure breakdown (plain
  text or `--json`) and exit with code 1 if any attachment failed.
