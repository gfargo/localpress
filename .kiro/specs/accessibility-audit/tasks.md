# Accessibility Audit — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core scan logic (`src/cli/commands/a11y.ts`)

- [x] Define `A11yFinding` (`type`, `postId`, `postTitle`, `detail`, optional `element`) and `A11yError` (`postType`, `url`, optional `status`/`message`) types (Req 7)
- [x] Define `A11yScanOptions`/`A11yScanResult` interfaces and extract scan logic into an exported `runA11yScan()` function, separate from the Commander action handler, so it can be unit tested with a mocked `fetch` (Req 1, 6)
- [x] Implement heading-hierarchy analysis: collect `<h1>`–`<h6>` tags in order, flag `multiple-h1` when more than one `<h1>` is present (Req 2)
- [x] Implement heading-skip detection across consecutive heading levels (Req 2)
- [x] Implement `GENERIC_LINK_TEXTS` lookup set and link-text analysis (strip nested tags, normalize case/whitespace, match against the set) producing `generic-link-text` findings (Req 3)
- [x] Implement empty-link detection, excluding links with `aria-label` or a nested `<img>` (Req 3)
- [x] Implement missing-alt detection for inline `<img>` tags, treating `alt=""` as intentionally present (not flagged) and only flagging tags with no `alt=` at all (Req 4)
- [x] Implement `--type` fan-out (`post` → `posts`, `page` → `pages`, omitted → both) (Req 5)
- [x] Implement `--id` single-post lookup mode across all requested post types, with `context=edit` fetch (Req 5)
- [x] Implement collection-mode pagination (`per_page`, `page`, `status`, `_fields=id,title,content`) driven by `X-WP-TotalPages` (Req 1, 5)
- [x] Implement `--limit` enforcement across combined post types, marking affected post types as `truncated` when the limit is hit mid-pagination (Req 5, 6)
- [x] Implement error accounting for failed/non-OK requests per post type, without aborting other post types' scans (Req 6)
- [x] Implement `--id`-mode cross-type 404 filtering (don't report an error if the post was found under a different requested type) (Req 6)
- [x] Compute `complete` as `errors.length === 0 && truncated.length === 0` after `--id`-mode error filtering (Req 6, 7)

## CLI command wiring

- [x] Register `a11y` command via `registerA11yCommand(program)` with `--type`, `--status` (default `publish`), `--id` (via shared `parseIntOption` validator), `--limit` (default 100) options (Req 5)
- [x] Resolve active site/config and build HTTP Basic auth header from `site.username`/`site.appPassword` (Req 1)
- [x] Compute `summary` counts per finding type from the flat `findings` array (Req 1, 7)
- [x] Implement `--json` output: single object with `site`, `postsChecked`, `findings`, `summary`, `errors`, `truncated`, `complete`; set `process.exitCode = ExitCode.NetworkError` when errors are present (Req 6, 7)
- [x] Implement human-readable output: error block (with per-error reason) that returns early before findings when errors exist; grouped findings by type (5 shown inline + "...and N more"); remediation hints; truncation notice (Req 1, 6)
- [x] Ensure a clean scan with zero findings reports "No accessibility issues found" (or a truncation-aware variant) rather than silence (Req 1, 6)

## MCP tool wiring

- [x] Register `a11y_audit` MCP tool in `src/cli/mcp/tools.ts` with Zod schema (`site`, `type` enum, `status`, `id`, `limit`) mirroring the CLI flags (Req 8)
- [x] Map tool arguments to `a11y` CLI argv via `opt()` helper and dispatch through the shared `runCli()`/`invokeCli()` bridge (forces `--json --quiet`, parses stdout, surfaces non-zero exit as `isError`) (Req 8)

## Tests

- [x] Unit test: clean/complete scan with zero posts across both types reports `postsChecked: 0`, empty findings/errors, `complete: true` (Req 1, 6)
- [x] Unit test: mid-pagination HTTP failure (500) records the error, preserves already-checked posts, and marks `complete: false` (Req 6)
- [x] Unit test: thrown network error (fetch rejection) is recorded as an error with zero posts checked (Req 6)
- [x] Unit test: `--id` mode records an error when a single post lookup 404s across all requested types (Req 5, 6)
- [x] Unit test: `--id` mode does not report an error when the post is found under a different requested post type (Req 5, 6)
- [x] Unit test: `--limit` truncation marks the affected type in `truncated` and `complete: false` (Req 5, 6)
- [x] Unit test: an error in one post type does not prevent another post type from being checked and reported (Req 6)

## Docs

- [x] Document `a11y` usage and `--json` output shape in `skill/SKILL.md` (§ "Content management (posts, delete, a11y)") for AI agents using the skill instead of MCP (Req 7)
- [x] Record the `a11y` command, its checks, its flags, and the `a11y_audit` MCP tool in `CHANGELOG.md` under the v2.0.0 release entry (Req 1–8)
- [x] Record the v2.1.0 correctness fix (surfacing scan errors/truncation instead of a false "all clear", exiting non-zero on failure) in `CHANGELOG.md` (Req 6)
