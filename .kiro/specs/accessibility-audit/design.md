# Accessibility Audit — Design

## Architecture

`a11y` sits at the CLI command layer but, unlike the media commands, it does **not** go through localpress's adapter/resolver capability system (`src/adapters/{types,rest,wp-cli,resolver}.ts`). That layer exists to pick the best backend (REST vs. opt-in WP-CLI-over-SSH) per *media* operation, because some media operations (replace-in-place, thumbnail regeneration, full reference scans) are only possible over WP-CLI. Post/page content CRUD and the accessibility audit have no such split: the WordPress REST API (`/wp-json/wp/v2/posts`, `/wp-json/wp/v2/pages`, and custom-post-type REST bases) is always sufficient to read rendered content, so `a11y.ts` — like `posts.ts` — talks to `fetch()` directly against the site's REST base URL with HTTP Basic auth built from the site's stored Application Password. This is a deliberate, load-bearing pattern shared by both content commands, not an oversight.

Layering for this feature:

```
CLI layer:  src/cli/commands/a11y.ts  (registerA11yCommand, option parsing, output formatting)
                    │
                    ▼
Scan logic: runA11yScan() (same file) — pure-ish async function, fetch + pagination + fan-out
                    │
                    ▼
Analysis:   analyzePost() (same file) — regex-based HTML checks, pure function, no I/O
                    │
                    ▼
Transport:  global fetch() → WordPress REST API (wp-json/wp/v2/{posts|pages|<cpt-rest-base>})
```

