# Content Management — Posts & Delete: Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core logic

- [x] Define `WpPost` (raw WP REST shape) and stable `PostItem`/`PostDetail` output types, plus `mapPost`/`mapPostDetail` converters that strip HTML from rendered fields and prefer `raw` values when available (`context=edit`). (Requirement 2)
- [x] Implement `resolveTypeEndpoint(site, type)`: hardcode `post`→`/posts`, `page`→`/pages`; for any other type, query `/wp-json/wp/v2/types/<type>` for `rest_base`; fall back to scanning `/wp-json/wp/v2/types` for a matching `rest_base` on 404; cache resolved endpoints in a module-level `Map`. (Requirement 6)
- [x] Define `PostTypeError` with an `exitCode` field, thrown with `InvalidUsage` for an unresolvable type and `CapabilityUnavailable` for a type with `show_in_rest: false`. (Requirement 6)
- [x] Implement `parseAttachmentIds` in `src/cli/utils/ids.ts`: parse, validate (exit `InvalidUsage` on any non-integer), and dedupe the `<ids...>` argument shared by `delete`. (Requirement 7)
- [x] Implement `resolveDryRun(parentOpts, defaultDryRun)` in `src/cli/utils/run-mode.ts` as the single shared dry-run/apply precedence resolver (apply wins > explicit dry-run > command default). (Requirement 9)
- [x] Implement `RestAdapter.delete(id, { force })`: `DELETE /wp-json/wp/v2/media/{id}[?force=true]`, with `rest_trash_not_supported`/501 detection rewritten into an actionable `--force` suggestion. (Requirement 7)
- [x] Implement `WpCliAdapter.delete(id, { force })`: `wp post delete <id> [--force]` over SSH. (Requirement 7)
- [x] Register `'delete'` in `AdapterResolver`'s `REST_PREFERRED` set so REST is chosen over WP-CLI for attachment deletion even when SSH/WP-CLI is configured. (Requirement 7, design.md "Key design decisions")
- [x] Wire attachment `delete` into the time-machine: open one `openHistorySession(..., 'delete', { force })` per invocation, `captureSnapshot` (file bytes + SHA-256 hash + metadata) per attachment before the WP-side delete call, best-effort (log-and-continue on capture failure), and `closeHistorySession` with retention/pruning after the loop. (Requirement 8)
- [x] Record post-delete state in SQLite via `db.upsertAttachment(...)` and `db.recordProcessing(...)` for every attempted ID, success or failure. (Requirement 8)

## CLI command wiring

- [x] `posts list`: filters (`--status`, `--type`, `--author`, `--search`, `--category`), pagination (`--per-page` capped at 100, `--page`), sorting (`--orderby`, `--order`); `--json` returns `{ items, total, totalPages, page }` sourced from `X-WP-Total`/`X-WP-TotalPages` headers; human mode prints a next-page hint. (Requirement 1)
- [x] `posts show <id>`: fetches with `context=edit`; `--json` returns the full `PostDetail` shape; human mode truncates excerpt/content for readability. (Requirement 2)
- [x] `posts create`: required `--title`, `--status` defaults to `draft`, `--content-file` overrides `--content`, optional `--slug`/`--excerpt`/`--featured-image`/`--category`/`--tag`; returns `{ action: "created", post }`. No dry-run gate (verified gap, documented in requirements.md Requirement 9). (Requirement 3)
- [x] `posts update <id>`: only-provided-fields body construction using `!== undefined` checks (so an explicit empty string can clear a field); refuses an all-empty update with `InvalidUsage`; gated by `resolveDryRun(parentOpts, false)` with a `{ dryRun: true, action: "update", id, fields }` JSON preview; returns `{ action: "updated", post }` on execution. (Requirement 4, Requirement 9)
- [x] `posts delete <id>`: `--type`, `--force` (adds `?force=true`); gated by `resolveDryRun(parentOpts, false)` with a `{ dryRun: true, action: "trash"|"delete", id }` JSON preview; returns `{ action: "trashed"|"deleted", id }` on execution. No time-machine snapshot (documented asymmetry vs. attachment `delete`). (Requirement 5, Requirement 9)
- [x] Uniform error handling across all `posts` subcommands: invalid ID → `InvalidUsage` (2) pre-network; non-2xx WP response → status + truncated body → `NetworkError` (4); `PostTypeError` → re-exit with its own `exitCode`. (Requirement 1–6)
- [x] `delete <ids...> [--force]`: no `--all`/`--unoptimized` bulk-selection flags by design (explicit IDs only); gated by `resolveDryRun(parentOpts, false)` with a per-ID dry-run preview and `{ dryRun: true, force, ids }` JSON; per-ID try/catch loop so one failure doesn't abort the batch; aggregate `{ deleted, failures, force, results }` JSON output; process exits 1 if any ID failed. (Requirement 7)
- [x] Regression test coverage ensuring neither `posts.ts` nor `delete.ts` locally redeclares the global `--dry-run`/`--apply` options (which would silently break `resolveDryRun` under commander 12's flag-shadowing behavior). (Requirement 9)

## MCP tool wiring

- [x] Register `posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete` MCP tools in `src/cli/mcp/tools.ts`, each with a Zod input schema mirroring the CLI's own options and a handler that maps args to a CLI `argv` array via `runCli`. (Requirement 10)
- [x] Register the `delete` MCP tool (attachment deletion) with `ids`/`force` (+ `confirm`) schema, mapped to the `delete <ids...> [--force]` CLI invocation. (Requirement 7, Requirement 10)
- [x] Add the force+confirm double-guard to both `delete` and `posts_delete` MCP tools: reject `force: true` without `confirm: true` with an `isError` result containing "confirm", before ever constructing the CLI `argv` or invoking `runCli`. (Requirement 10)

## Tests

- [x] `test/unit/posts-type-resolution.test.ts` — `resolveTypeEndpoint` unit coverage: built-ins skip the network; `rest_base` resolution incl. fallback-by-slug and fallback-when-`rest_base`-absent; `PostTypeError` exit codes for 404 and `show_in_rest: false`; caching (fetch called once per type). (Requirement 6)
- [x] `test/unit/dry-run-wiring.test.ts` — structural check that `posts.ts`/`delete.ts` (and all other commands) never redeclare `--dry-run`/`--apply` locally. (Requirement 9)
- [x] `test/unit/run-mode.test.ts` — `resolveDryRun` precedence unit tests underpinning `posts update`/`posts delete`/`delete`. (Requirement 9)
- [x] `test/unit/mcp.test.ts` — `delete` tool schema assertions (`ids`, `force`); force+confirm rejection tests for both `delete` and `posts_delete` MCP tools. (Requirement 10)
- [x] `test/integration/wp-rest-commands.test.ts` — live-WordPress round trip for `posts create/list/show/update/delete` on the built-in `post` type, plus a dedicated custom-post-type test (`lp_item` / `rest_base: 'lp-items'`) proving `--type` resolution routes on `rest_base`, not the type slug. (Requirement 1–6)

## Docs

- [x] Document `posts` and `delete` usage, flags, and `--json` output shapes in `skill/SKILL.md` under "Content management (posts, delete, a11y)", including the dry-run JSON shapes for `posts update`/`posts delete`/`delete`. (Requirement 9)
- [x] List `posts` (list/show/create/update/delete) and `delete` in `README.md`'s command table and quick-start examples, and in `CLAUDE.md`'s "Content management" command grouping and v2.0.0 release-history entry.
