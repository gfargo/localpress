# Media Discovery & Audit — Design

## Architecture

This subsystem is a thin CLI-command layer over the engine/adapter split described in
CLAUDE.md's locked architectural decisions. It does not introduce new architecture — it's
the clearest illustration of the existing three-layer flow:

```
CLI command layer            src/cli/commands/{list,show,stats,audit,references}.ts
      │                      src/cli/components/MediaBrowser.tsx (Ink TUI, list -i only)
      ▼
Capability resolution        src/adapters/resolver.ts (AdapterResolver.resolve/tryResolve)
      │
Adapter layer                src/adapters/rest.ts (RestAdapter)  |  src/adapters/wp-cli.ts (WpCliAdapter)
      │
Remote WordPress             REST API (Application Password auth)  |  wp-cli over SSH
```

In parallel, `list --unoptimized`, `stats`, and `audit` all read/write a local SQLite
per-site database (`src/engine/state/db.ts`, `SiteDb`) that is **not** part of the
adapter/resolver chain — it's a separate, always-local source of truth for
localpress-specific concepts (has this attachment been processed? what's the saved browser
cursor position?) that WordPress itself has no notion of. `stats` in particular makes zero
network calls; it is purely a SQLite read plus a call into
`src/engine/history/index.ts` (`openSnapshotStore`, `resolveHistoryConfig`) for the
time-machine/undo storage numbers.

Two of the five commands are otherwise almost entirely adapter pass-throughs: `list` and
`show` mostly translate CLI flags into `ListFilters`/`getMedia()` calls and format the
result. `audit` and `references` are heavier — `audit` layers several independent
REST-download-and-analyze passes (dHash duplicate detection, broken-link HEAD checks, Ollama
vision checks) on top of a full-library fetch; `references --update-to` is the one command
in this area that mutates WordPress state, and it does so entirely through raw `wp db
query`/`wp search-replace` calls over SSH rather than through the `WpBackend` interface's
typed mutation methods (there is no `WpBackend.updateReferences()` — this is a bespoke
SSH-command sequence local to `references.ts`).

## Key files/modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/list.ts` | `list` command: filter parsing, plain/JSON output, and the entire interactive-TUI orchestration loop (spawns `MediaBrowser`, persists browser position, dispatches subcommands as child processes). Exports `fetchPageWithFallback` (tested directly). |
| `src/cli/commands/show.ts` | `show <id>`: single-attachment fetch + SQLite `getLastProcessing` lookup, formatted output. |
| `src/cli/commands/stats.ts` | `stats`: pure-SQLite dashboard; loops over one or all sites; assembles `SiteStats` + `LibraryOverview` + `FormatCount[]` + `RecentOperation[]` + history-store stats into one printed/JSON report. |
| `src/cli/commands/audit.ts` | `audit`: orchestrates up to ten independent checks (`--unoptimized`, `--large`, `--missing-alt`, `--display-size`, `--duplicates`, `--broken-refs`, `--orphans`, `--unattached`, `--quality`, `--ocr-text`); owns `fetchAllMedia` (page-driven-by-`totalPages` full fetch, tested directly), the dHash duplicate detector, the broken-reference HEAD-check scanner, and the two Ollama-vision checks. |
| `src/cli/commands/references.ts` | `references <id>`: fast/full reference scan dispatch, and the `--update-to` raw-SQL/wp-search-replace rewrite flow (the one mutating path in this area). |
| `src/cli/components/MediaBrowser.tsx` | Ink TUI component for `list -i`. Owns all interactive state (cursor, page, search, multi-select, five modal overlays for optimize/convert/resize/details/preview) and emits a single `MediaBrowserAction` discriminated union back to `list.ts` via `onAction`. Does not itself talk to adapters or SQLite except through the `onPageChange`/`onFetchItem` callbacks it's given. |
| `src/cli/utils/dispatch.ts` | Pure function `buildDispatchArgs(action)` translating a `MediaBrowserAction` into a CLI subcommand name + argv, so `list.ts` can `spawnSync` the real command instead of re-implementing each operation inline. |
| `src/adapters/resolver.ts` | `AdapterResolver`: picks WP-CLI vs REST per capability. REST is explicitly preferred for `list`/`get`/`fast-references` even when WP-CLI is available (`REST_PREFERRED` set) because WP-CLI-over-SSH has per-item round-trip cost that makes read-heavy operations slow; WP-CLI is preferred for everything else it supports (`replace-in-place`, `full-references`, `prune-orphans`, `find-unattached`). |
| `src/adapters/rest.ts` | `RestAdapter.listMediaPage`/`listMedia`: talks to `wp-json/wp/v2/media`. Implements client-side size-sort by fetching up to `MAX_SIZE_SORT_PAGES` (20) pages, since the REST API has no `orderby=size`; implements exact-vs-category MIME filtering (`mime_type` for an exact type, `media_type` for a bare category like `image`). |
| `src/adapters/wp-cli.ts` | `WpCliAdapter.findReferences`/`findUnattached`/`pruneOrphans`: shells `wp db query`/`wp post get`/etc. over SSH. Exports `matchesBlockId` (ID-boundary-safe Gutenberg block matcher, tested directly) used to post-filter a cheap SQL `LIKE` pre-filter. |
| `src/engine/state/db.ts` | `SiteDb`: `bun:sqlite` wrapper. Relevant surface for this area: `upsertAttachment`/`pruneStaleAttachments` (the audit-driven cache sync), `listProcessedWpIds` (drives `--unoptimized` everywhere), `getPref`/`setPref` (TUI position persistence), `getLastProcessing` (`show`), and the `stats`-only aggregate queries `getStats`, `getLibraryOverview`, `getFormatBreakdown`, `getRecentOperations`. |
| `src/engine/state/schema.ts` | SQL DDL + migrations. Relevant tables: `attachments` (last-seen cache, keyed `site_name, wp_id`), `processing_history` (one row per processing attempt; `status` success/failure/skipped, `reverted_at` set by `undo`), `preferences` (key-value, used for `browser.page`/`browser.cursor`). |

