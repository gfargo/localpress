# Changelog

All notable changes to localpress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0](https://github.com/gfargo/localpress/compare/v2.3.0...v2.4.0) (2026-07-17)


### Features

* add `verify` command + dry-run honesty test (Phase 0 complete) ([b74eb7a](https://github.com/gfargo/localpress/commit/b74eb7a6895d9a95a705bd2273726515e6d6e1b2))


### Bug Fixes

* **dry-run:** gate explicit-ID mutation paths behind resolveDryRun ([#219](https://github.com/gfargo/localpress/issues/219)) ([af0c39d](https://github.com/gfargo/localpress/commit/af0c39d8945e4e7e4ad3d789d4251886bb6c9a04))
* **mcp:** preserve per-command JSON shape in batched tool results ([#220](https://github.com/gfargo/localpress/issues/220)) ([c738485](https://github.com/gfargo/localpress/commit/c738485d96f24c29078636cb28eb3e4344ce3f78))
* **mcp:** sites_list empty body, history_list operation enum, posts content E2BIG ([#221](https://github.com/gfargo/localpress/issues/221)) ([459c328](https://github.com/gfargo/localpress/commit/459c32890a953955d60b0e6ee61583660c70a529))
* **wp-cli:** don't swallow post_mime_type update failure in replaceInPlace ([#222](https://github.com/gfargo/localpress/issues/222)) ([ada2f1e](https://github.com/gfargo/localpress/commit/ada2f1e663df14e618d1cdf1f313b7bd2fca7d6d))

## [2.3.0](https://github.com/gfargo/localpress/compare/v2.2.0...v2.3.0) (2026-07-07)


### Features

* **caption:** automatic fallback model on garbage output ([f215951](https://github.com/gfargo/localpress/commit/f215951a9fae1b60835ba6438d68e0a3408889e7))


### Bug Fixes

* add step-by-step progress messages to optimize command ([e1cb470](https://github.com/gfargo/localpress/commit/e1cb4700e9821634b6be3af0bdc32854fa371858))
* **caption:** convert WebP/AVIF to PNG before sending to Ollama ([fcfea13](https://github.com/gfargo/localpress/commit/fcfea13471f4da76fff9250f7704f3228e5667bb))
* **list:** prevent interactive browser hang after subprocess ([42ad509](https://github.com/gfargo/localpress/commit/42ad509bb86a7acbb1bb1e2aba82c7b0adedde12))
* **mcp:** batch large ID sets to prevent timeout on bulk operations ([24eb57f](https://github.com/gfargo/localpress/commit/24eb57fd7111f3be790c8c6572b68012a9cf0526))

## [2.2.0](https://github.com/gfargo/localpress/compare/v2.1.0...v2.2.0) (2026-07-06)


### Features

* add demo GIF to README + fix clipped stats output in recipes ([18ba9b0](https://github.com/gfargo/localpress/commit/18ba9b0595d141375f7eecd5288b487ca1e4d274))
* add interactive browser GIF to README ([f49547a](https://github.com/gfargo/localpress/commit/f49547aa6eef7546d06f09a9428ccc0a74b6bd73))


### Bug Fixes

* prevent footer keybindings from wrapping and clipping header ([540e69f](https://github.com/gfargo/localpress/commit/540e69f83b3ea059d0289b542e21f85542c384cc))
* **tape:** add missing return type to buildTape ([b9ddd56](https://github.com/gfargo/localpress/commit/b9ddd566119df1ba607c273da466da4a6aa47b27))
* **undo:** treat REST-only upload-as-new restore as partial, not restored ([#183](https://github.com/gfargo/localpress/issues/183)) ([89f9f85](https://github.com/gfargo/localpress/commit/89f9f855d4b0e21c5c9cf5c2c6a44a77af1e0483))


### Documentation

* replace browser GIF with static screenshot in README ([bf1eeee](https://github.com/gfargo/localpress/commit/bf1eeee6486ee71345f23f037b77cbcaaa72dae9))

## [2.1.0] - 2026-07-05

The first release since v2.0.0 — a large **trust, correctness, and security**
release that hardens nearly every existing command against the failure modes
surfaced by a full-codebase audit, plus a few new features. No breaking changes.

### Added
- **`sites run <command>`** — run any localpress command across multiple sites
  (`--all-sites` or `--sites a,b,c`), with per-site JSON aggregation and
  per-site failure isolation (#88).
- **`optimize --target-size <size>`** — binary-searches the quality parameter to
  hit a file-size budget (e.g. `100kb`, `1mb`) for jpeg/webp/avif (#87).
- **`optimize --force`** — bypass the idempotency skip and re-process an
  attachment even when the output is already up to date (#97).
- VHS-based screenshot/GIF generation pipeline for docs (#86).

### Fixed — data safety (critical)
- **`references --update-to` is safe under `--dry-run`** and no longer corrupts
  unrelated attachments: the `_thumbnail_id` update is gated, the Gutenberg
  block-ID rewrite is boundary-anchored (so rewriting `12` can't mangle `123`),
  URL replacement runs serialize-safe across all tables, and the real table
  prefix is resolved (#89).
- **Global `--dry-run` is honored** by `delete`, `posts delete`, `posts update`,
  `metadata`, `rename`, `caption`, `tag`, `title`, and `describe` — these
  previously ignored it and executed for real (#90, #128).
- **`undo` restores correctly and safely**: format-changing operations restore
  the original extension/MIME/thumbnails (#91); rename restores the pre-rename
  slug (#109); snapshots are written synchronously and their blobs are
  integrity-checked (size + SHA-256) before restore (#92); an interrupted bulk
  command's session is now the one `undo` targets (#108).
- **`optimize` idempotency is correct in both directions** (#97): re-runs skip
  already-optimized files (comparing against the previous *output* hash) instead
  of re-compressing and double-counting savings; undone attachments become
  re-optimizable again; changed options always re-process.
- **Animated GIF/WebP are preserved, not flattened to one frame**, and are
  skipped with a warning when the target format can't hold animation —
  consistently across `optimize`, `convert`, `resize`, and `watch` (#93).
- **SVG and other unencodable formats are skipped, not rasterized** into PNG
  bytes under the wrong extension (#94).

### Fixed — security
- **WP-CLI/SSH command construction is fully shell-hardened** — every
  interpolated value (titles, alt text, paths, JSON metadata) is escaped, temp
  paths are collision-proof, and the broken metadata-JSON escaping that silently
  corrupted attachments on apostrophes is fixed (#112).
- **Preview server requires a per-session token and validates the `Host`
  header** on every mutating endpoint, defeating other local processes,
  cross-origin pages, and DNS rebinding; the apply/cancel lifecycle no longer
  misreports a successful apply as cancelled (#105, #106).
- **`update` verifies the release tarball's SHA-256** against a published
  `checksums.txt` before extracting, rejects non-HTTPS URLs, and swaps the
  install atomically so a mid-update crash can't brick the binary (#121).
- **Config files are created `0600` atomically**, site names are validated
  against path traversal, and `import` has a Zip Slip guard (#118, #107).

### Fixed — correctness & robustness
- **`remove-bg`** sets the PNG MIME/extension + regenerates thumbnails, and its
  batch no longer aborts on a single item's fetch failure (#95, #96).
- **REST reference scan finds Gutenberg embeds** (`context=edit` raw content),
  and `tag`/`vision` no longer flatten formatted captions (#101).
- **`delete` / `watch --delete`** give actionable guidance (or deliberately
  force-delete with a snapshot) instead of a raw `MEDIA_TRASH` 501 (#102).
- **`audit`** no longer crashes on libraries sized at an exact multiple of 100,
  implements `--unattached`, and reworks `--broken-refs` into an honest
  missing-file probe (#111).
- **`sites run`** forwards `--apply`/`--dry-run`/`--strict` to children, fixes
  its argument tokenizer, and uses a 30-minute child timeout with SIGKILL
  escalation (#104).
- **`a11y`** surfaces scan errors/truncation instead of a false "all clear",
  exiting non-zero on failure (#103).
- **`export`** fails fast on ZIP32 overflow and streams entries to disk instead
  of buffering the whole archive (#116); **`import`** fixes manifest matching,
  supports DEFLATE zips, and deprecates `--preserve-ids` → `--preserve-metadata`
  (#117).
- **`pull`** no longer silently overwrites on basename collisions (#126);
  **`watch`/`edit`** no longer drop saves that land during an in-flight sync
  (#120); the interactive TUI clamps a stale persisted page and wires up
  bulk convert/pull (#125).
- **`posts`** resolves custom-post-type REST routes via `rest_base` (#122);
  **`list`** does global size sorting and exact MIME filtering (#123);
  **`init`** preserves SSH config on re-run (#124); the MCP `optimize` tool's
  params match the CLI flags (#110).
- **SQLite `busy_timeout`** so `watch` + a foreground command sharing a DB no
  longer crash with "database is locked" (#114); WP-CLI `getMedia` distinguishes
  absent meta keys from real failures (#127); model downloads verify integrity,
  and stats math excludes failed/undone operations (#130).
- AI-command robustness (Ollama timeouts, classify, `--fields`, extensions)
  (#129); MCP delete confirm gate + generated shell completions (#134); jsquash
  byteOffset out-of-bounds read (#100); transparent PNG→JPEG flatten + EXIF
  orientation; top-level errors honor `--json` and map to exit codes (#128).
- **`optimize` idempotency now holds on REST-only sites**: a re-run of an
  already-optimized attachment whose optimized copy landed as a *new*
  attachment (the upload-as-new fallback, when replace-in-place isn't available)
  now skips instead of re-optimizing and uploading yet another duplicate on
  every invocation.

### Docs & tests
- Fixed `SKILL.md` JSON-schema drift (the `list --json` shape, missing commands,
  exit codes) and brought `CLAUDE.md`/`README` up to date (#131, #132).
- Large test-coverage expansion: FK-safety, Zip Slip, jsquash, context=edit,
  preview auth, idempotency, and structural coverage-gap closure (#133) — the
  unit suite grew from 212 to ~590 tests.

## [2.0.0] - 2026-05-22

### Added
- **`localpress posts` command**: full WordPress post and page CRUD via REST API.
  Subcommands: `list`, `show`, `create`, `update`, `delete`. Supports custom post
  types (portfolio, event, product — any type with `show_in_rest`). Includes
  `--content-file` for reading content from local files, `--featured-image` for
  setting featured media, and `--category`/`--tag` for taxonomy assignment.
- **`localpress a11y` command**: WCAG accessibility audit for post/page content.
  Checks heading hierarchy (skipped levels, multiple h1s), generic link text
  ("click here", "read more"), missing alt on inline images, and empty links.
  Supports `--type`, `--status`, `--id`, `--limit`.
- **`search_by_url` MCP tool**: resolve a WordPress media URL to attachment
  details in one call. Extracts filename from URL and searches the library.
- **`health_check` MCP tool**: combined doctor + stats + audit (missing-alt)
  in one parallel call. Single round-trip for "what's the state of this library?"
- **`posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`
  MCP tools**: full posts/pages CRUD exposed to agents with typed schemas.
- **`a11y_audit` MCP tool**: accessibility audit exposed to agents.
- **Custom post type support**: all posts commands accept any post type slug
  (not just `post`/`page`). Works with portfolio, event, product, testimonial,
  or any CPT registered with `show_in_rest`.

### Changed
- localpress is no longer just a media optimization tool — v2.0 marks the
  expansion into WordPress content management, accessibility auditing, and
  agent-first site management.

## [1.18.0] - 2026-05-11

### Added

Major vision-AI expansion — five new commands and matching MCP tools that
turn localpress from "alt-text generator" into a full image-metadata
workstation. Same Ollama plumbing as `caption`; same time-machine safety net.

- **`localpress title`** + `generate_title` MCP tool: 3-7 word noun-phrase
  title for the WP `post_title` field. `--missing-title` auto-detects
  machine-generated names (Screenshot-…, IMG_…, DSC_…).
- **`localpress describe`** + `generate_description` MCP tool: 2-3
  sentence description for galleries and attachment-page SEO. Writes to
  the WP description field. `--missing-description` filter.
- **`localpress rename`** + `rename` MCP tool: rename attachment slugs.
  `--smart` uses the vision model to generate a sensible name; `--to`
  takes an explicit string. Both slugify. v1 updates the WP slug
  (`post_name`) only — does not rename the underlying file on disk
  (deferred; requires WP-CLI + filesystem ops).
- **`localpress classify`** + `classify` MCP tool: detect image type
  (screenshot / photo / illustration / diagram) and cache locally.
  **`optimize` now consults the cache** to pick smarter format defaults
  when no explicit `--to` or profile format was given: screenshots /
  diagrams → PNG, photos / illustrations → WebP.
- **`localpress tag`** + `tag` MCP tool: 3-6 short tags appended to the
  caption as a `[tags: …]` block. Universal — doesn't require WP
  attachment taxonomies to be registered. Preserves existing caption
  text; idempotent unless `--overwrite`.
- **`localpress vision`** + `vision` MCP tool: unified workflow.
  Generates alt + title + description + tags + classify in one pass for
  one or more attachments. Print-only by default; `--apply` writes
  everything via a single composed update. `--fields` to subset.
- **`audit --quality`**: flag blurry / low-contrast / poorly-composed
  images via Ollama vision (slow, opt-in only).
- **`audit --ocr-text <term>`**: find images that visually contain the
  given text (slow, opt-in only).

### Changed

- **Engine refactor (`CaptionOptions.kind`)**: the underlying vision
  engine now accepts a `kind` discriminator (`alt | title | description
  | classify | tags`) with per-kind prompt templates and per-kind
  post-processors. Backward-compatible — `kind` defaults to `alt`.
- **New shared `runBulkVision`**: per-item bulk loop with FK-safe
  upserts, time-machine snapshots, and graceful failure handling. Used
  by `title` and `describe`; the existing `caption` is left unchanged
  for safety, can be migrated later.
- **`UpdateMetadata.slug?: string`**: new field forwarded by the REST
  adapter to WP REST `slug`. Used by `rename`.

### Notes

This release expands the MCP tool surface from 27 to 33. Combined with
the `--quality` / `--ocr-text` audit additions, an agent driving
localpress can now generate, edit, classify, search-by-content, and
quality-flag the entire library — all without touching the WordPress
admin. Pairs naturally with the time-machine: every AI write is
undoable.

`--inconsistent` (cross-library style-outlier audit) was on the original
plan but deferred — it needs proper embedding-based clustering and is a
separate design conversation.

## [1.17.1] - 2026-05-11

### Fixed
- **`caption` produced empty responses on large images and multi-paragraph
  essays on screenshots**: surfaced when testing moondream + llama3.2-vision
  on a 4K Mac screenshot. moondream's context budget was blown by the raw
  bytes (returned empty); llama3.2-vision produced 1.5 KB of analysis as
  alt text instead of one sentence. Three safeguards now stack:
  1. Pre-resize the image to 1024×1024 max via sharp before sending to
     Ollama (vision models don't benefit from larger inputs and tiny
     models choke on them).
  2. Hard cap on output via `num_predict: 200` in the Ollama request body.
  3. New `cleanCaption()` post-processor: strips surrounding quotes,
     keeps only the first paragraph, cuts at the first bullet point,
     strips common meta-phrase intros ("The image shows…", "I see…",
     "Description:", etc.), and truncates at a word boundary at ~240
     chars with an ellipsis if anything still got through. 11 unit tests.
- **Empty-response error is now actionable**: includes a hint to try a
  different `--model` instead of just reporting the empty response.

## [1.17.0] - 2026-05-11

### Added
- **`defaults.captionModel` config key**: set the default Ollama vision
  model once instead of passing `--model` on every call. Resolution
  order: `--model` (flag) > `config.defaults.captionModel` > `moondream`
  (built-in). Set via `localpress config set defaults.captionModel
  llava-llama3:latest`.
- **`caption` pre-flight model check**: before starting a bulk loop,
  verify the resolved Ollama model is installed locally. Fails fast with
  an actionable error listing locally-available vision models and three
  remediation paths (pull the requested model, use one already installed,
  set the project default). Catches typos and missing-default cases
  before a 300-item run fails the same way on every item.
- **`list -i` shows the active site name in the header**: the TUI now
  reads `localPress · <site name> — media library` so users managing
  multiple WP sites can see at a glance which site they're working
  against.

### Changed
- **`caption --model` no longer has a hardcoded commander default**: the
  CLI option default was removed so the resolution chain (flag > config
  > built-in) can run cleanly. The built-in default is still `moondream`,
  just no longer baked into the flag itself.

## [1.16.1] - 2026-05-11

### Fixed
- **`caption` crashed with `FOREIGN KEY constraint failed` on per-item failures**:
  when an Ollama 404 (missing model) or image-download 404 hit the catch
  block, `recordProcessing` was called without first upserting an
  attachment row. SQLite aborted the whole bulk run instead of skipping
  the failed item and continuing. Adds the unconditional upfront
  `upsertAttachment` already present in `remove-bg`, plus a defensive
  try/catch on the failure-path `recordProcessing` so future regressions
  fail soft.

## [1.16.0] - 2026-05-11

### Added
- **`localpress metadata` command + `update_metadata` MCP tool**: directly set
  alt text, title, caption, or description on attachment(s) — the manual-edit
  path that complements `caption`'s AI generation. Bulk-applies the same
  metadata across multiple IDs. Idempotent (skips items where all incoming
  fields already match). Time-machine snapshot captured before each write.
- **`localpress delete` command + `delete` MCP tool**: remove attachments,
  defaulting to WP trash (recoverable from admin); `--force` permanently
  deletes. Binary snapshot captured before delete so `undo` can re-upload
  the file (as a new attachment ID; references need manual rewriting since
  WordPress assigns new IDs). Completes CRUD on the attachment surface.
- **`list --search`**: free-text search across filename and title for the
  `list` command. WP REST native `?search=` server-side. Composes with all
  existing filters. `list` MCP tool gains the matching `search` field.
- **`--concurrency` passthrough on bulk MCP tools**: `optimize`, `convert`,
  `resize`, `remove_bg`, `caption`, `export`, and `import` MCP tools now
  accept a `concurrency` field that maps to `--concurrency <n>` at the CLI
  top level. Bulk captioning 300+ images drops from 30-90 min serially to
  ~8-23 min at `concurrency: 4`.
- **`watch_status` MCP tool + `localpress watch-status` command**: reports
  which directories have been watched on the active site (historical
  mapping data + last-activity timestamps). Live-process detection is
  honest about being not-yet-implemented — the schema includes a
  `runningDetectionImplemented: false` field for forward compatibility.
- **Complete schema parity for `import` and `export` MCP tools**:
  - `export` gained: `largerThan`, `includeSizes`, `flat`, `concurrency`
  - `import` gained: `quality`, `maxHeight`, `stripMetadata`, `title`,
    `altText`, `post`, `concurrency`

### Fixed
- **`optimize` MCP tool maps to `--to`, not `--format`** (#50): the optimize
  tool advertised a `format` input that mapped to a nonexistent `--format`
  CLI flag, silently failing every format-conversion attempt via MCP.
  Renamed the input field to `to` (matching the CLI flag and the convention
  used by `convert`/`import`) and updated the argv builder. The schema
  change is technically breaking — but any client that previously passed
  `format` was already silently broken.

### Notes
- This release expands the MCP tool surface from 20 to 27 tools — adding
  `update_metadata`, `delete`, `watch_status`, plus the previously-added
  history/undo cluster. The agent-driven surface is now meaningfully more
  complete: agents can edit, delete, find, parallelize, and check
  automation state without dropping out of the loop.

## [1.15.2] - 2026-05-11

### Fixed
- **Replace-in-place corrupted uploads on symlinked/mounted uploads directories**:
  `getUploadsDir()` used a shell `|| echo` fallback that included `--allow-root`
  in the output path when `wp eval` was suppressed by `2>/dev/null`. This caused
  files to be placed in a bogus directory (e.g., `uploads --allow-root/2024/12/`)
  instead of the real uploads path. Refactored to use TypeScript try/catch instead
  of shell fallback.
- **Silent SCP/mv failures during replace-in-place**: if the file transfer or
  placement failed (permissions, disk full, cross-device issues), the code
  continued updating WordPress metadata anyway — leaving the DB pointing to a
  non-existent file. Now checks exit codes and throws on failure. Also creates
  the target directory with `mkdir -p` before `mv`.
- **Format conversion left stale thumbnails**: converting PNG→WebP (or any format
  change) updated the main file metadata but left old-format thumbnail files on
  disk and their references in `_wp_attachment_metadata.sizes`. WordPress then
  served broken thumbnail URLs. Now deletes old thumbnail files, clears the
  `sizes` array, removes `_require_file_renaming` flag, and **auto-regenerates
  thumbnails** whenever the format changes (no longer requires explicit
  `--regenerate-thumbnails` flag for format conversions).
- **`convert` command didn't pass format-change options to replace-in-place**:
  called `replaceInPlace(id, bytes)` with no options, so the MIME type, filename,
  and extension metadata were never updated on the server. Now passes
  `newMimeType` and `newExtension` correctly.

### Changed
- **Thumbnail regeneration is now automatic on format change**: when `optimize`
  or `convert` changes the file format (e.g., JPEG→WebP), thumbnails are always
  regenerated. The `--regenerate-thumbnails` flag remains available for same-format
  optimizations where you want fresh thumbnails.

## [1.15.1] - 2026-05-11

### Fixed
- **MCP `sites_list` schema validation error**: the MCP protocol requires
  `structuredContent` to be a record (object), but `localpress sites --json`
  returns an array. Now wraps array results in `{ items: [...] }`.
- **MCP silent failures on partial errors**: when caption or other bulk ops
  fail on individual items, error messages from stderr are now included in
  the MCP response text (previously only surfaced on non-zero exit codes).
- **MCP caption tool description**: now mentions that `moondream` is the
  default model and must be pulled first, or pass `model` param for
  alternatives like `llava-llama3`.

## [1.15.0] - 2026-05-11

### Added
- **Time-machine / undo**: every destructive op (`optimize`, `convert`, `resize`,
  `remove-bg`, `caption`) now writes a snapshot of the pre-change state to
  local storage before mutating WordPress. Snapshots are organized into
  sessions (one per command invocation) and walkable per attachment — undoing
  once reverts the most recent op, undoing again reverts the one before, all
  the way back to the original upload. Idempotent skips don't create
  snapshots, so re-running unchanged ops costs nothing.
- **`localpress history` command**: browse the local snapshot archive.
  Subcommands: list (default), `show <id>`, `prune`, `clear`. Filters by
  session, attachment ID, or operation. Pass `-i` for an interactive Ink TUI
  browser mirroring the `list -i` UX.
- **`localpress undo` command**: restore from snapshot(s). Defaults to the
  last session and runs as a dry-run unless `--apply` is passed (matches the
  safe-by-default pattern from optimize/caption/etc.). Single-target modes
  (`--snapshot <id>`, `--attachment <id>`) execute immediately. Restore uses
  the existing replace-in-place path with REST/upload-new fallback.
- **Schema v4**: new `sessions` and `snapshots` SQLite tables, idempotent
  migration. Blob storage at `~/.config/localpress/snapshots/<site>/<session>/`.
- **`stats` shows history block**: snapshot count, storage used vs cap,
  oldest snapshot age, retention policy. `--json` shape extends accordingly.
- **Config keys**: `history.enabled` (default true) and `history.maxSizeBytes`
  (default 2 GiB per site). Set via `localpress config set history.maxSizeBytes <n>`.
- **Default retention policy**: size-capped at 2 GiB per site. Auto-prune runs
  at the end of every destructive op, dropping oldest snapshots first.
- **4 new MCP tools**: `history_list`, `history_show`, `undo`, `history_prune`.
  New `localpress://history` resource for read-only context.

### Notes
- This pairs naturally with v1.14.0's MCP server: agents can now self-correct.
  If an agent runs the wrong bulk op, it (or the user) can call `undo` to
  walk back to the previous state — no external backups needed.
- Snapshots include file bytes for image-changing ops and just metadata
  (alt text, title, caption) for `caption`. Caption snapshots are essentially
  free (a few hundred bytes each).
- Retention is per-site. Each configured site has its own 2 GB cap by default;
  override per site via config.
- Interactive commands (`edit`, `watch`) aren't snapshotted — `edit`'s
  round-trip already preserves the original locally; `watch` continuously
  syncs new files and snapshotting every change would be wasteful.

## [1.14.0] - 2026-05-11

### Added
- **`localpress mcp` command**: first-party Model Context Protocol server.
  Spawned by an MCP host (Claude Desktop, Cursor, Claude Code, etc.) as a
  stdio child process, exposing 20 tools and 3 resources for agentic workflows.
  Same binary, new entrypoint — no daemon, no hosting, no separate config.
- **20 MCP tools** covering setup (`sites_*`, `doctor`, `config_*`), discovery
  (`list`, `show`, `stats`, `audit`, `references`), processing (`optimize`,
  `convert`, `resize`, `remove_bg`, `caption`), and library ops (`pull`, `push`,
  `regenerate`, `export`, `import`). Every tool accepts an optional `site` arg;
  when omitted, the active site from config is used.
- **3 MCP resources** for read-only context: `localpress://sites`,
  `localpress://stats`, `localpress://capabilities`.
- **`@modelcontextprotocol/sdk` dep** (v1.29) — lazy-loaded so CLI startup time
  is unaffected when not running as an MCP server.
- **Round-trip MCP tests** (`test/unit/mcp.test.ts`): boots the server as a
  real subprocess via the SDK's client, asserts on the protocol-level
  responses (listTools, listResources, callTool, input schemas).

### Notes
- Bulk-op tools (`optimize`, `convert`, `resize`, `caption`, etc.) preserve
  the CLI's safe-by-default behavior: passing `unoptimized: true` or
  `all: true` dry-runs unless `apply: true` is also set.
- Interactive commands (`edit`, `watch`, `init`, `update`, `completions`) are
  intentionally not exposed — they require TTY and aren't meaningful in an
  agentic context. Use the CLI directly for those.
- Tools dispatch by spawning the same `localpress` binary recursively with
  `--json --quiet`. This reuses the CLI's stable JSON contract, so every
  existing CLI feature appears in the MCP server with zero per-tool engine
  code. Hot paths can migrate to in-process dispatch later without breaking
  schemas.

## [1.13.1] - 2026-05-10

### Added
- **`caption --all` flag**: process all image attachments in the library. Follows
  the safe-by-default pattern — bulk operations are dry-run unless `--apply` is
  passed, matching the `optimize` command's behavior.
- **`caption --language <lang>` flag**: generate alt text in any language the
  Ollama model supports (e.g. `--language Spanish`, `--language French`). Modifies
  the prompt to request output in the specified language.

### Changed
- **Caption bulk ops are now safe-by-default**: both `--all` and `--missing-alt`
  dry-run unless `--apply` is passed. Previously `--missing-alt` wrote immediately.
  Explicit IDs still execute immediately.

## [1.13.0] - 2026-05-10

### Added
- **`localpress export` command**: export the full media library (or a filtered
  subset) as a ZIP archive or directory. Preserves WP uploads directory structure
  and includes a `manifest.json` with full metadata (id, title, alt, caption,
  SHA-256 hash) for round-trip re-import. Supports `--all`, `--unoptimized`,
  `--type`, `--since`, `--larger-than`, `--include-sizes`, `--flat` filters.
- **`localpress import` command**: bulk import local files, directories, or ZIP
  archives into the WordPress media library. Supports `--optimize` with
  `--quality`, `--to`, `--max-width`, `--max-height` for processing before upload.
  `--preserve-ids` reads manifest metadata from a previous export to restore alt
  text, titles, captions, and descriptions. Concurrency-controlled uploads.
- **`--profile <name>` flag on `optimize`**: loads a named optimization profile
  from config and uses its values (quality, format, maxWidth, maxHeight, encoder,
  stripMetadata) as defaults. Explicit CLI flags override profile values. Clear
  error with available profiles listed if the profile doesn't exist.
- **Profile selector in browser preview**: dropdown at the top of the optimize
  preview sidebar pre-fills quality/format/encoder/resize fields when a profile
  is selected.
- **Profile selector in interactive list**: the optimize overlay (`[o]`) now
  includes a profile field — use ← → or space to cycle through available profiles.
  Selecting a profile pre-fills quality and format fields.
- **Unit tests**: 29 new tests covering profile resolution, export/import command
  registration, ZIP round-trip integrity, CRC-32, image file detection, and
  directory scanning.

## [1.12.0] - 2026-05-10

### Fixed
- **Replace-in-place now handles format conversions**: when optimizing with
  format change (e.g. PNG → WebP), the WP-CLI adapter now correctly updates
  the filename, MIME type (`post_mime_type`), file path (`_wp_attached_file`),
  and filesize in `_wp_attachment_metadata`. Previously only the file bytes
  were replaced on disk — WordPress still reported the old format and size.
  Verified end-to-end: `optimize 2204 --to webp` correctly shows as WebP
  in the WordPress media library.

## [1.11.3] - 2026-05-09

### Fixed
- **Stale metadata in `list -i` after processing**: after optimize/convert/resize/
  remove-bg, the browser now re-fetches the specific item individually to bypass
  WordPress's page-level REST API cache. The list immediately shows the correct
  updated mimeType, file size, and dimensions.
- **Browser preview shows fresh metadata after apply**: the success screen now
  displays the actual format, size, and dimensions from WordPress (e.g.
  "Uploaded as #2204 · WEBP · 114.2 KB · 1672×941") instead of just the ID.

## [1.11.2] - 2026-05-09

### Fixed
- **Tarball size reduced from ~231MB to ~26MB**: stripped unused onnxruntime-node
  platform binaries (darwin, win32, linux/arm64) and GPU provider libraries
  (`libonnxruntime_providers_cuda.so` ~329MB, TensorRT) — localpress uses CPU
  inference only.
- **Tarball smoke tests**: new CI job builds the linux-x64 tarball and runs 9
  smoke tests on every PR, verifying binary functionality, sharp availability,
  platform-specific deps, and size limits.

## [1.11.1] - 2026-05-08

### Fixed
- **Tarball size reduced from 648MB to ~106MB**: CI was installing all 8 platform
  variants of sharp's native binaries. Setting `npm_config_os` and `npm_config_cpu`
  environment variables during `npm install` now correctly filters to only the
  target platform's binaries.

## [1.11.0] - 2026-05-08

### Added
- **`localpress watch` command**: continuous directory watcher that automatically
  pushes new/changed images to WordPress. Supports `--optimize`, `--to <format>`,
  `--max-width`, `--max-height` for processing before upload. `--delete` flag
  removes from WP when local files are deleted. Uses SHA-256 deduplication and
  persists file→attachment mappings in SQLite (schema v3 migration).

### Changed
- **Distribution model**: localpress is now distributed as a tarball (bundle +
  node_modules + shell wrapper) instead of a compiled single-file binary. This
  fixes the long-standing issue where image operations (optimize, convert, resize,
  remove-bg) failed on Homebrew installs because sharp couldn't be loaded from
  within Bun's compiled binary virtual filesystem.
- **Homebrew formula**: now `depends_on "oven-sh/bun/bun"` and installs the
  tarball to `libexec/` with a thin wrapper at `bin/`. `brew install` still works
  as a single command — Bun is handled transparently as a dependency.
- **`localpress update`**: now downloads and extracts tarballs instead of swapping
  a single binary. Includes atomic directory replacement with backup + rollback.
- **Self-invoke logic**: new 3-mode detection (dev mode, tarball via LOCALPRESS_BIN
  env var, fallback) for correct subcommand dispatch from `list -i`.
- **Prompt utility**: extracted shared y/N prompt using readline instead of raw
  mode (fixes buffered input consumption in auto-install prompt).
- **Shell completions**: updated for `watch` command with all its flags.

### Fixed
- **Image operations work on Homebrew installs**: sharp and all its transitive
  dependencies are now bundled in the tarball's `node_modules/`. No more
  "sharp is not installed" errors. No more asking users to install sharp manually.

## [1.10.1] - 2026-05-08

### Fixed
- **Homebrew install no longer fails on outdated Xcode CLT**: removed
  `npm install -g sharp` from the formula. Installing sharp at brew install
  time required a working C++ toolchain and compiled sharp from source,
  which failed loudly on machines with slightly outdated Xcode Command Line
  Tools ("Error: A newer Command Line Tools release is available"). The
  smart sharp path discovery + auto-install prompt added in v1.10.0 already
  handles this cleanly at first use — Homebrew users now get a fast binary
  install and a friendly prompt to install sharp on first `optimize`.

### Removed
- **`src/shims/sharp-wasm32.d.ts`**: dead type declaration left over when
  `@img/sharp-wasm32` was removed in v1.10.0.

## [1.10.0] - 2026-05-08

### Added
- **Smart sharp path discovery**: the sharp loader now checks well-known global
  paths (`~/.bun/install/global`, `/opt/homebrew/lib`, `/usr/local/lib`, etc.)
  when standard module resolution fails. If sharp is installed globally anywhere,
  it's found automatically.
- **Auto-install prompt for sharp**: when sharp isn't found, `optimize`,
  `convert`, `resize`, and `remove-bg` now offer to install it interactively.
  Respects `--yes` for unattended installs and skips the prompt in `--json`
  or `--quiet` modes.
- **`localpress doctor --fix` auto-installs sharp**: if doctor detects sharp
  is missing, `--fix` installs it automatically alongside other remediation.
- **Sharp status in `localpress doctor`**: new line shows `✓/✗ sharp
  (image processing)` so users can see whether sharp is available.
- **Homebrew formula installs sharp**: the formula now runs
  `npm install -g sharp` during installation and `depends_on "vips"`.
- **`SharpNotInstalledError` class**: typed error so callers can detect and
  handle the missing-sharp case specifically.

### Changed
- **Sharp loader simplified**: dropped the broken `@img/sharp-wasm32` fallback
  (it never actually installed due to platform-mismatched optional deps). The
  new loader is cleaner and actually works.

### Removed
- **`@img/sharp-wasm32` dependency**: was dead code — never installed, never
  bundled, never used.
- **`src/shims/sharp-wasm32.d.ts`**: type declaration for the removed package.

## [1.9.0] - 2026-05-08

### Added
- **`localpress regenerate` command**: regenerate WordPress thumbnails for one
  or more attachments via WP-CLI. Supports `--all --apply` for bulk, parallel
  execution via `--concurrency`, and full `--json` output.
- **`@img/sharp-wasm32` fallback**: compiled binaries now bundle a WASM build of
  sharp that activates automatically when native sharp isn't available. Image
  processing works out of the box without any additional user setup.
- **`--regenerate-thumbnails` flag** on `optimize`: opt-in thumbnail regeneration
  after replace-in-place (previously always ran, now skipped by default).

### Changed
- **Replace-in-place is 2-3x faster**: thumbnail regeneration is now opt-in
  instead of automatic. The file is still replaced in place (same URL, same ID),
  but `wp media regenerate` only runs when `--regenerate-thumbnails` is passed.
- **Cached uploads directory**: the WP-CLI adapter caches the WordPress uploads
  base path after first retrieval, saving one SSH round-trip per operation.
- **`O` in `list -i` skips terminal form**: pressing `O` (optimize with preview)
  now goes straight to the browser preview instead of showing the terminal
  quality/format settings form first.

### Fixed
- **Preview server apply timeout**: increased `Bun.serve()` `idleTimeout` from
  10s to 120s. The apply endpoint does WP-CLI replace-in-place over SSH which
  can take 10-30+ seconds — Bun was killing the connection before it completed.
- **Preview server shutdown race**: delayed server shutdown by 500ms after
  sending the apply response so the browser receives the full response before
  the TCP connection is torn down.

## [1.8.2] - 2026-05-08

### Added
- **Loading spinner for `list -i`**: shows "⠋ Loading media library..." while the
  initial page is being fetched from the REST API. Previously the terminal was
  blank for 3-8 seconds during the fetch, making it look like the command hung.

### Fixed
- **`list -i` subcommand dispatch**: pressing `o` (optimize), `e` (edit), etc. in
  the interactive browser failed with `Script not found "optimize"` on compiled
  binaries. The subprocess was being spawned with `bun` as the binary instead of
  the localpress executable. Extracted self-invoke logic into a testable utility
  (`src/cli/utils/self-invoke.ts`) that correctly detects dev mode vs compiled
  binary and uses `process.execPath` for the latter.

## [1.8.1] - 2026-05-08

### Fixed
- **`list -i` hangs when SSH is configured**: the adapter resolver now uses
  per-capability priority — REST is preferred for read operations (`list`, `get`,
  `upload`, `update-meta`, `delete`, `fast-references`) since it's a single HTTP
  request. WP-CLI is only preferred for server-side operations that REST can't do
  (`replace-in-place`, `regenerate-thumbnails`, `prune-orphans`, `full-references`).
  Previously, WP-CLI was used for everything when SSH was configured, causing 100+
  sequential SSH round-trips per page load.
- **Zsh completions install instructions**: fixed inline comments in the generated
  zsh completion script that broke sourcing.

## [1.8.0] - 2026-05-08

### Added
- **`localpress update` command**: self-update via GitHub Releases. Checks for
  newer versions, downloads the correct platform binary, and replaces the current
  binary in-place. `--check` for scripting (exit 1 if update available), `--yes`
  for unattended installs. Detects Homebrew installations and suggests
  `brew upgrade` instead. Full `--json` support.
- **`localpress completions` command**: generates shell completion scripts for
  bash, zsh, and fish. All 19 commands with subcommand-specific options, typed
  argument completions (formats, models, sort fields), and shell-idiomatic
  patterns.
- **Full stats dashboard** (`localpress stats`): now shows library overview
  (total attachments, size, optimized/unoptimized %), format breakdown (JPEG,
  PNG, WebP, AVIF counts), and recent operations grouped by date — in addition
  to the existing processing history stats.
- **New `SiteDb` methods**: `getLibraryOverview()`, `getFormatBreakdown()`,
  `getRecentOperations()` for the stats dashboard.

### Fixed
- **SSH "Too many authentication failures"**: added `IdentitiesOnly=yes` when
  `identityFile` is configured. Prevents the SSH agent from offering all its
  keys before trying the specified one, which caused disconnects on servers with
  low `MaxAuthTries`.

## [1.7.0] - 2026-05-08

### Added
- **SSH configuration in init wizard**: after REST authentication succeeds and
  missing capabilities are detected, the wizard now offers to configure SSH
  interactively. Prompts for host, user, port, WordPress path, and identity file.
  Tests the SSH connection (verifies `wp --info` and `wp-config.php` existence)
  and shows an updated capability report with all capabilities unlocked.
- **Explicit `user` field on `SshConfig`**: SSH username is now a dedicated
  required field instead of being embedded in the `host` string as `user@host`.
  The adapter is backward-compatible with legacy configs that use the old format.
- **25 new unit tests** for SSH helpers (`sshDestination`, `buildSshArgs`),
  `isWpCliAvailableForSite` edge cases, and `AdapterResolver` behavior with
  various SSH config shapes. Total unit test count: 61.

### Changed
- **`isWpCliAvailableForSite`** now requires `host`, `user`, AND `wpPath` to all
  be non-empty (previously only checked `host` and `wpPath`).
- **SSH adapter** exports `sshDestination()` and `buildSshArgs()` for unit testing.
- **Wiki documentation** rewritten: `WP-CLI-SSH-Setup.md` now includes explicit
  field descriptions, common hosting examples (VPS, Kinsta, cPanel, GridPane),
  expanded troubleshooting table, and manual testing commands.
  `Configuration.md` updated to match the new field names.

## [1.6.0] - 2026-05-03

### Added
- **Browser preview for `optimize` and `remove-bg`**: pass `--preview` to open a local web UI
  where you can adjust settings (quality, format, model, alpha threshold, background color),
  see before/after comparison with a draggable slider, and apply the result to WordPress with
  one click. The preview server uses `Bun.serve()` on localhost with auto-assigned port.
- **WebSocket heartbeat**: the preview server detects when the browser tab closes and shuts
  down cleanly, returning control to the CLI without hanging.
- **BiRefNet model** (`birefnet-lite`): state-of-the-art background removal model (MIT licensed,
  ~224 MB). Uses Swin Transformer backbone with sigmoid output activation. Downloaded from
  HuggingFace ONNX community on first use.
- **ISNet model** (`isnet-general-use`): better edge quality than U2-Net for background removal
  (~176 MB, Apache-2.0). Uses 1024×1024 input resolution vs U2-Net's 320×320.
- **Quick browser image viewer** (`[P]` in interactive list): opens the selected image in the
  system browser via a lightweight localhost server. Terminal-agnostic alternative to the
  iTerm2 inline preview. Auto-shuts down when the tab closes.
- **Preview keybindings in interactive list**: `[O]` opens the optimize settings overlay in
  preview mode (opens browser after confirming settings), `[R]` opens remove-bg with browser
  preview. Lowercase `[o]` and `[r]` remain the fast non-preview paths.
- **Interactive list position persistence**: the page and cursor position are saved to SQLite
  when you quit the interactive browser and restored on next launch. Schema v2 migration adds
  a `preferences` key-value table.
- **Per-model input sizes**: the remove-bg engine now uses model-specific input resolutions
  (320×320 for U2-Net family, 1024×1024 for ISNet and BiRefNet) instead of a hardcoded constant.

### Changed
- **Default remove-bg model in preview UI**: the browser preview defaults to `birefnet-lite`
  (best quality) with `isnet-general-use` as second option. CLI default remains `u2net` for
  backward compatibility.
- **Schema version**: bumped to v2 (migration adds `preferences` table).

## [1.5.0] - 2026-05-03

### Added
- **`list -i` expanded sidebar actions**: image items now show `[r]` remove-bg, `[c]` convert,
  `[s]` resize, and `[a]` caption alongside the existing `[o]` optimize and `[e]` edit actions.
  Non-image items show only the actions that apply to them.
- **`list -i` optimize settings overlay**: pressing `[o]` now opens a settings form before
  dispatching — choose quality (0–100), target format (`keep`/webp/avif/jpeg/png, cycled with
  `←→`), and keep-original toggle. Press `↵` with blank fields to use CLI defaults.
- **`list -i` convert quality step**: after picking a format with `[c]`, a second prompt lets
  you enter a quality value (0–100) before confirming. `Esc` goes back to format selection.
- **`list -i` open in WordPress (`[W]`)**: `Shift+W` opens the WP admin media editor for the
  selected item in the system browser without leaving the TUI.
- **`list -i` alt text visibility**: list rows show a yellow `⚠` indicator for any image
  missing alt text. The sidebar shows `⚠ no alt text` / `✓ alt: <text>`. The details overlay
  always shows the Alt text field for images with an actionable hint when missing.
- **`list -i` details overlay enriched**: now shows Caption, Description, and a `⚠ missing`
  hint for images without alt text suggesting `[a]` to generate.

### Fixed
- **`remove-bg` model download 401**: switched ONNX model URLs from HuggingFace
  (now auth-gated) to GitHub release assets (`github.com/danielgatis/rembg/releases/download/v0.0.0/`).
  Existing cached models are unaffected.
- **`remove-bg` FOREIGN KEY constraint**: failure records were written to
  `processing_history` before the corresponding `attachments` row existed (e.g. when a
  model download failed on first use). Fixed by moving `upsertAttachment` to immediately
  after `getMedia` succeeds, ahead of any potentially-failing work.

## [1.4.3] - 2026-05-03

### Fixed
- **CI integration tests**: replaced GitHub Actions `services:` block and manual
  `docker run` / `docker exec` steps with `docker compose -f test/integration/docker-compose.yml`.
  The old approach used `${{ job.services.db.network }}` which `act` cannot resolve locally,
  making local CI reproduction impossible. The new approach works identically in both
  `act push -j integration-test` and the real GitHub Actions runner.
- **`setup-wp.sh` consolidated all WP setup**: pretty-permalinks, Apache `SetEnvIf`
  auth passthrough, must-use plugin for Application Passwords on HTTP, and
  `chown -R www-data:www-data wp-content` so the REST API upload test can write
  to directories that WP-CLI created as root.

## [1.4.2] - 2026-05-03

### Added
- **`list --interactive` live search**: press `/` to open a search bar and filter the current
  page's media list by filename or title in real time — no extra API calls. Typing narrows the
  list immediately; the bar shows a match count (`12 matches`). Navigation keys (`↑↓`/`jk`)
  work while the search bar is open. `Enter` exits typing mode but keeps the filter active so
  you can navigate the results. `Esc` clears the filter and restores the full list (or, if no
  filter is active, quits). Pressing `q` when a filter is active also just clears the filter.
  Loading a new page always clears the search. Keybinding hint `[/] search` added to the footer.
  Resolves [#14](https://github.com/gfargo/localpress/issues/14).

## [1.4.1] - 2026-05-03

### Fixed
- **`list --interactive` inline image preview**: removed auto-fetch on selection change — the
  previous behaviour fetched the full image on every cursor move, causing visible lag and
  cancelling in-flight requests. Preview is now **on-demand only**: press `[p]` to fetch and
  display. Subsequent presses on the same item reuse the cached download; selecting a new item
  clears the cache so `[p]` always shows the correct image.
- **`list --interactive` layout disruption from iTerm2 inline images**: the sidebar previously
  embedded the inline image escape sequence in a `<Box height={10}>` flex child. The iTerm2
  protocol rows propagated through the Yoga layout, creating a large vertical gap in the list
  panel. Images are now rendered only in a dedicated **preview overlay mode** (a completely
  separate Ink render tree with no list flex siblings), which eliminates the height-push
  entirely.

### Changed
- **`list --interactive` preview UX**: image preview is now a full-screen overlay triggered by
  `[p]`. The overlay shows the image scaled to the full terminal width/height, with a metadata
  strip and `[p] / [Esc]` to return to the list. The sidebar retains all metadata (filename,
  MIME type, dimensions, URL, optimized status) but no longer contains the inline image.
- Footer and sidebar keybinding hints show `[p] preview image` only on terminals that support
  the iTerm2 inline image protocol (iTerm2, Warp, WezTerm, Kitty).

## [1.4.0] - 2026-05-03

### Added
- **`caption` command**: AI alt-text generation for images using a locally-running
  [Ollama](https://ollama.com) vision model — no cloud API, no credits, no data
  leaving your machine. Supports bulk mode (`--missing-alt`), dry-run, model
  selection (`--model llava`), custom prompts, and `--list-models` to see what's
  installed. Recommended model: `moondream` (~1.7 GB). See the new
  [Ollama Setup guide](https://localpress.griffen.codes/docs/ollama-setup).
- **`stats` command**: cumulative processing stats pulled entirely from local
  SQLite — zero network calls. Shows files touched, operations succeeded/failed,
  total bytes saved (with % reduction), last-run date, and a per-operation
  breakdown table. `--all-sites` aggregates across every configured site.
- **`list --sort` and `--order` flags**: sort the media library by `date`
  (default), `name`, `size`, or `id`; order `asc` or `desc`. Sort info is shown
  in the plain-text header and preserved in the "next page" hint.

### Fixed
- **Integration test CI**: fixed WordPress Application Password auth in Docker —
  `wp core install` was using the container-internal port (`80`) as the site URL
  instead of the host-mapped port (`8880`), causing every REST API request to be
  redirected to a port not exposed on the host. Also added pretty-permalink setup
  (`wp rewrite flush --hard`) and an Apache `SetEnvIf Authorization` directive so
  `PHP_AUTH_USER` / `HTTP_AUTHORIZATION` reach PHP correctly.

## [1.3.1] - 2026-05-02

### Fixed
- **`list --interactive` typecheck errors**: restored missing `MediaItem` import
  removed when the exit-to-preview flow was deleted; boxed `pendingAction` in an
  object container so TypeScript does not narrow it to `never` across the
  `await waitUntilExit()` boundary.

### Changed
- **`list --interactive` sidebar thumbnail**: inline image preview now loads
  directly in the sidebar via the iTerm2 inline-image protocol — no TUI exit
  required. Supported terminals: iTerm2, Warp, WezTerm, Kitty.
- **`list --interactive` page-nav hints**: navigation bar now shows
  `← [b] prev page` / `[n] next page →` with dimming at boundaries, making
  paging discoverable at a glance.
- **`list --interactive` page-load spinner**: list panel replaces stale items
  with a centered braille spinner during page fetches; nav bar also animates.
- Removed `[v] preview` keybinding — preview is now always-on in the sidebar.

## [1.3.0] - 2026-05-02

### Added
- **`list --interactive` / `list -i`**: Ink-based TUI for browsing the media
  library without leaving the terminal. Arrow keys / `j`/`k` navigate items;
  `n`/`b` load the next/previous page; `o` emits an optimize command, `e`
  an edit command, `↵` a show command, `v` a preview command — then exits.
  On terminals ≥ 110 columns a sidebar renders the selected item's filename,
  MIME type, dimensions, URL, and localpress processing status.
- **`list --page <n>`**: explicit page selection for plain and JSON modes.
  WP REST API pagination is fully exposed — `--limit` sets `per_page` (max
  100), `--page` sets `page`.
- **`list` total-count display**: plain output now shows
  `Showing 1–50 of 355 item(s) (page 1/8)` and prints a
  `Next page: localpress list --page 2` hint when more pages exist. JSON
  output gains `total`, `totalPages`, and `page` fields.
- **`list -v` image preview**: when the terminal supports iTerm2 inline
  images (iTerm2, Warp, WezTerm, Kitty), pressing `v` in interactive mode
  fetches the selected image and renders it inline via the iTerm2 protocol.
  Falls back to printing the image URL on unsupported terminals.
- **`PagedResult<T>` type** and **`listMediaPage()`** method on the
  `WpBackend` interface. `RestAdapter` reads `X-WP-Total` and
  `X-WP-TotalPages` response headers; `WpCliAdapter` delegates to
  `listMedia()` and returns `totalPages: 1`.
- **WP-CLI SSH Setup wiki guide** at `.wiki/WP-CLI-SSH-Setup.md` — covers
  prerequisites, the SSH config block, common hosting setups (VPS, Kinsta /
  WP Engine, cPanel), and troubleshooting.

### Changed
- `init` SSH tip now links directly to the wiki guide:
  `localpress.griffen.codes/docs/wp-cli-ssh-setup`.
- `list --limit` is now capped at 100 (WP REST API maximum) and defaults
  to 50; previously the default was also 50 but the cap was not enforced.

## [1.2.0] - 2026-05-02

### Added
- **`audit --display-size`**: flags images significantly larger than their largest
  registered WordPress thumbnail size (≥2× pixel area). Compares source dimensions
  against `media_details.sizes` from the REST API. Surfaces the most common waste
  in real media libraries — a 4000px image used only as a 400px thumbnail.
- **`audit --duplicates`**: perceptual duplicate detection using dHash (difference
  hash) computed via sharp. Downloads each image, resizes to 9×8 grayscale, and
  compares 64-bit hashes with Hamming distance ≤ 5. Groups near-identical images
  for deduplication.
- **`audit --broken-refs`**: HEAD-checks every attachment URL concurrently (10 at
  a time) and flags any that return HTTP 404/410 or are unreachable.
- **`doctor --plugins`**: probes the WP REST API plugins endpoint to detect
  relevant installed plugins — Enable Media Replace (capability unlock), Jetpack
  (CDN awareness), Smush/ShortPixel/EWWW (conflict warnings).
- **`doctor --fix`**: runs a live REST API connection test and surfaces actionable
  remediation steps for auth failures, unreachable sites, and missing SSH config.
- **`config` command** with subcommands:
  - `config get <key>` / `config set <key> <value>` for `active-site`,
    `defaults.quality`, `defaults.format`, `defaults.concurrency`.
  - `config list` — prints full config with app passwords redacted.
  - `config set-profile <name>` — create/update named optimization profiles with
    `--quality`, `--format`, `--max-width`, `--max-height`, `--encoder`,
    `--strip-metadata`, `--description`.
  - `config get-profile`, `config list-profiles`, `config remove-profile`.
- **`OptimizationProfile` type** in `src/types.ts` — reusable processing presets
  stored in config and applied via `localpress optimize --profile <name>`.
- **`Config.profiles`** and **`Config.defaults`** fields for global defaults and
  named profiles.
- **Homebrew formula** at `Formula/localpress.rb` — platform-specific binary
  downloads for macOS (arm64/x64) and Linux (arm64/x64).
- **Release workflow** at `.github/workflows/release.yml` — builds binaries,
  computes SHA256 checksums, creates GitHub Release, and pushes updated formula
  to the `gfargo/homebrew-localpress` tap repository.
- **Homebrew tap repository** at `gfargo/homebrew-localpress` — enables
  `brew install gfargo/localpress/localpress`.

### Removed
- `undici` dependency — Bun's built-in `fetch` handles all HTTP; undici was
  unused dead weight.

### Changed
- CLI now registers 15 commands (added `config`).
- `doctor` now tests REST API connectivity on every invocation and reports
  `✓/✗ REST API connection` status.
- `audit` JSON output now includes `displaySize`, `duplicates`, and `brokenRefs`
  counts in the summary object.

## [1.1.0] - 2026-05-02

### Added
- **Ink-based interactive init wizard**: full React terminal UI with step-by-step
  prompts, colored output, masked password display, connection test spinner, and
  capability report. Replaces the readline-based prompts from v0.1. Falls back
  gracefully to non-interactive mode if Ink rendering fails.
- **jSquash WASM codec integration** (`--encoder jsquash`): alternative encoding
  path using Squoosh-derived WASM codecs for the final encoding step.
  - **OxiPNG** for significantly better lossless PNG compression than sharp's
    built-in PNG encoder.
  - MozJPEG, WebP, and AVIF encoding with full parameter control.
  - Consistent cross-platform output (WASM, no native binary differences).
  - Sharp still handles all transforms (resize, rotate, metadata strip);
    jSquash handles the final encoding when `--encoder jsquash` is passed.
- `OptimizeOptions.encoder` field in the engine types for programmatic use.

## [1.0.0] - 2026-05-02

### Added
- **Full skill for AI agent integration** (`skill/SKILL.md`): complete command
  reference with JSON output schemas, composition guide for WP MCP servers,
  global flags reference, error handling guide, and key behavior documentation.
  Ready for distribution via skill marketplaces.
- **`--rembg` flag** on `remove-bg` command: shells out to system Python rembg
  for users who have it installed (`pip install rembg[cli]`). Gives access to
  rembg's full model zoo and GPU acceleration without bundling Python.
- **`--rembg-model` flag**: pass any rembg model name (e.g. `isnet-general-use`,
  `birefnet-general`) when using the system rembg path.

### Changed
- Version bumped to 1.0.0 — all planned features from the v1 implementation
  plan are complete.

## [0.4.0] - 2026-05-02

### Added
- **`edit` command** — the round-trip editing workflow. Downloads an attachment
  to a temp directory, opens it in the user's default editor (or `--with <app>`),
  watches for saves via chokidar, and uploads changes back to WordPress
  automatically. The workflow no incumbent offers.
  - Cross-platform editor detection: macOS (`open`), Linux (`xdg-open`),
    Windows (`start`), or explicit `--with Photoshop` / `--with gimp`.
  - File watcher with debouncing and `awaitWriteFinish` to handle editors
    that do atomic writes (temp file → rename).
  - `--no-watch` to open without watching (manual upload via `push`).
  - `--keep-file` to preserve the temp file after editing.
  - `--to <dir>` to download to a specific directory.
  - Each save is recorded as an 'edit' operation in SQLite.
  - Standard replace-in-place fallback chain for uploads.

## [0.3.0] - 2026-05-02

### Added
- **AI background removal** (`remove-bg` command): local inference using
  ONNX Runtime + U2-Net models. No cloud API, no AGPL dependencies.
  - Three model options: `u2net` (~176MB, best quality), `u2netp` (~4.7MB,
    lightweight), `silueta` (~44MB, balanced).
  - Models auto-download from HuggingFace on first use and cache locally.
  - All models Apache-2.0 licensed.
  - `--bg <color>` for solid background instead of transparency.
  - `--trim` to remove transparent borders.
  - `--list-models` to show available models and cache status.
  - `--keep-original` to upload as new attachment.
  - Standard replace-in-place fallback chain.
- **ONNX type declarations** for type-safe inference without requiring
  onnxruntime-node at typecheck time.
- **Model manager** with download progress reporting and local caching
  at `$XDG_CONFIG_HOME/localpress/models/`.

### Dependencies
- Added `onnxruntime-node` ^1.22.0 (MIT license).

## [0.2.0] - 2026-05-02

### Added
- **WP-CLI adapter**: full `WpBackend` implementation over SSH, enabling
  true in-place file replacement, thumbnail regeneration, orphan pruning,
  and full content scanning.
- **SSH execution helper**: shells out to system `ssh`/`scp` binaries,
  works with existing SSH agent and key management.
- **`convert` command**: convert attachments between formats (webp, avif,
  jpeg, png) with quality control and replace-in-place fallback.
- **`resize` command**: resize attachments with `--max-width`/`--max-height`,
  preserving aspect ratio. Regenerates WP thumbnails via WP-CLI when available.
- **Full audit checks**:
  - `--orphans`: filesystem scan via WP-CLI to find files with no DB record.
  - `--missing-alt`: now works reliably for all items.
  - Structured grouped output for all finding types.
- **Full reference scanning** (`--scope full`): content URL matching and
  post meta scanning via WP-CLI, in addition to the existing fast scan.
- **Reference rewriting** (`--update-to`): rewrites `_thumbnail_id` meta,
  content URLs via `wp search-replace`, and Gutenberg block IDs. Supports
  `--dry-run` for safe preview.

### Changed
- CLI now registers 12 commands (added `convert` and `resize`).
- Audit command restructured with proper finding type taxonomy.
- References command no longer gates `--update-to` behind a "not yet available" error.

## [0.1.0] - 2026-05-02

### Added
- **SQLite state layer**: per-site database with attachment tracking, processing
  history, and migration support via `bun:sqlite`.
- **Config loading/persistence**: XDG-compliant config at
  `~/.config/localpress/config.json` with 0600 permissions on POSIX.
- **REST adapter**: full WordPress REST API integration with Application Password
  auth, media CRUD, and fast reference scanning (featured images + Gutenberg blocks).
- **Image optimization engine**: framework-agnostic module using sharp with
  mozjpeg, png, webp, and avif encoding. Lazy-loaded for fast CLI boot.
- **All 10 v0.1 CLI commands**:
  - `init` — interactive setup wizard with readline prompts and masked password input.
  - `sites` — list, add, use, remove configured WordPress sites.
  - `doctor` — backend availability and capability matrix.
  - `list` — filterable media listing with `--unoptimized` SQLite cross-reference.
  - `show` — single attachment detail with processing history.
  - `audit` — find unoptimized, large, and missing-alt-text images.
  - `optimize` — compress and convert media with idempotency (hash-based),
    dry-run safety for bulk ops, and replace-in-place fallback chain.
  - `pull` — download attachments to local directory.
  - `push` — upload local files with replace-in-place fallback.
  - `references` — fast scan for featured images and Gutenberg block references.
- **Integration test infrastructure**: Docker Compose setup with WordPress 6.7 +
  MySQL 8.0, WP-CLI setup script, and 10 integration tests.
- **CI workflow**: separate unit and integration test jobs, binary builds on tag.
- 36 unit tests, 11 integration tests (skip when Docker WP not available).

### Changed
- Removed `notImplemented()` scaffold helper — all commands now have real implementations.

[Unreleased]: https://github.com/gfargo/localpress/compare/v1.15.2...HEAD
[1.15.2]: https://github.com/gfargo/localpress/compare/v1.15.1...v1.15.2
[1.15.1]: https://github.com/gfargo/localpress/compare/v1.15.0...v1.15.1
[1.12.0]: https://github.com/gfargo/localpress/compare/v1.11.3...v1.12.0
[1.11.3]: https://github.com/gfargo/localpress/compare/v1.11.2...v1.11.3
[1.11.2]: https://github.com/gfargo/localpress/compare/v1.11.1...v1.11.2
[1.11.1]: https://github.com/gfargo/localpress/compare/v1.11.0...v1.11.1
[1.11.0]: https://github.com/gfargo/localpress/compare/v1.10.1...v1.11.0
[1.10.1]: https://github.com/gfargo/localpress/compare/v1.10.0...v1.10.1
[1.10.0]: https://github.com/gfargo/localpress/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/gfargo/localpress/compare/v1.8.2...v1.9.0
[1.8.2]: https://github.com/gfargo/localpress/compare/v1.8.1...v1.8.2
[1.8.1]: https://github.com/gfargo/localpress/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/gfargo/localpress/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/gfargo/localpress/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/gfargo/localpress/compare/v1.5.0...v1.6.0
[1.3.1]: https://github.com/gfargo/localpress/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/gfargo/localpress/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/gfargo/localpress/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/gfargo/localpress/compare/v1.0.0...v1.1.0
[1.15.1]: https://github.com/gfargo/localpress/compare/v1.15.0...v1.15.1
[1.0.0]: https://github.com/gfargo/localpress/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/gfargo/localpress/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gfargo/localpress/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gfargo/localpress/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gfargo/localpress/releases/tag/v0.1.0
