# Media Discovery & Audit

Backfilled spec documenting already-shipped functionality.

This subsystem is how a user (or an AI agent driving localpress via the skill or the MCP
server) finds out what's in a WordPress media library and whether it needs attention. It
covers five CLI commands — `list`, `show`, `stats`, `audit`, and `references` — plus the
`list --interactive` Ink TUI (`MediaBrowser`). None of these commands mutate WordPress
content by themselves (the `references --update-to` rewrite path is the one exception);
they exist to let a user or agent decide *what* to run next (`optimize`, `caption`,
`resize`, `delete`, …) with real information instead of guessing. `list`/`show`/`audit`
read primarily from the WordPress REST API (or WP-CLI where configured), cross-referenced
against the local SQLite cache for localpress-specific concepts like "already optimized"
that WordPress itself has no notion of.

## Requirement 1: List media with composable filters

**User Story:** As a user or agent, I want to list the WordPress media library with
filters for type, size, date, and processing status, so that I can narrow down to the
attachments I actually care about before running a bulk operation.

**Acceptance Criteria:**
- WHEN `localpress list` is run with no flags THE SYSTEM SHALL return the first page of
  media items sorted by date descending (WordPress's default order).
- WHEN `--type <mime>` is passed THE SYSTEM SHALL filter to that MIME type or category
  (e.g. `image/png` matches only PNGs; a bare category like `image` matches every image
  subtype) by passing `mime_type`/`media_type` through to the WordPress REST API.
- WHEN `--post <id>` is passed THE SYSTEM SHALL restrict results to attachments associated
  with that post ID.
- WHEN `--since <date>` is passed THE SYSTEM SHALL restrict results to items uploaded on or
  after that ISO date.
- WHEN `--larger-than <bytes>` is passed THE SYSTEM SHALL filter out items smaller than the
  given byte threshold (applied client-side after the page is fetched).
- WHEN `--search <term>` is passed THE SYSTEM SHALL free-text search across filename and
  title via the WordPress REST `?search=` parameter.
- WHEN `--unoptimized` is passed THE SYSTEM SHALL exclude any attachment whose WordPress ID
  appears in the local SQLite `processing_history` table with a non-failure, non-reverted
  status — this is a localpress-local concept, not something WordPress itself tracks. IF the
  site's database does not exist yet THEN THE SYSTEM SHALL treat every item as unoptimized
  rather than erroring.
- WHEN `--sort <field>` is `date`, `name`, or `id` THE SYSTEM SHALL pass sorting to the
  WordPress REST API's `orderby`/`order` parameters. WHEN `--sort size` is used THE SYSTEM
  SHALL instead fetch up to 20 pages (2,000 items) of the filtered collection and sort
  client-side, because WordPress's REST API has no server-side `orderby=size`; IF the
  filtered library exceeds that 20-page bound THEN THE SYSTEM SHALL emit a warning that the
  sort is only exhaustive across the fetched subset rather than silently returning a
  possibly-wrong "largest"/"smallest" result.
- WHEN `--limit <n>` is passed THE SYSTEM SHALL cap items-per-page at 100 regardless of the
  requested value.
- WHEN `--page <n>` is passed and exceeds the last valid page THE SYSTEM SHALL surface the
  resulting error to the user (plain/JSON mode); in interactive mode it instead falls back
  to page 1 once (see Requirement 3).
- WHEN `--json` is passed THE SYSTEM SHALL emit `{ items, total, totalPages, page }` instead
  of human-readable text, and the shape SHALL remain stable since the skill and MCP server
  both consume it.
- WHEN listing without `--json` and results exist THE SYSTEM SHALL print a "next page" hint
  command line when more pages remain.
- IF the initial fetch fails (e.g. auth/network error) THEN THE SYSTEM SHALL print the error
  and exit with code 4.

## Requirement 2: Show a single attachment's metadata and processing history

**User Story:** As a user or agent, I want to inspect one attachment in detail, so that I
can see its metadata, registered WordPress image sizes, and the most recent localpress
operation run against it before deciding what to do next.

**Acceptance Criteria:**
- WHEN `localpress show <id>` is run with a valid numeric ID THE SYSTEM SHALL fetch the
  attachment via the resolved `get` adapter and display title, filename, URL, MIME type,
  dimensions, size, alt text, upload date, and registered WordPress sizes (thumbnail,
  medium, large, etc. with their own dimensions/byte sizes where known).
- IF the ID is not a valid number THEN THE SYSTEM SHALL print an error and exit with code 2
  without making a network call.
- IF fetching the attachment fails (not found, auth, network) THEN THE SYSTEM SHALL print
  the error and exit with code 4.
- WHEN a local SQLite record of processing exists for the attachment THE SYSTEM SHALL show
  the most recent operation, its status, the before/after byte sizes with a computed
  percentage (reduction or growth), duration, and timestamp.
- IF no local processing record exists (including when the site database itself doesn't
  exist yet) THEN THE SYSTEM SHALL note "Not yet processed by localpress" rather than
  failing.
- WHEN `--json` is passed THE SYSTEM SHALL emit the full `MediaItem` object merged with a
  `lastProcessing` field (null if none).

## Requirement 3: Browse media interactively (TUI)

**User Story:** As a user, I want an interactive keyboard-driven browser for the media
library, so that I can visually scan items, multi-select them, and launch operations
(optimize, remove background, convert, resize, caption, edit, pull, preview) without typing
out a full command for each one.

**Acceptance Criteria:**
- WHEN `list -i` / `list --interactive` is run THE SYSTEM SHALL render an Ink TUI
  (`MediaBrowser`) showing a scrollable item list, a metadata sidebar (when the terminal is
  ≥110 columns wide), a page indicator, and a keybinding footer.
- WHEN no explicit `--page` is passed THE SYSTEM SHALL restore the last-used page and cursor
  position from the site's SQLite `preferences` table (keys `browser.page` /
  `browser.cursor`); IF no saved position exists THEN THE SYSTEM SHALL start at page 1,
  cursor 0.