## Data flow

**`list` (plain/JSON mode):** CLI flags → `ListFilters` → `resolver.resolve('list')` (always
REST per `REST_PREFERRED`) → `adapter.listMediaPage(filters)` → optional client-side
`--larger-than` filter → optional SQLite `listProcessedWpIds` filter for `--unoptimized` →
print or `printJson`.

**`list -i` (interactive):** Same filter resolution, then an outer `while (true)` loop in
`list.ts`: fetch the current page (via `fetchPageWithFallback`, retrying page 1 once on a
stale-page error) → render `MediaBrowser` and block on `waitUntilExit()` → inspect the
`MediaBrowserAction` the browser produced via `onAction` → either loop with a new page/cursor
(`quit`), handle `browser-preview` inline (fetch bytes, open the local preview server), or
translate the action via `buildDispatchArgs` and `spawnSync` the real subcommand as a child
process with inherited stdio → wait for a keypress → reload processed-IDs from SQLite if the
action was a processing type → loop. Browser position (page + cursor) is read from and
written back to the `preferences` table via `getPref`/`setPref` at both entry and every exit
point, on a best-effort basis (failures are swallowed — a persistence miss must never crash
the CLI).

**`show <id>`:** `resolver.resolve('get')` → `adapter.getMedia(id)` → best-effort
`SiteDb.getLastProcessing(site, id)` (swallowed if the DB doesn't exist) → merge and print.

**`stats`:** No adapter/resolver involvement at all. For each target site: `SiteDb.init` →
`getStats` + `getLibraryOverview` + `getFormatBreakdown` + `getRecentOperations` +
`openSnapshotStore(db, configDir).getStats(site)` → assemble and print/emit JSON.

**`audit`:** Optional early WP-CLI capability check for `--orphans`/`--unattached` (fail fast
with exit 6 before doing any REST work if requested but unavailable) → `fetchAllMedia`
(paged full fetch, driven by `X-WP-TotalPages` rather than "did the last page come back
short", to avoid over-fetching past the last page which WordPress 400s on) → sync every
observed item into the SQLite `attachments` cache and `pruneStaleAttachments` for anything no
longer seen → run each requested check against the in-memory item list (cheap synchronous
checks first: unoptimized/large/missing-alt/display-size; then the opt-in expensive ones:
duplicates fetches every image and computes dHash via lazy-loaded `sharp`; broken-refs issues
concurrent — batches of 10 — `HEAD` requests per referenced item; quality/ocr-text call
`engine/caption/ollama.ts` per image sequentially) → assemble `AuditFinding[]` → group and
print, or `printJson`.

**`references <id>` (scan):** `resolver.tryResolve('fast-references' | 'full-references')` →
`adapter.findReferences(id, scope)` → print or `printJson`. REST implements only
`fast-references`; WP-CLI implements both.

**`references --update-to`:** Bypasses the resolver/adapter interface entirely for the
mutation itself — requires `site.ssh` directly, then runs three sequential `sshExec` calls
(featured-image postmeta update or dry-run `COUNT`, URL `wp search-replace --precise`, and a
regex-anchored block-ID `wp search-replace` scoped to `post_content`), tracking which steps
already completed so a mid-sequence SSH failure can report exactly how far the rewrite got.

## Key design decisions

- **SQLite as source of truth for "processed" state** (CLAUDE.md: *State management — SQLite
  (source of truth), schema v4*; the schema module documents itself as **v5** — see
  discrepancy note below). WordPress has no concept of "optimized by localpress"; every
  `--unoptimized` filter in `list`/`audit`, and every "optimized" count in `stats`, comes
  from `processing_history` rows keyed by `(site_name, wp_id)`, excluding `status='failure'`
  and `reverted_at IS NOT NULL` rows so an `undo` correctly makes an attachment eligible
  again.
- **Capability resolution via `resolver.tryResolve()`, never a direct adapter call** — every
  WP-CLI-only feature in this area (`--orphans`, `--unattached`, `--scope full`,
  `--update-to`) calls `resolver.tryResolve(capability)` and handles a `null` result with an
  explicit error + exit code 6, per the CLAUDE.md convention. `references` (fast scan) and
  `list`/`show`/`audit`'s base fetch use `resolver.resolve()` (throwing) because those
  capabilities are always available on at least REST.
- **REST preferred over WP-CLI for read-heavy operations** (`AdapterResolver.REST_PREFERRED`
  includes `list`, `get`, `fast-references`) even on sites with WP-CLI/SSH configured — a
  single HTTP request beats WP-CLI's per-item SSH round-trip for anything that touches many
  items, which is exactly what discovery/audit commands do.
- **Audit's default set is the "cheap" subset only.** `--duplicates` (downloads every image),
  `--quality`/`--ocr-text` (Ollama, ~10s/image), and the WP-CLI-only checks are all opt-in —
  `runAll` (no flags passed) only covers `--unoptimized`/`--large`/`--missing-alt`/
  `--display-size`, all of which are answerable from data already on the `MediaItem` the list
  fetch returned.
- **`--unattached` vs `--broken-refs` are deliberately different questions.** An attachment
  with zero references anywhere is "unattached" (orphaned from content, not necessarily
  broken); an attachment that *is* referenced but whose URL 404s is "broken-ref". Conflating
  them would make `--broken-refs` fire on every unattached upload.
- **Dry-run for `references --update-to` goes through the shared `resolveDryRun` helper**
  (`src/cli/utils/run-mode.ts`), consistent with the CLAUDE.md convention for destructive
  commands. Because the featured-image rewrite step is a raw `UPDATE` with no native
  WP-CLI dry-run mode, dry-run mode substitutes a `COUNT(*)` query for that one step
  specifically rather than skipping it silently.
- **The reference rewrite is explicitly non-transactional and says so.** Three separate SSH
  commands run in sequence; a failure partway through throws with a message listing which
  steps already committed, rather than pretending an atomic rollback happened that SSH/WP-CLI
  has no mechanism to provide.
- **Duplicate detection uses a hand-rolled dHash, not a library.** `detectDuplicates` in
  `audit.ts` resizes each image to 9×8 grayscale via lazy-loaded `sharp`, builds a 64-bit
  difference hash by comparing adjacent pixel luminance, and groups attachments whose hashes
  differ by Hamming distance ≤ 5. `sharp` is dynamically imported (per the CLAUDE.md
  lazy-loading convention) so a missing native binary degrades to a warning-and-skip instead
  of crashing the whole audit.
- **`fetchAllMedia` (used by `audit`) paginates off `X-WP-TotalPages`, not a
  short-page heuristic** — a library whose size is an exact multiple of the page size would
  otherwise trigger one request past the last page, which WordPress's REST API rejects with a
  400. This was a real bug fixed by pinning to the header instead (see `test/unit/audit.test.ts`).
- **The interactive TUI never talks to adapters/SQLite directly** — `MediaBrowser.tsx` is
  handed `onPageChange`/`onFetchItem`/`onOpenInBrowser` callbacks and an `onAction` emitter by
  `list.ts`; all capability resolution, SQLite reads/writes, and subprocess spawning live in
  `list.ts`. This keeps the Ink component pure UI state + one discriminated-union action type
  (`MediaBrowserAction`), and `buildDispatchArgs` (a separately-tested pure function) is the
  only place that knows how an action maps to a real CLI invocation.
- **Interactive actions shell out to the real subcommands rather than reimplementing them** —
  `optimize`/`convert`/`resize`/`remove-bg`/`caption`/`edit`/`pull` triggered from the TUI are
  literally `spawnSync(selfBin, [subCmd, ...targetIds, ...extraArgs])`. This guarantees the
  TUI can never drift from the "real" command's dry-run/safety/history behavior, at the cost
  of a subprocess per action.

### Noted discrepancy

CLAUDE.md's "State management" section and its "Locked architectural decisions" table both
say the schema is at **v4**. The actual code (`src/engine/state/schema.ts`,
`SCHEMA_VERSION = 5`) has a fifth migration adding `processing_history.reverted_at` (used
throughout this subsystem's "optimized"/"unoptimized" logic to exclude undone rows). This
looks like CLAUDE.md simply wasn't updated after that migration shipped — the code, not the
doc, is authoritative for the `reverted_at` behavior described above.

## Error handling / edge cases

- Invalid numeric ID arguments (`show`, `references`) are rejected before any network call,
  exit code 2.
- Adapter fetch failures in `list`/`show`/`audit` are caught, printed via `error()`, and exit
  with code 4.
- Missing WP-CLI capability for a feature that requires it (`--orphans`, `--unattached`,
  `--scope full`, `--update-to`) exits with code 6 and a message naming the missing
  requirement, rather than a generic capability-resolution exception leaking through.
  `--duplicates` and Ollama checks (`--quality`/`--ocr-text`) treat their own
  missing-dependency case (no `sharp`, no Ollama running) as a **warning + skip**, not a hard
  failure, so the rest of the audit still completes.
- A stale/out-of-range page persisted from a previous interactive session is recovered from
  automatically (fallback to page 1) rather than surfacing an error to the user, since it's an
  expected consequence of the library changing between sessions, not a real error condition —
  but a failure that reproduces on page 1 itself is treated as real (auth/network) and
  propagates.
- SQLite reads used for enrichment only (processed-IDs for `--unoptimized`, last-processing
  for `show`, browser position for the TUI) are all wrapped in `try/catch` with a safe
  fallback (empty set / null / defaults) — a missing or locked database must never block a
  primarily-REST command from working.
- The `references --update-to` rewrite explicitly does not attempt to undo partial progress
  on failure; it surfaces which steps completed so the operator can finish manually or re-run.
- `audit`'s attachment-cache sync (`upsertAttachment` + `pruneStaleAttachments`) failures are
  logged as a warning, not fatal — the audit's findings are still valid even if the cache
  sync itself couldn't complete.

## Testing approach

- **`test/unit/list-page-retry.test.ts`** — exercises `fetchPageWithFallback` in isolation
  (success, fallback-to-page-1 on a page>1 failure, rethrow when page 1 itself fails, and
  that the original error message survives the rethrow path).
- **`test/unit/rest-adapter-list.test.ts`** — spins up a real in-process fake WP REST media
  endpoint with `Bun.serve()` to test `RestAdapter.listMediaPage`/`listMedia` against actual
  HTTP + pagination headers: global (not per-page) size sort correctness for both `asc` and
  `desc`, the `MAX_SIZE_SORT_PAGES` bounded-fetch warning behavior, and exact-MIME-type vs.
  bare-category filtering (`mime_type` vs `media_type` query params).
- **`test/unit/audit.test.ts`** — tests `fetchAllMedia`'s pagination against a fake
  `WpBackend` (exact page-size multiples, non-multiples, and empty libraries, asserting the
  exact sequence of requested page numbers) and the `find-unattached` capability wiring (REST
  throws `CapabilityUnavailableError`, `AdapterResolver.tryResolve` returns null for a
  REST-only site, and the capability shows up in `capabilityReport()`).
- **`test/unit/stats.test.ts`** — tests the underlying `SiteDb` aggregate queries directly
  against an in-memory database: `getLibraryOverview` (zeros on empty, correct
  optimized/unoptimized counts, failed rows excluded), `getStats` (failed-row exclusion from
  `avgDurationMs`/`bytesIn`/`bytesOut`/`bytesSaved`), `getFormatBreakdown` (grouping, null
  MIME-type exclusion), and `getRecentOperations` (date/operation grouping, `limit`, failed-row
  exclusion).
- **`test/unit/wp-cli-references.test.ts`** — tests `matchesBlockId` in isolation: exact
  match, no false-positive on a longer ID that has the target as a prefix or suffix, matches
  across gallery/cover/media-text block shapes, and no-match on content with no reference.
- No dedicated unit test file targets `show.ts`, `references.ts`'s scan/`--update-to` flow, or
  `MediaBrowser.tsx`/`dispatch.ts` directly by name (no `dispatch.test.ts` or
  `media-browser.test.ts` found in `test/unit/`) — coverage for those paths, if any, would
  come from `test/integration/wp-rest.test.ts` (Dockerized WordPress) or the tarball smoke
  tests; this should be treated as a real gap rather than assumed-covered.
