# MCP Server Integration

Backfilled record of already-completed implementation work, not a forward plan.

## Adapter / resolver foundation

- [x] Define the `Capability` union and `WpBackend` interface shared by all adapters (`src/adapters/types.ts`) — `list`, `get`, `upload`, `update-meta`, `delete`, `replace-in-place`, `regenerate-thumbnails`, `prune-orphans`, `fast-references`, `full-references`, `find-unattached` (Requirement 6)
- [x] Define normalized domain types independent of any one backend — `MediaItem`, `MediaSize`, `Reference`, `PagedResult<T>`, `ListFilters`, `UploadMetadata`, `UpdateMetadata`, `ReplaceOptions`, `PruneResult`, `FormatChangeRewrite` (`src/adapters/types.ts`)
- [x] Define `CapabilityUnavailableError` (capability + adapter name + message) and `WpApiError` (message + HTTP status) as the typed error vocabulary adapters throw (Requirement 7)
- [x] Implement SSH/SCP process-execution helpers — `sshExec`, `scpUpload`, `scpDownload`, `shellQuote`, `buildSshArgs`, `sshDestination` — shelling out to the system `ssh`/`scp` binaries (`src/adapters/ssh.ts`)
- [x] Implement `AdapterResolver`: construct `RestAdapter` (always) and `WpCliAdapter` (only if `isWpCliAvailableForSite`), and expose `resolve()`, `tryResolve()`, `getAdapter()`, `availability()`, `capabilityReport()` (`src/adapters/resolver.ts`) (Requirement 6)
- [x] Encode the REST-vs-WP-CLI preference split via `ADAPTER_PRIORITY` (`['wp-cli', 'rest']`) and the `REST_PREFERRED` override set (`list`, `get`, `upload`, `update-meta`, `delete`, `fast-references` prefer REST despite WP-CLI's general priority, due to per-item SSH round-trip cost) (Requirement 6)

## REST adapter

- [x] Implement `RestAdapter` constructor — Application Password Basic auth, base URL normalization (`src/adapters/rest.ts`)
- [x] Implement `listMedia` / `listMediaPage` against `/wp-json/wp/v2/media`, including client-side global size-sort (`fetchAllForSizeSort`, bounded to `MAX_SIZE_SORT_PAGES` pages) since WP REST has no `orderby=size`
- [x] Implement `getMedia` with `context=edit` so `title.raw`/`caption.raw`/`description.raw` are available for read-modify-write flows (regression coverage: issue #101)
- [x] Implement `upload` (multipart `FormData`, filename sanitization for `Content-Disposition` safety) and `updateMetadata` (`POST /media/:id`)
- [x] Implement `delete`, including translation of `rest_trash_not_supported` / HTTP 501 into an actionable "re-run with `--force`" message when `MEDIA_TRASH` isn't enabled on the target site (Requirement 7)
- [x] Implement `findReferences` fast scope (featured images via `featured_media`, Gutenberg block IDs via `content.raw` block-comment parsing with a rendered-HTML `wp-image-<id>` fallback)
- [x] Throw `CapabilityUnavailableError` with adapter-specific guidance for every capability REST cannot provide: `replaceInPlace`, `regenerateThumbnails`, `pruneOrphans`, `findUnattached`, and `findReferences(..., 'full')` (Requirement 7)
- [x] Implement `paginateAll` (follows `X-WP-TotalPages`) as the shared pagination helper for reference scanning

## WP-CLI adapter

- [x] Implement `WpCliAdapter` constructor requiring `SiteConfig.ssh`, plus the `wp()`/`wpJson()` command-execution helpers (`src/adapters/wp-cli.ts`)
- [x] Implement `getMetaRows` distinguishing a genuinely-absent meta key (exit 0, empty result) from a real WP-CLI/SSH failure (which must propagate, not be silently read as "no value")
- [x] Implement `listMedia`/`listMediaPage`/`getMedia` via `wp post list`/`wp post get` + meta lookups
- [x] Implement `upload` (local temp file → SCP → `wp media import`, with cleanup of both local and remote temp files on success and failure paths)
- [x] Implement `replaceInPlace`, including the format-change path: SCP new bytes into place, update `_wp_attached_file`/MIME/`_wp_attachment_metadata` before deleting old bytes (so a mid-sequence failure never leaves the attachment pointing at a deleted file), regenerate thumbnails, and best-effort rewrite post-content references (`wp search-replace`) for both the base file and each size variant, surfacing a non-fatal warning if the rewrite step fails
- [x] Implement `updateMetadata`, `delete`, `regenerateThumbnails`
- [x] Implement `pruneOrphans` (diff uploads-directory files against `wp_postmeta`-registered attachment + size-variant files) and `findUnattached` (candidates with `post_parent=0`, filtered to those with zero references via `findReferences(..., 'full')`)
- [x] Implement `findReferences` full scope: featured images, Gutenberg blocks (SQL `LIKE` pre-filter + `matchesBlockId` ID-boundary-safe regex post-filter), content-URL matching, and post-meta scanning — scoped to `post_status='publish'` for parity with the REST adapter's default
- [x] Cache the WordPress uploads base directory/URL per adapter instance (`getUploadsPaths`) to avoid a repeated SSH round-trip on every `replaceInPlace` call

## MCP server scaffolding

- [x] Boot the MCP server over stdio: construct `McpServer` with name/version/capabilities/`instructions`, call `registerTools`/`registerResources`, connect `StdioServerTransport` (`src/cli/mcp/server.ts`)
- [x] Implement `invokeCli`: spawn the CLI binary, force `--json --quiet`, inject top-level `--site`/`--concurrency` ahead of the subcommand, resolve dev-mode vs. tarball vs. `PATH` binary via `getSelfBin`/`isDevMode` (`src/cli/mcp/invoke.ts`) (Requirement 9)
- [x] Implement the 10-minute default timeout with `SIGTERM` → 8-second-grace `SIGKILL` escalation (Requirement 9)
- [x] Implement stdout parsing fallback chain: `JSON.parse` whole → NDJSON line-by-line → raw text (Requirement 2)
- [x] Implement the three-mode self-invocation helper (`isDevMode`, `getSelfBin`, `buildSelfArgs`) shared with the interactive TUI's subcommand dispatch (`src/cli/utils/self-invoke.ts`)

## Tool registration (46 tools)

- [x] Register setup/config tools: `sites_list`, `sites_use`, `sites_add`, `sites_remove`, `doctor`, `config_get`, `config_set`, `config_list_profiles`, `config_get_profile`, `config_set_profile` (Requirement 1, Requirement 3)
- [x] Register discovery tools: `list`, `show`, `stats`, `audit`, `references`
- [x] Register processing tools with `concurrency` schema fields: `optimize`, `convert`, `resize`, `remove_bg` (Requirement 4)
- [x] Register AI vision tools: `caption`, `generate_title`, `generate_description`, `vision`, `tag`, `classify`, `rename`
- [x] Register mutation/safety tools: `delete`, `update_metadata` — including the `force`-requires-`confirm` guard evaluated before any CLI invocation (Requirement 8)
- [x] Register round-trip/low-level tools: `pull`, `push`, `regenerate`, `export`, `import`
- [x] Register time-machine tools: `history_list`, `history_show`, `undo`, `history_prune`
- [x] Register `watch_status` (explicitly read-only; watch start/stop intentionally not exposed as MCP tools)
- [x] Register content-management tools: `a11y_audit`, `posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete` (with the same force/confirm guard as `delete`) (Requirement 8)
- [x] Register composite convenience tools: `search_by_url` (URL → filename → `list --search`), `health_check` (parallel `doctor` + `stats` + `audit --missing-alt`) (Requirement 10)
- [x] Keep MCP tool input field names in camelCase mapped to the CLI's kebab-case flags, and keep tool descriptions close to CLI `--help` text so the skill and MCP schemas stay a single source of truth (Requirement 1)

## Resources

- [x] Register `localpress://sites` → `sites --json` (Requirement 3)
- [x] Register `localpress://stats` → `stats --json` (Requirement 3)
- [x] Register `localpress://capabilities` → `doctor --json` (i.e. `AdapterResolver.capabilityReport()`) (Requirement 3, Requirement 6)
- [x] Register `localpress://history` → `history --json` (Requirement 3)
- [x] Make resource reads degrade gracefully on CLI failure (return an error-prefixed content block instead of throwing) (Requirement 3)

## Batching / concurrency hardening

- [x] Add `BATCH_CHUNK_SIZE` (5) and `runCliBatched` to split large explicit-ID calls into sequential chunked CLI invocations for `optimize` and `caption` (Requirement 5)
- [x] Implement `mergeBatchedOutputs` as a generic, command-shape-agnostic merge (concatenate `results`, sum numbers, OR booleans, keep first-seen for everything else) rather than a hardcoded per-command merge (Requirement 5) — regression fix for issue #208 (batched caption previously came back shaped like optimize's output, losing `dryRun`/`skipped` and injecting a bogus `totalSavedBytes`)
- [x] Handle partial chunk failure by recording `{ failures: chunk.length }` and continuing with remaining chunks rather than aborting the whole batch (Requirement 5)
- [x] Expose `concurrency` as a schema field on every bulk-capable tool and forward it as a top-level `--concurrency` flag on each (possibly chunked) CLI invocation (Requirement 4)
- [x] Fix the `optimize` tool's flag/schema mismatch — advertised `format` renamed to `to` to match the actual CLI flag (regression fix for issue #50)
- [x] Add a static schema/CLI-flag parity check so any future flag pushed by a tool handler but not declared on the corresponding CLI subcommand fails CI before shipping (regression fix for issue #110)

## Tests

- [x] `test/unit/mcp.test.ts` — real-subprocess MCP protocol round-trip tests via the actual SDK client/stdio transport: full tool listing, exact 4-resource listing, schema-shape spot checks, `concurrency` field presence on bulk tools, `delete`/`posts_delete` force-without-confirm rejection, `optimize`'s `to`-not-`format` regression
- [x] `test/unit/mcp-schema-cli-parity.test.ts` — static source-parsing guard that every tool-advertised flag exists on the real CLI subcommand's `--help` output
- [x] `test/unit/mcp-batch-merge.test.ts` — unit tests of `mergeBatchedOutputs` covering caption-shaped output, optimize-shaped output, and a failed-chunk-only scenario
- [x] `test/unit/rest-adapter.test.ts` — mocked-`fetch` tests for `context=edit` raw-field usage in reference scanning and `getMedia`
- [x] `test/unit/rest-adapter-list.test.ts` — in-process fake WP REST server (`Bun.serve()`) tests for whole-library size sort and exact-MIME-type filtering
- [x] `test/unit/wp-cli.test.ts`, `wp-cli-getmedia.test.ts`, `wp-cli-references.test.ts`, `wp-cli-replace.test.ts` — mocked-SSH `WpCliAdapter` command-construction, meta-absent-vs-failure disambiguation, block-ID matching, and replace-in-place sequencing/rollback-safety tests
- [x] `test/unit/ssh.test.ts` — SSH helper and `AdapterResolver` behavior across SSH config shapes
- [x] `test/unit/self-invoke.test.ts` — dev/tarball/fallback binary-resolution tests backing `invoke.ts`
- [x] `test/integration/wp-rest.test.ts` — live Dockerized-WordPress tests of `RestAdapter` CRUD/reference-finding/error-translation, plus an explicit `AdapterResolver` capability-report assertion for a REST-only site