- WHEN the browser exits (quit, or dispatching an action) THE SYSTEM SHALL persist the
  current page and cursor back to SQLite as a best-effort operation — a persistence failure
  SHALL NOT crash the CLI.
- IF a restored/requested page turns out to be out of range (library shrank, filters
  changed) THEN THE SYSTEM SHALL retry once against page 1, reset the cursor to 0, and
  persist that reset position; a failure on page 1 itself SHALL propagate as a real error.
- WHEN `--unoptimized` is combined with `-i` THE SYSTEM SHALL load the set of processed
  WordPress IDs from SQLite once at startup and re-load it after any processing action
  completes, so newly-processed items disappear from the unoptimized view without a full
  restart.
- WHEN the user presses `j`/`k`/arrow keys THE SYSTEM SHALL move the cursor; `n`/`b` (or
  left/right arrows) SHALL change page; `/` SHALL open a client-side search box that filters
  the current page's items by filename/title substring without an extra network call.
- WHEN the user presses `space` THE SYSTEM SHALL toggle multi-select on the current item and
  advance the cursor; `Ctrl+A` SHALL select all items on the current page; `Ctrl+D` SHALL
  clear selection.
- WHEN one or more items are selected and the user presses an action key (`o` optimize, `r`
  remove-bg, `c` convert) THE SYSTEM SHALL dispatch a bulk variant (`bulk-optimize`,
  `bulk-remove-bg`, `bulk-convert`) covering every selected ID instead of just the cursor
  item.
- WHEN the user presses `o` with no selection THE SYSTEM SHALL open an inline settings
  overlay for profile / quality / target format / keep-original before dispatching a
  single-item optimize; `O` SHALL skip the overlay and dispatch directly into browser
  preview mode.
- WHEN the user presses `r`/`R` on an image THE SYSTEM SHALL dispatch remove-bg
  (`R` = browser preview mode); `c` SHALL open a two-step convert overlay (format, then
  quality); `s` SHALL open a resize overlay requiring at least one of width/height; `a` SHALL
  dispatch caption; `e` SHALL dispatch edit (round-trip); `d` SHALL dispatch a pull/download
  (bulk-pull if items are selected); `W` SHALL open the item in the WordPress admin editor
  in the system browser; `Enter` SHALL show an inline metadata details overlay (re-fetching
  the full item first); `p` SHALL show an inline image preview (only on terminals that
  support inline image escape sequences — iTerm2, WezTerm, Warp, Kitty); `P` SHALL open the
  image in the system web browser via a local preview server; `q`/`Esc` SHALL clear an
  active search/selection first, then quit on a second press.
- WHEN a dispatched action requires leaving the TUI THE SYSTEM SHALL spawn the corresponding
  CLI subcommand as a child process with `stdio: 'inherit'`, wait for a keypress, then
  re-render the browser at the saved page/cursor.
- WHEN a dispatched action is a processing type (`optimize`, `resize`, `convert`,
  `remove-bg`, `caption`, or their bulk variants) THE SYSTEM SHALL re-fetch the affected
  item individually on the next render (bypassing any WordPress REST cache staleness) and
  reload the processed-IDs set.

