# Content Management — Posts & Delete: Design

## Architecture

This subsystem sits in localpress's standard three-layer shape, but it's the thinnest of the three areas in the codebase: `posts` has effectively no engine layer of its own, and `delete` has a very small one.

```
CLI command layer          src/cli/commands/posts.ts, delete.ts
                            (commander subcommands, option parsing, --json vs.
                             human output, exit codes)
        │
        ▼
Engine layer (delete only)  src/engine/history/*  — time-machine snapshot
                             src/engine/state/db.ts — SQLite attachment/processing rows
        │
        ▼
Adapter layer               src/adapters/{resolver,rest,wp-cli}.ts
                             (posts.ts bypasses this — see below)
```

**`posts.ts` talks to the WordPress REST API directly**, not through the `WpBackend`/`AdapterResolver` abstraction that every other content-mutating command (`optimize`, `metadata`, `delete`, etc.) uses. It builds its own `Basic` auth header from `site.username`/`site.appPassword` and calls `fetch()` against `/wp-json/wp/v2/{posts,pages,<rest_base>}` directly. This is a real architectural asymmetry, not an oversight of this doc: `WpBackend` (`src/adapters/types.ts`) models *media* operations (`listMedia`, `getMedia`, `upload`, `replaceInPlace`, `updateMetadata` on attachments, `delete`, `regenerateThumbnails`, `pruneOrphans`, reference-finding) — there is no `listPosts`/`createPost`/etc. on the interface, and WP-CLI has no analogous fast/slow tradeoff for basic post CRUD the way it does for thumbnail regeneration or reference scanning. `posts.ts` therefore has no adapter to resolve against and implements its own minimal REST client inline.

**`delete.ts` (attachments) goes through the adapter layer** like the rest of the media commands: `AdapterResolver.resolve('get')` to fetch the attachment's current state (for snapshotting) and `AdapterResolver.resolve('delete')` to perform the deletion, so it automatically benefits from REST/WP-CLI adapter selection (though in practice `delete` is in `REST_PREFERRED` in `resolver.ts`, so REST is always chosen when available — WP-CLI is not actually faster or more capable for this particular capability today).