The MCP server sits *beside* this, not inside it: `a11y_audit` in `src/cli/mcp/tools.ts` builds a CLI argv array and shells back out to the compiled `localpress` binary via `invokeCli()` in `src/cli/mcp/invoke.ts`. It does not call `runA11yScan` in-process. This mirrors every other MCP tool in the server (per the file's own header comment): "Every MCP tool is a thin wrapper around the existing CLI... This reuses the CLI's stable JSON contract."

## Key files/modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/a11y.ts` | Everything: option parsing (`registerA11yCommand`), the fetch/paginate/fan-out logic (`runA11yScan`, exported for testability), the regex-based WCAG checks (`analyzePost`, module-private), and both human-readable and `--json` output formatting. |
| `src/cli/mcp/tools.ts` (`a11y_audit` tool, ~line 1332) | Zod input schema (`site`, `type`, `status`, `id`, `limit`) and argv translation into `['a11y', '--type', ..., '--status', ..., '--id', ..., '--limit', ...]`. |
| `src/cli/mcp/invoke.ts` (`invokeCli`) | Generic (not a11y-specific) child-process bridge: spawns the same binary recursively with `--json --quiet` forced, parses stdout as JSON (falling back to NDJSON or raw text), enforces a 10-minute default timeout with SIGTERM→SIGKILL escalation. |
| `src/cli/utils/config.ts` (`loadConfig`, `resolveActiveSite`) | Resolves which site's URL/username/Application Password to use, honoring `--site` overrides. |
| `src/cli/utils/args.ts` (`parseIntOption`) | Commander argument parser for `--id`/`--limit`, rejecting non-numeric input with a clean `InvalidArgumentError` rather than `NaN` propagating silently. |
| `src/types.ts` (`ExitCode`) | `ExitCode.NetworkError` (4) is the exit code used when the scan reports errors. |
| `test/unit/a11y.test.ts` | Unit tests against `runA11yScan` with a mocked `globalThis.fetch`. |
| `skill/SKILL.md` (§ "Content management (posts, delete, a11y)") | Documents the CLI usage and the `--json` output shape for agents using the skill instead of MCP. |

## Data flow

1. **Command invocation.** `registerA11yCommand` parses `--type`, `--status` (default `publish`), `--id`, `--limit` (default 100) via Commander, loads config, and resolves the active site (or the one named by the global `--site` flag).
2. **Auth construction.** Builds a `Basic` auth header directly from `site.username`/`site.appPassword` (base64 via `btoa`) — no token exchange or session, consistent with how the REST adapter and `posts.ts` authenticate.
3. **Type fan-out.** `--type post` → `['posts']`; `--type page` → `['pages']`; omitted → `['posts', 'pages']`. `runA11yScan` iterates this list.
4. **Fetch, per post type:**
   - **Single-ID mode** (`--id` set): `GET {baseUrl}/wp-json/wp/v2/{postType}/{id}?context=edit` for each requested type. A non-OK response is provisionally recorded as an error but not fatal — if *any* requested type succeeds for that ID, the 404s from the others are filtered out afterward (a person doesn't know in advance whether ID 45 is a post or a page).
   - **Collection mode** (no `--id`): paginates `GET {baseUrl}/wp-json/wp/v2/{postType}?per_page=..&page=..&status=..&_fields=id,title,content`, reading `X-WP-TotalPages` to know when to stop, capping the total posts checked (across all types) at `--limit`. `_fields` is restricted to `id,title,content` to keep responses small. `context=edit` is used only in single-ID mode (matches the raw/unfiltered content REST returns in edit context); collection mode relies on the default `view` context's rendered content.
5. **Per-post analysis.** Each fetched post's `content.rendered` HTML string is passed to `analyzePost`, which runs three independent regex passes and appends findings to a shared array:
   - Heading pass: collects all `<h1>`–`<h6>` opening tags in document order, flags a `multiple-h1` finding if more than one `<h1>` exists, then walks consecutive pairs flagging `heading-skip` wherever the level jumps by more than 1.
   - Link pass: matches `<a ...>...</a>` non-greedily, strips nested tags from the inner text, lowercases and trims it, then either flags `empty-link` (no text, no `aria-label`, no `<img>`) or `generic-link-text` (text matches the `GENERIC_LINK_TEXTS` set).
   - Image pass: matches `<img ...>` tags and flags `missing-img-alt` when the tag string doesn't contain `alt=` at all (an empty `alt=""` is *not* flagged — treated as intentionally decorative).
6. **Error/edge accounting.** Fetch failures (network throw or non-OK response) are appended to an `errors` array with as much context as available (URL, post type, HTTP status or error message). Hitting `--limit` mid-pagination for a type adds that type to a `truncated` list. `complete` is `true` only when `errors` is empty (after the `--id`-mode filtering) and `truncated` is empty.
7. **Aggregation and output.** The command layer computes a `summary` (counts per finding type) from the flat `findings` array. `--json` mode prints one JSON object (`site`, `postsChecked`, `findings`, `summary`, `errors`, `truncated`, `complete`) and sets `process.exitCode = ExitCode.NetworkError` if there were errors. Human-readable mode prints grouped findings (5 per group inline, "...and N more" beyond that), remediation hints, and a truncation notice if applicable; it returns early with an error block (still exit-coding NetworkError) if `errors.length > 0`, before ever printing findings.
8. **MCP path.** For agents going through MCP, `a11y_audit` builds the equivalent argv, `invokeCli` spawns the compiled binary with `--json --quiet` forced, captures stdout, `JSON.parse`s it, and returns it as the tool's `structuredContent` (plus a text rendering) — so an MCP agent gets the identical JSON shape a CLI/skill user would get from `a11y --json`.

## Key design decisions

- **No HTML parser / DOM — plain regexes.** All three checks (`headingRegex`, `linkRegex`, `imgRegex`) operate on the raw rendered HTML string with global regexes, not an HTML parser (no `cheerio`/`jsdom` dependency). This keeps the command dependency-free and fast, at the cost of being technically fooled by pathological markup (e.g. an `<a>` tag's text containing a literal `</a>` inside an attribute value, or self-referential/nested constructs regex can't correctly balance). This is an accepted tradeoff for a heuristic content-linting tool, not a spec-conformant HTML5 parser.
- **REST-only, no adapter/resolver.** Deliberately bypasses `AdapterResolver`/`tryResolve()` (used by media commands) since content read access needs nothing WP-CLI-only can provide. `posts.ts` follows the identical direct-fetch pattern for consistency.
- **`--id` mode treats cross-type 404 as expected, not an error.** Because a caller supplying just an ID doesn't necessarily know if it's a post, page, or CPT item, the scan probes every requested type and only surfaces an error if *none* succeeded. This avoids spurious error output for the common case (checking a single known post) while still surfacing real problems (auth failure, wrong ID entirely).
- **Truncation is distinct from error.** Hitting `--limit` is not treated as a failure (no error entry, no NetworkError exit by itself) but does mark `complete: false` and lists the affected type in `truncated`, so callers can distinguish "the scan was capped, findings may be incomplete" from "the scan failed."
- **Complete-result honesty over false "all clear."** Per the CHANGELOG (v2.1.0 entry, issue #103), the command used to be able to report "no issues found" even when requests had failed mid-scan. The current implementation explicitly separates `errors`/`truncated`/`complete` from `findings` so a clean `findings: []` is never conflated with a successful full scan — this is called out directly in the file's own top-of-file comment context and is exercised by dedicated regression tests (see Testing below).
- **Explicit empty `alt=""` is not a violation.** Matches WCAG guidance that an empty alt is a valid, intentional marker for decorative images — only the *absence* of the `alt` attribute is flagged.
- **`postsChecked` limit is global across types, not per-type.** `--limit 100` with `--type` omitted checks at most 100 posts total split across `posts` and `pages` (whichever is processed first — `posts` before `pages` — gets priority), not 100 of each.
- **MCP tool is a thin argv-translation wrapper, not a reimplementation.** Consistent with every other MCP tool in `tools.ts`; the only a11y-specific pieces are the Zod schema and the flag-name mapping (`opt(argv, '--type', a.type)` etc.) — all scan logic, pagination, and finding rules live only in `a11y.ts` and are exercised once.

## Error handling / edge cases

- **Network/fetch throw** (e.g. DNS failure, connection refused): caught per-request, appended to `errors` with the exception message, and that post type's pagination loop stops (`break`), but other post types still run.
- **Non-2xx HTTP response**: recorded with `status` instead of `message`; collection-mode pagination for that type stops there.
- **Empty content** (`html` falsy/empty string): `analyzePost` returns immediately without pushing any findings — no crash on empty posts.
- **Post title containing HTML** (e.g. `<em>Sale</em>`): stripped via a simple tag-strip regex (`replace(/<[^>]*>/g, '')`) before being used in findings, so `postTitle` in output is always plain text.
- **Zero posts returned mid-pagination** (`posts.length === 0`): pagination loop breaks cleanly, treated as end-of-collection, not an error.
- **`X-WP-TotalPages` header missing**: defaults to `'1'`, so a single page is assumed and pagination stops after it rather than looping indefinitely.
- **Empty-link disambiguation**: an `<a>` with no visible text is *not* flagged if it has `aria-label` or contains an `<img>` (icon links / image links are common and accessible when properly labeled).
- **JSON output on error**: unlike the human-readable path (which prints errors and returns without ever showing findings), `--json` always emits the full result object — `findings`, `summary`, `errors`, `truncated`, `complete` together — so agents parsing JSON can see partial results alongside failures rather than getting only an error message.
- **MCP-side error surfacing**: if the underlying CLI invocation exits non-zero, `runCli()` in `tools.ts` returns `isError: true` with a text block built from stderr/stdout instead of throwing, so the MCP host gets a structured failure rather than a crash. `invokeCli` itself also enforces a hard timeout (default 10 minutes) with SIGTERM then SIGKILL, in case a very large site scan hangs.

## Testing approach

- **`test/unit/a11y.test.ts`** is the primary and (as far as this review found) only dedicated test file. It calls `runA11yScan` directly with `globalThis.fetch` mocked, and covers:
  - A clean, complete scan with zero posts/findings/errors.
  - A mid-pagination HTTP failure (500) marking the scan incomplete while preserving the one post already checked.
  - A thrown/network-level fetch error recorded as an error with zero posts checked.
  - `--id` mode reporting an error when a single lookup 404s.
  - `--id` mode *not* reporting an error when the post is found under a different post type than the first one tried (the "search across types" behavior).
  - `--limit` truncation marking the affected type as `truncated` and `complete: false`.
  - An error in one post type (`posts` → 403) not preventing the other type (`pages`) from being checked and reported cleanly.
- **No dedicated integration test** for `a11y` was found under `test/integration/` (the `wp-rest.test.ts` integration suite targets Dockerized WordPress but does not appear to include an a11y-specific case) — this doc does not claim integration coverage that isn't confirmed in the code. If a reviewer wants live-WordPress coverage of the audit, that would currently need to be added.
- **No test found for the `analyzePost` regex checks in isolation** — they're exercised indirectly through `runA11yScan`'s HTTP-mocked tests (all of which use trivial `<p>hi</p>` content), so the specific WCAG rules (heading-skip, multiple-h1, generic-link-text, missing-img-alt, empty-link detection) are documented from reading `analyzePost`'s implementation directly rather than confirmed via a passing test asserting on those finding types. This is a documentation gap worth flagging to a reviewer, not an invented test.
- **MCP wiring** (`a11y_audit` tool): checked `test/unit/mcp.test.ts`, `test/unit/mcp-schema-cli-parity.test.ts`, and `test/unit/mcp-batch-merge.test.ts` — none reference `a11y` or `a11y_audit` by name. The MCP tool's argv translation (`opt(argv, '--type', ...)` etc.) is therefore not confirmed to be under direct test; only the underlying `runA11yScan`/CLI behavior is tested. Flagging this as a real gap rather than asserting coverage that doesn't exist.