## Requirement 4: Cumulative stats dashboard

**User Story:** As a user, I want a local, network-free dashboard of processing history and
library health, so that I can see cumulative savings and what's left to do without hitting
the WordPress API.

**Acceptance Criteria:**
- WHEN `localpress stats` is run THE SYSTEM SHALL read exclusively from the local SQLite
  database (no WordPress API calls) and report: library overview (total attachments, total
  size, optimized count/percentage, unoptimized count), cumulative savings (bytes saved,
  average compression percentage, succeeded/failed/skipped operation counts, last-run date),
  format breakdown by MIME type, operation breakdown (per-operation counts, bytes saved,
  average duration), the 10 most recent operations grouped by date, and time-machine/undo
  storage stats (snapshot count, session count, storage used vs. the configured cap, oldest
  snapshot date).
- IF the site has no SQLite database yet THEN THE SYSTEM SHALL report "no stats database"
  for that site (as a JSON `error` field, or as a printed error in text mode) rather than
  crashing.
- WHEN `--all-sites` is passed THE SYSTEM SHALL loop over every configured site and report
  each independently, skipping (with a per-site error) any site whose database can't be
  opened.
- WHEN history/undo is disabled via config THE SYSTEM SHALL report that plainly instead of
  showing zeroed-out snapshot numbers.
- WHEN `--json` is passed with a single site THE SYSTEM SHALL emit a single result object;
  WHEN combined with `--all-sites` THE SYSTEM SHALL emit an array, one entry per site.
- WHEN computing "optimized" counts THE SYSTEM SHALL exclude processing-history rows marked
  `reverted_at` (undone) and rows with `status = 'failure'`, so stats reflect the library's
  actual current state, not raw historical row counts.

## Requirement 5: Audit the library for optimization and integrity issues

**User Story:** As a user or agent, I want a single command that surfaces everything wrong
or improvable in the media library, so that I know what to fix before running bulk
processing commands.

**Acceptance Criteria:**
- WHEN `localpress audit` is run with no check flags THE SYSTEM SHALL run every "cheap"
  REST-based check by default: `--unoptimized`, `--large`, `--missing-alt`, and
  `--display-size`. IF any specific check flag is passed THEN THE SYSTEM SHALL run only the
  requested checks instead of the default set.
- WHEN `--unoptimized` runs (default or explicit) THE SYSTEM SHALL flag attachments with no
  successful, non-reverted `processing_history` row in SQLite.
- WHEN `--large` runs THE SYSTEM SHALL flag images at or above `--threshold` bytes (default
  1,048,576 / 1 MB).
- WHEN `--missing-alt` runs THE SYSTEM SHALL flag images with empty or missing alt text.
- WHEN `--display-size` runs THE SYSTEM SHALL compare each image's source pixel dimensions
  against its largest *registered* WordPress size (excluding the synthetic `full` entry) and
  flag it if the source has at least 2.0× the pixel area of that largest registered size,
  reporting the oversize ratio and the offending size's name/dimensions.
- WHEN `--duplicates` is passed THE SYSTEM SHALL download every image attachment, compute a
  9×8 grayscale difference hash (dHash) via sharp, and flag groups of attachments whose
  hashes differ by a Hamming distance of 5 or less as perceptual duplicates. IF sharp is not
  available THEN THE SYSTEM SHALL warn and skip duplicate detection rather than failing the
  whole audit. This check SHALL NOT run as part of the no-flags default set (it downloads
  every image).
