# Media Discovery & Audit — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core engine / state layer

- [x] Define `attachments` and `processing_history` tables in the initial SQLite schema,
  keyed `(site_name, wp_id)`, to back the "has this attachment been processed?" question
  used throughout `list --unoptimized`, `audit`, and `stats` (Requirements 1, 4, 5) —
  `src/engine/state/schema.ts`
- [x] Add `preferences` key-value table (schema migration v2) to persist interactive-browser
  position across sessions (Requirement 3) — `src/engine/state/schema.ts`
- [x] Add `reverted_at` column to `processing_history` (schema migration v5) so `undo`
  can exclude reverted rows from "optimized" counts and idempotency checks everywhere in
  this area (Requirements 1, 4, 5) — `src/engine/state/schema.ts`
- [x] Implement `SiteDb.listProcessedWpIds` (status/reverted-aware) as the single source of
  truth for "unoptimized" filtering (Requirements 1, 5) — `src/engine/state/db.ts`
- [x] Implement `SiteDb.upsertAttachment` / `pruneStaleAttachments` so a full-library scan
  (audit) keeps the local attachment cache in sync with what's actually on WordPress
  (Requirement 5) — `src/engine/state/db.ts`
- [x] Implement `SiteDb.getLastProcessing` for per-attachment history lookups (Requirement 2)
  — `src/engine/state/db.ts`
- [x] Implement `SiteDb.getPref` / `setPref` for TUI browser-position persistence
  (Requirement 3) — `src/engine/state/db.ts`
- [x] Implement the `stats`-only aggregate queries: `getStats`, `getLibraryOverview`,
  `getFormatBreakdown`, `getRecentOperations` — all excluding failed and reverted rows from
  their success-path sums (Requirement 4) — `src/engine/state/db.ts`
- [x] Wire `stats` into the time-machine/undo snapshot store (`openSnapshotStore`,
  `resolveHistoryConfig`) so the dashboard also reports undo storage usage (Requirement 4)
  — `src/engine/history/index.ts`, `src/cli/commands/stats.ts`

## Adapter layer

- [x] Implement `RestAdapter.listMediaPage` / `listMedia` with WordPress REST pagination
  headers (`X-WP-Total`, `X-WP-TotalPages`) and common filter mapping (`type`, `postId`,
  `since`, `search`) (Requirement 1) — `src/adapters/rest.ts`
- [x] Implement client-side global size-sort in `RestAdapter` (bounded fetch of up to
  `MAX_SIZE_SORT_PAGES` pages, with a truncation warning) since WordPress REST has no
  `orderby=size` (Requirement 1) — `src/adapters/rest.ts`
- [x] Implement exact-MIME-type vs. bare-category filtering (`mime_type` vs `media_type`)
  in `RestAdapter` (Requirement 1) — `src/adapters/rest.ts`
- [x] Implement `RestAdapter.findReferences('fast')` (featured image + Gutenberg block scan)
  (Requirement 6) — `src/adapters/rest.ts`
- [x] Implement `WpCliAdapter.findReferences('full')` (adds content-URL, srcset, and
  postmeta scanning on top of the fast-scan pieces) and `matchesBlockId` as an ID-boundary-
  safe post-filter over the cheap SQL `LIKE` pre-filter (Requirement 6) —
  `src/adapters/wp-cli.ts`
- [x] Implement `WpCliAdapter.findUnattached` and `pruneOrphans` for the WP-CLI-only audit
  checks (Requirement 5) — `src/adapters/wp-cli.ts`
- [x] Declare capability sets (`fast-references`, `full-references`, `find-unattached`,
  `prune-orphans`, `list`, `get`) per adapter and encode REST-preferred-for-read-heavy-ops
  priority in `AdapterResolver` (`REST_PREFERRED`) (Requirements 1, 5, 6) —
  `src/adapters/types.ts`, `src/adapters/resolver.ts`

## CLI command wiring