## Key files and modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/posts.ts` | `posts list/show/create/update/delete` subcommands. Owns `mapPost`/`mapPostDetail` (raw WP REST → CLI-shaped objects), `resolveTypeEndpoint` (CPT REST-base resolution + caching), `PostTypeError`. |
| `src/cli/commands/delete.ts` | `delete <ids...> [--force]`. Owns the per-ID delete loop, snapshot capture, SQLite bookkeeping, and result aggregation. |
| `src/adapters/types.ts` | `WpBackend` interface — defines `delete(id, { force })` (attachment-level) and the `Capability` union including `'delete'`. Has no post/page equivalents. |
| `src/adapters/rest.ts` | `RestAdapter.delete()` — `DELETE /wp-json/wp/v2/media/{id}[?force=true]`; translates a stock-WordPress 501 (`rest_trash_not_supported`, thrown when `MEDIA_TRASH` isn't defined) into an actionable message pointing at `--force`. |
| `src/adapters/wp-cli.ts` | `WpCliAdapter.delete()` — shells out to `wp post delete <id> [--force]` over SSH (WordPress attachments are a post type under the hood, so `wp post delete` works for media too). |
| `src/adapters/resolver.ts` | `AdapterResolver` — picks REST over WP-CLI for the `delete` capability (`REST_PREFERRED` set includes `'delete'`). |
| `src/cli/utils/run-mode.ts` | `resolveDryRun(parentOpts, defaultDryRun)` — the single source of truth for dry-run/apply semantics, used by `posts update`, `posts delete`, and `delete`. |
| `src/cli/utils/ids.ts` | `parseAttachmentIds` — parses/dedupes/validates the `<ids...>` argument for `delete`. |
| `src/engine/history/index.ts` | `openHistorySession` / `captureSnapshot` / `closeHistorySession` / `resolveHistoryConfig` — the time-machine plumbing `delete.ts` uses to snapshot attachment bytes before deletion. |
| `src/engine/state/db.ts` | `SiteDb` — `upsertAttachment` / `recordProcessing`, called after each attachment delete to keep the local cache and processing history consistent. |
| `src/cli/mcp/tools.ts` | MCP tool definitions `posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`, `delete` — thin argument-mapping wrappers that shell out to the CLI via `runCli`. |

## Data flow

### `posts list` / `posts show`
1. Command action reads `program.opts()` (global `--site`, `--json`) and the subcommand's own options.
2. `loadConfig()` + `resolveActiveSite()` resolve the target `SiteConfig` (URL + Application Password credentials).
3. `resolveTypeEndpoint(site, type)` resolves `--type` to a REST path segment (`/posts`, `/pages`, or `/<rest_base>`) — see the CPT resolution flow below.
4. A `fetch()` call is made directly against `{site.url}/wp-json/wp/v2{endpoint}` with a hand-built `Basic` auth header and (for `list`) query params built from the filter options.
5. The raw WP REST JSON (`WpPost[]` or `WpPost`) is mapped through `mapPost`/`mapPostDetail` into the CLI's stable `PostItem`/`PostDetail` shape and either printed as JSON (`printJson`) or formatted as human-readable lines (`info`).
6. Any non-2xx response or thrown error is caught, printed via `error()`, and the process exits with a matching `ExitCode`.

### `posts create` / `posts update`
1. Same site/config resolution as above.
2. `--content-file` (if given) is read synchronously via `readFileSync` and overrides `--content`.
3. A request body object is assembled from only the options actually supplied (update uses `!== undefined` checks so an intentional empty string survives; create always sends `title`/`content`/`status` since `--title` is required and the other two have defaults).
4. **`update` only**: `resolveDryRun(parentOpts, false)` is checked before touching the network. If dry-run, the command prints a preview (`warn` + optional `printJson({ dryRun: true, ... })`) and returns without calling `resolveTypeEndpoint` or `fetch` at all.
5. `resolveTypeEndpoint` resolves the CPT endpoint, then `fetch()` POSTs the body to `/wp-json/wp/v2{endpoint}` (create) or `/wp-json/wp/v2{endpoint}/{id}` (update — WordPress's REST API uses POST for partial updates, not PATCH).
6. Response is mapped through `mapPost` and printed/returned.

### `posts delete`
1. Site/config resolution + ID parsing (`Number.parseInt`, exits `InvalidUsage` if `NaN`).
2. `resolveDryRun(parentOpts, false)` gate — same preview-and-return pattern as `update`, no CPT resolution or network call in dry-run mode.
3. `resolveTypeEndpoint` resolves the endpoint, then `fetch()` issues `DELETE /wp-json/wp/v2{endpoint}/{id}[?force=true]`.
4. Result is reported as `{ action: "trashed"|"deleted", id }`. No time-machine snapshot is taken (see Requirement 5's note in requirements.md) — this command does not touch `src/engine/history` at all.

### `delete` (attachments)
1. Global opts + `parseAttachmentIds(idStrs)` validate and dedupe the ID list up front, before any adapter/DB/history setup.
2. `resolveDryRun(parentOpts, false)`; if true, the command prints the would-be action per ID and returns — no `AdapterResolver`, `SiteDb`, or history store is even constructed in that branch.
3. For a real run: `AdapterResolver(site)` is built; `getAdapter = resolver.resolve('get')` and (later) `deleteAdapter = resolver.resolve('delete')` are resolved once, not per-ID.
4. `SiteDb.init(...)` opens the per-site SQLite database; `db.ensureSite(...)` makes sure the site row exists.
5. If history is enabled (`resolveHistoryConfig(config.history)`), one `openHistorySession(store, site.name, 'delete', { force })` is opened for the whole invocation (one session covers all IDs in this run, not one per ID).
6. Per ID, in a loop:
   a. `getAdapter.getMedia(id)` fetches the attachment's current metadata (filename, mimeType, alt/title/caption/description, dimensions, URL).
   b. If a history session is open, the command `fetch()`s the attachment's own file bytes from its public URL, hashes them (SHA-256), and calls `captureSnapshot(...)` with the bytes + metadata as `beforeMeta`. This is best-effort: a failed download/snapshot logs a warning but does not stop the delete.
   c. `deleteAdapter.delete(id, { force })` performs the actual WordPress-side removal.
   d. `db.upsertAttachment(...)` and `db.recordProcessing(...)` update local state regardless of history session status.
   e. Success/failure is pushed onto a `results` array; failures increment a counter but do not abort the loop (each ID is independent).
7. After the loop, `closeHistorySession(...)` closes the session and applies the configured retention/prune policy.
8. `db.close()`, then the aggregate result (`{ deleted, failures, force, results }`) is printed; the process exits 1 if `failures > 0`.

### MCP layer
Each MCP tool (`posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`, `delete`) is a schema (Zod) + a handler that maps typed MCP arguments onto a CLI `argv` array and calls `runCli(argv, site)` — i.e., the MCP server does not reimplement any of the logic above, it drives the exact same command code the terminal CLI does, and returns whatever `--json` output that invocation produced. The two "destructive with force" tools (`delete`, `posts_delete`) additionally enforce an MCP-only guard: a `force: true` call is rejected with an `isError` result unless `confirm: true` is also present, *before* `runCli` is ever invoked. This guard exists purely at the MCP boundary — it has no equivalent flag on the CLI itself (the CLI's `--force` alone is sufficient there, since a human is presumed to be typing the command).

## Key design decisions

- **REST-always, WP-CLI-opt-in split applies to attachment `delete`, not to `posts`.** Per CLAUDE.md's locked-decisions table ("WP integration: REST (always) + WP-CLI over SSH (opt-in)"), `delete.ts` goes through `AdapterResolver`, and `delete` is explicitly listed in `resolver.ts`'s `REST_PREFERRED` set — REST is a single HTTP call, so it's preferred over the SSH round-trip even when WP-CLI is configured. `posts.ts`, in contrast, was built without an adapter at all; it always uses REST because REST is all it knows how to do. There is no WP-CLI post-management path today.
- **Bulk safety via `resolveDryRun`.** Per CLAUDE.md's "Bulk safety" and "Dry-run" conventions, `posts update`, `posts delete`, and `delete` all call the shared `resolveDryRun(parentOpts, defaultDryRun)` helper rather than checking `options.dryRun`/`--dry-run` ad hoc. All three use `defaultDryRun = false` because — unlike `optimize --all` or `caption --missing-alt`, which default to dry-run because they can silently touch an entire library — these commands only ever act on explicit, caller-supplied IDs, so the "safe by default" posture CLAUDE.md describes for `--all`/`--unoptimized` doesn't apply the same way. `posts create` was not wired into `resolveDryRun` at all (see requirements.md Requirement 9) — a real, verified gap, not a design choice explained anywhere in the code or docs.
- **Global `--dry-run`/`--apply` must not be redeclared per-subcommand.** `test/unit/dry-run-wiring.test.ts` exists specifically because commander 12 lets a subcommand silently shadow a globally-declared long flag if it redeclares the same option locally, which would make `options.dryRun` always `undefined` inside that subcommand's `action()`. Neither `posts.ts` nor `delete.ts` declares its own `--dry-run`/`--apply` option; the test enumerates the full command tree (including nested subcommands like `posts delete`) and asserts this structurally.
- **`delete` (attachments) snapshots; `posts delete` does not.** This is the sharpest asymmetry in the subsystem. Attachment delete captures binary file bytes + metadata into the time-machine store before deleting, because file bytes are otherwise unrecoverable once WordPress purges them. `posts delete` has no equivalent — post content isn't snapshotted, so there is no `undo` path for a deleted post/page. This was a deliberate scope decision reflected in the code (delete.ts imports `src/engine/history`; posts.ts does not), though it is not called out to the end user in `posts delete`'s own output.
- **CPT `rest_base` resolution with two-step fallback + caching.** WordPress lets a custom post type's REST base (`rest_base`) differ from its registered type slug (e.g. `portfolio_project` registered with `rest_base: 'portfolio'`). `resolveTypeEndpoint` first queries `/wp/v2/types/<type>` (keyed by type slug); if that 404s, it falls back to scanning the full `/wp/v2/types` collection for an entry whose `rest_base` matches, so a caller can pass either form. Results are cached in a module-level `Map` for the process lifetime — repeat calls to the same type within one command invocation cost no extra network round-trip.
- **MCP force+confirm double-guard.** Both `delete` and `posts_delete` MCP tools require `confirm: true` alongside `force: true`, purely at the MCP boundary (`src/cli/mcp/tools.ts`), before ever constructing the CLI `argv`. This reflects a general pattern in the MCP layer of adding friction to irreversible actions that an autonomous agent might otherwise invoke on a single ambiguous instruction — the CLI itself has no such double-flag requirement, since a human typing `--force` is assumed to mean it.
- **`--json` shape stability.** Per CLAUDE.md ("the skill and the MCP server both consume `--json`... treat the JSON shapes as a public API"), the `{ action, post }`, `{ action, id }`, `{ items, total, totalPages, page }`, and `{ deleted, failures, force, results }` shapes documented in `skill/SKILL.md` and mirrored in this design are load-bearing for both the MCP bridge and any script consuming the CLI directly.

## Error handling / edge cases

- **Invalid IDs.** Both `posts.ts` (`Number.parseInt` + `Number.isNaN` check per-command) and `delete.ts` (`parseAttachmentIds`, which validates and dedupes the whole ID list up front) exit `InvalidUsage` (2) before any network activity.
- **Unknown/misconfigured custom post types.** `resolveTypeEndpoint` distinguishes "type doesn't exist" (`PostTypeError` / `InvalidUsage`) from "type exists but isn't REST-exposed" (`show_in_rest: false` → `PostTypeError` / `CapabilityUnavailable`), giving callers a way to programmatically tell the two apart via exit code.
- **WordPress REST errors.** Every `fetch()` call in `posts.ts` checks `res.ok`; on failure it prints the HTTP status and up to 200 characters of the response body, then exits `NetworkError` (4). Thrown `PostTypeError`s are caught separately in each action and re-exit with the error's own `exitCode` rather than always defaulting to `NetworkError`.
- **`MEDIA_TRASH` not enabled.** `RestAdapter.delete()` (attachments) specifically detects the `rest_trash_not_supported` / HTTP 501 response stock WordPress returns for a non-force delete when `MEDIA_TRASH` isn't defined, and rewrites it into a message telling the caller to use `--force` — rather than surfacing WordPress's generic REST error text.
- **Partial failure across multiple attachment IDs.** `delete` treats each ID independently: one failure (network blip, already-deleted ID, permissions) is recorded in `results` and does not stop processing of the remaining IDs. The command's overall exit code becomes 1 only if at least one ID failed.
- **Best-effort snapshotting.** If downloading an attachment's bytes for the pre-delete snapshot fails (404, timeout, revoked auth), `delete.ts` logs a warning inline (not a command failure) and proceeds with the actual delete — the design explicitly prioritizes "the user's requested action happens" over "the safety net is guaranteed to exist."
- **Field-clearing vs. field-omission in `posts update`.** The body-building logic in `posts update` uses `!== undefined` rather than truthiness checks, so `--excerpt ""` is distinguishable from not passing `--excerpt` at all — an easy bug class (an empty string silently dropped) that the source comments call out directly.

## Testing approach

- **`test/unit/posts-type-resolution.test.ts`** — unit-tests `resolveTypeEndpoint` in isolation via a stubbed `globalThis.fetch`: built-in `post`/`page` never hit the network; a CPT with a differing `rest_base` resolves correctly; missing `rest_base` falls back to the type slug; a 404 type lookup throws `PostTypeError` with `InvalidUsage`; `show_in_rest: false` throws `PostTypeError` with `CapabilityUnavailable`; repeat calls for the same type only fetch once (cache verification).
- **`test/unit/dry-run-wiring.test.ts`** — structural regression test (not behavioral) ensuring neither `posts.ts` nor `delete.ts` (nor any other command) redeclares `--dry-run`/`--apply` locally, which would silently break `resolveDryRun` for that subcommand. Walks the full command tree including nested subcommands (`posts delete`, etc.).
- **`test/unit/run-mode.test.ts`** — covers `resolveDryRun`'s own precedence logic (apply-wins, explicit dry-run, default fallback) that `posts update`/`posts delete`/`delete` all depend on.
- **`test/unit/mcp.test.ts`** — verifies the `delete` MCP tool's schema exposes `ids`/`force`; verifies both `delete` and `posts_delete` MCP tools reject `force: true` without `confirm: true`, asserting the error text mentions "confirm".
- **`test/integration/wp-rest-commands.test.ts`** (Dockerized WordPress) — end-to-end `posts create` → `list` → `show` → `update` → `delete` round trip against a live WP REST API for the built-in `post` type, plus a dedicated test proving a custom post type (`lp_item`, registered with `rest_base: 'lp-items'` in the test fixture's `setup-wp.sh`) routes correctly through its `rest_base` rather than its type slug. Attachment-level `adapter.delete(id, { force: true })` calls appear throughout this file as cleanup for other tests' uploaded fixtures, but there is no dedicated integration test asserting the `delete` CLI command's own snapshot-capture or partial-failure behavior specifically — that logic is exercised only incidentally, if at all, and would be worth a dedicated integration test if this area is revisited.