- WHEN `--broken-refs` is passed THE SYSTEM SHALL, for every attachment that has at least
  one reference in post content (via a fast reference scan), issue a `HEAD` request to its
  URL and flag it if the response is 404, 410, or otherwise unreachable — reporting which
  post IDs reference it. An attachment with zero references is NOT considered a broken
  reference (that's what `--unattached` is for).
- WHEN `--orphans` is passed THE SYSTEM SHALL require WP-CLI (via the `prune-orphans`
  capability); IF WP-CLI is not configured for the site THEN THE SYSTEM SHALL error and exit
  with code 6 rather than silently skipping. WHEN it runs successfully THE SYSTEM SHALL
  report uploads-directory files with no matching database attachment ("orphan") and
  attachments in the database whose file is missing from disk ("missing-file"), including
  reclaimable byte estimate.
- WHEN `--unattached` is passed THE SYSTEM SHALL require WP-CLI (`find-unattached`
  capability) and error with exit code 6 if unavailable; when it runs it SHALL flag
  attachments with no parent post and zero references anywhere in content.
- WHEN `--quality` is passed THE SYSTEM SHALL run a local Ollama vision pass (the site's
  configured `captionModel`, default `moondream`) over every image asking whether it's
  blurry/low-contrast/poorly composed, flagging strict "YES" answers with the model's stated
  reason. IF Ollama is not running THEN THE SYSTEM SHALL warn and skip this check rather
  than failing the audit. This check is never part of the no-flags default (opt-in only,
  ~10s/image).
- WHEN `--ocr-text <term>` is passed THE SYSTEM SHALL run the same Ollama vision pipeline
  asking whether the given text visually appears in each image, flagging matches. Same
  Ollama-unavailable and opt-in behavior as `--quality`.
- WHEN a full media fetch completes THE SYSTEM SHALL upsert every observed attachment into
  the local SQLite `attachments` cache and prune any previously-cached row not observed in
  this scan, so `stats`' library overview doesn't keep counting attachments that no longer
  exist remotely; a sync failure SHALL be a warning, not a fatal error.
- WHEN `--json` is passed THE SYSTEM SHALL emit `{ site, totalItems, prunedAttachments,
  findings, summary }` where `summary` is a per-check-type count; the shape SHALL remain
  stable as a public API for the skill/MCP.
- WHEN printing human-readable output THE SYSTEM SHALL group findings by type, show up to 10
  examples per group with a "... and N more" tail, and suggest a concrete next command
  (`optimize --unoptimized --apply`, and `resize --max-width 1920 --apply` when
  `--display-size` found anything) when findings exist.

## Requirement 6: Find and rewrite attachment references

**User Story:** As a user or agent, I want to know everywhere an attachment is used before
deleting or replacing it, and to be able to redirect all of those uses to a different
attachment ID, so that replacing media doesn't leave broken links.

**Acceptance Criteria:**
- WHEN `localpress references <id>` runs with `--scope fast` (the default) THE SYSTEM SHALL
  look up featured-image (`_thumbnail_id`) references and Gutenberg block ID references
  using whichever adapter (REST or WP-CLI) declares the `fast-references` capability, and
  SHALL print a warning that this is a partial scan and `--scope full` exists for a complete
  one.
- WHEN `--scope full` is passed THE SYSTEM SHALL additionally scan inline content URLs,
  srcset occurrences, and postmeta references; this scope requires WP-CLI over SSH
  (`full-references` capability). IF WP-CLI is not configured THEN THE SYSTEM SHALL error
  and exit with code 6.
- WHEN Gutenberg block IDs are matched THE SYSTEM SHALL anchor the match on ID boundaries
  (e.g. searching for id 123 SHALL NOT match id 1234 or 9123) — both the REST fast scan and
  the WP-CLI scan enforce this.
- WHEN reference scans (fast or full) run against WP-CLI or REST content queries THE SYSTEM
  SHALL scope to published posts/pages only, matching WordPress REST's default
  `status=publish` filtering for parity between the two scopes.
- IF the given attachment ID is not a valid number THEN THE SYSTEM SHALL error and exit with
  code 2 before making any request.
- WHEN `--json` is passed THE SYSTEM SHALL emit `{ attachmentId, scope, references }`.
- WHEN `--update-to <newId>` is passed THE SYSTEM SHALL require WP-CLI over SSH for the site
  and error with exit code 6 if unavailable; it SHALL rewrite, in order: (1) `_thumbnail_id`
  postmeta rows pointing at the old ID, (2) the old attachment's full URL to the new
  attachment's full URL across all tables via `wp search-replace --precise` (to keep
  serialized PHP data valid), and (3) Gutenberg block `"id":<old>` occurrences in
  `post_content` via an ID-boundary-anchored regex search-replace.
- WHEN `--update-to` runs and the global dry-run resolves to true (via the shared
  `resolveDryRun` helper — the default when neither `--dry-run` nor `--apply` is passed) THE
  SYSTEM SHALL NOT execute any of the three rewrite steps for real: the `_thumbnail_id` step
  SHALL instead run a `COUNT(*)` query and report how many rows *would* change (since that
  raw `UPDATE` statement has no native dry-run mode), and the other two steps SHALL be
  invoked with WP-CLI's own `--dry-run` flag.
- IF any of the three rewrite steps fails over SSH THEN THE SYSTEM SHALL throw immediately
  (this flow is not transactional) and report which earlier steps had already been applied,
  so the user knows the rewrite is now partial rather than assuming nothing happened.
- WHEN `--update-to` completes (dry-run or real) THE SYSTEM SHALL optionally emit
  `{ action: 'update-references', fromId, toId, dryRun }` when `--json` is passed.