- [x] `list`: filter-flag parsing (`--unoptimized`, `--type`, `--post`, `--since`,
  `--larger-than`, `--search`, `--limit`, `--page`, `--sort`, `--order`), plain-text and
  `--json` output, "next page" hint (Requirement 1) — `src/cli/commands/list.ts`
- [x] `list`: `fetchPageWithFallback` helper (retry stale persisted page once against page 1,
  rethrow real errors) (Requirement 1, 3) — `src/cli/commands/list.ts`
- [x] `list -i`: interactive-mode orchestration loop — load/save browser position via
  SQLite `preferences`, render `MediaBrowser`, dispatch actions, spawn subcommands, re-fetch
  processed items after processing actions (Requirement 3) — `src/cli/commands/list.ts`
- [x] `list -i`: browser-preview action handled inline (fetch bytes, hand off to
  `engine/preview/quick-view.ts`) without spawning a subprocess (Requirement 3) —
  `src/cli/commands/list.ts`
- [x] `show <id>`: fetch + format metadata, registered sizes, and last-processing summary;
  `--json` merges `lastProcessing` into the media item (Requirement 2) —
  `src/cli/commands/show.ts`
- [x] `stats`: single-site and `--all-sites` reporting, SQLite-only (no network), graceful
  per-site "no database" handling, disabled-history messaging (Requirement 4) —
  `src/cli/commands/stats.ts`
- [x] `audit`: flag parsing and `runAll` default-set logic (cheap checks only;
  `--duplicates`/`--quality`/`--ocr-text` always opt-in) (Requirement 5) —
  `src/cli/commands/audit.ts`
- [x] `audit`: `fetchAllMedia` full-library fetch driven by `X-WP-TotalPages` (fixes the
  exact-page-size-multiple 400 bug) (Requirement 5) — `src/cli/commands/audit.ts`
- [x] `audit`: attachment-cache sync (`upsertAttachment` + `pruneStaleAttachments`) after
  every full fetch, warning (not failing) on sync errors (Requirement 5) —
  `src/cli/commands/audit.ts`
- [x] `audit --unoptimized/--large/--missing-alt/--display-size`: synchronous per-item checks
  against already-fetched `MediaItem` data (Requirement 5) — `src/cli/commands/audit.ts`
- [x] `audit --duplicates`: dHash-based perceptual duplicate detection via lazy-loaded
  `sharp`, with graceful skip-and-warn if `sharp` isn't installed (Requirement 5) —
  `src/cli/commands/audit.ts`
- [x] `audit --broken-refs`: concurrent (batched, concurrency 10) reference-then-HEAD-check
  scan distinguishing "referenced but broken" from "unattached" (Requirement 5) —
  `src/cli/commands/audit.ts`
- [x] `audit --orphans/--unattached`: WP-CLI capability gating with exit code 6 on
  unavailability (Requirement 5) — `src/cli/commands/audit.ts`
- [x] `audit --quality/--ocr-text`: Ollama vision checks via `engine/caption/ollama.ts`,
  graceful skip-and-warn when Ollama isn't running (Requirement 5) —
  `src/cli/commands/audit.ts`
- [x] `audit`: grouped human-readable output (top-10-per-group + "and N more") and stable
  `--json` shape (`findings` + `summary`) (Requirement 5) — `src/cli/commands/audit.ts`
- [x] `references <id>`: fast/full scope dispatch via `resolver.tryResolve`, capability-
  missing error with exit code 6 for `--scope full` (Requirement 6) —
  `src/cli/commands/references.ts`
- [x] `references --update-to`: three-step SSH rewrite (featured image, URL
  search-replace, block-ID regex search-replace), wired through the shared `resolveDryRun`
  helper, with per-step dry-run behavior (COUNT query for the raw UPDATE step; native
  `--dry-run` for the two `wp search-replace` steps) and partial-failure reporting
  (Requirement 6) — `src/cli/commands/references.ts`, `src/cli/utils/run-mode.ts`

## Interactive TUI

- [x] `MediaBrowser` component: list/sidebar/header/footer layout, responsive to terminal
  width (sidebar hidden below 110 cols) (Requirement 3) —
  `src/cli/components/MediaBrowser.tsx`
- [x] Cursor/page navigation (`jk`, arrows, `n`/`b`), client-side `/` search filter over the
  current page (Requirement 3) — `src/cli/components/MediaBrowser.tsx`
- [x] Multi-select (`space`, `Ctrl+A`, `Ctrl+D`) and bulk action dispatch
  (`bulk-optimize`/`bulk-remove-bg`/`bulk-convert`/`bulk-pull`) (Requirement 3) —
  `src/cli/components/MediaBrowser.tsx`
- [x] Per-item action keys: optimize (`o`/`O` overlay), remove-bg (`r`/`R`), convert (`c`,
  two-step overlay), resize (`s`, overlay), caption (`a`), edit (`e`), pull (`d`), open in
  WordPress admin (`W`), inline details (`Enter`), inline image preview (`p`, terminal-
  capability gated), browser preview (`P`) (Requirement 3) —
  `src/cli/components/MediaBrowser.tsx`
- [x] `buildDispatchArgs`: pure translation from `MediaBrowserAction` to CLI subcommand +
  argv, kept separate from the Ink component so it's independently testable
  (Requirement 3) — `src/cli/utils/dispatch.ts`
- [x] Terminal-capability detection (`supportsInlineImages`) and iTerm2 inline-image escape
  sequence construction for the preview overlay (Requirement 3) —
  `src/cli/components/MediaBrowser.tsx`

## MCP tool wiring

- [x] Expose `references` (with `updateTo` rewrite parameter) as an MCP tool that
  invokes the CLI's `references` argv (Requirement 6) — `src/cli/mcp/tools.ts`
- [x] (Not independently verified in this pass which MCP tool names cover `list`/`show`/
  `stats`/`audit` — the MCP surface for this area should be spot-checked against
  `src/cli/mcp/tools.ts` and `src/cli/mcp/invoke.ts` by whoever next touches MCP tool
  definitions, since this doc's source review did not exhaustively enumerate every tool
  name.)

## Tests

- [x] `fetchPageWithFallback` unit coverage: success, stale-page fallback, page-1-failure
  rethrow, error-message preservation (Requirement 1, 3) —
  `test/unit/list-page-retry.test.ts`
- [x] `RestAdapter.listMediaPage`/`listMedia` unit coverage against a fake in-process WP REST
  server: global size sort (asc/desc), bounded-fetch truncation warning, exact-MIME vs.
  bare-category filtering (Requirement 1) — `test/unit/rest-adapter-list.test.ts`
- [x] `fetchAllMedia` pagination unit coverage (exact multiple, non-multiple, empty library)
  and `find-unattached` capability-wiring coverage (REST throws, resolver returns null,
  capability appears in `capabilityReport()`) (Requirement 5) — `test/unit/audit.test.ts`
- [x] `SiteDb` aggregate-query unit coverage for `getLibraryOverview`, `getStats`,
  `getFormatBreakdown`, `getRecentOperations` (Requirement 4) — `test/unit/stats.test.ts`
- [x] `matchesBlockId` unit coverage (exact match, prefix/suffix false-positive avoidance,
  multi-block-type matching, no-match case) (Requirement 6) —
  `test/unit/wp-cli-references.test.ts`

## Known gaps (verified absent, flagged for whoever picks this up next)

- [x] Verified (via repository search — `test/**/*dispatch*` and `test/**/*browser*` both
  return no files) that no `test/unit/` file targets `show.ts`, the `references`
  scan/`--update-to` command flow, `MediaBrowser.tsx`, or `dispatch.ts` directly by name.
  This is recorded here as a documented gap, not a completed test suite: if coverage for
  these paths exists at all, it would have to come from `test/integration/wp-rest.test.ts`
  or the tarball smoke tests, not from unit tests. Closing this gap (adding real unit tests
  for these four files) is left as future work, not something this backfill did.
