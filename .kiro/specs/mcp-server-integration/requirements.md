# MCP Server Integration

Backfilled spec documenting already-shipped functionality.

## Overview

localpress ships a first-party [Model Context Protocol](https://modelcontextprotocol.io) server (`localpress mcp`, implemented in `src/cli/mcp/`) that exposes the CLI's full capability surface — media processing, AI vision, posts/pages CRUD, accessibility audit, time-machine undo, migration — as typed tools and resources for any MCP-speaking agent host (Claude Desktop, Cursor, VS Code, Kiro, etc.). It exists because, per `CLAUDE.md`'s locked "Agent integration" decision, agent hosts wanted one typed tool surface that talks straight to the CLI's capability layer (dry-run semantics, capability resolution, undo snapshots) rather than re-deriving REST calls themselves; a markdown skill alone was not enough. The server does not talk to WordPress directly — every tool call spawns the same `localpress` binary as a child process with `--json --quiet` and parses its stdout, so the MCP surface and the CLI's `--json` contract can never drift apart.

Underneath the CLI (and therefore underneath the MCP server), a small adapter/resolver layer in `src/adapters/` abstracts *how* localpress talks to a given WordPress site: always-available REST + Application Passwords (`RestAdapter`), or opt-in WP-CLI over SSH (`WpCliAdapter`) for operations REST structurally cannot perform (true in-place file replacement, thumbnail regeneration, orphan pruning, exhaustive reference scanning). An `AdapterResolver` picks the best adapter per operation from a declared `Capability` set and throws a typed `CapabilityUnavailableError` when nothing can satisfy a request. This is the backbone the other backfilled command specs run through whenever they're invoked via MCP.

## Requirements

### Requirement 1: Typed tool schemas mirroring CLI commands

**User Story:** As an MCP-speaking agent, I want every localpress capability exposed as a typed tool with a Zod-validated input schema, so that I can discover available operations and their parameters without reading CLI `--help` text or guessing flag names.

**Acceptance Criteria:**
- WHEN the MCP server starts THE SYSTEM SHALL register one tool per CLI capability area (setup/config, discovery, processing, AI vision, round-trip/low-level, time-machine, watch status, content management, and composite convenience tools) via `server.registerTool()` in `src/cli/mcp/tools.ts`.
- WHEN a tool is registered THE SYSTEM SHALL declare its input schema using Zod (`z.object`-shaped field maps), with field names in camelCase that map to the CLI's kebab-case flags (e.g. `maxWidth` → `--max-width`).
- WHEN an agent lists tools THE SYSTEM SHALL return each tool's `title`, `description`, and `inputSchema` so the schema itself documents defaults, enums, and constraints (e.g. `quality: z.number().int().min(1).max(100)`).
- IF a tool's handler pushes a `--flag` onto the CLI argv THEN THE SYSTEM SHALL ensure that flag is actually declared on the corresponding CLI subcommand (enforced by `test/unit/mcp-schema-cli-parity.test.ts`, which statically parses `tools.ts` and checks each flag against the subcommand's `--help` output).
- WHEN a tool accepts a `site` argument THE SYSTEM SHALL treat it as optional; WHEN `site` is omitted THE SYSTEM SHALL use the active site from config (documented in the server's `instructions` string).

### Requirement 2: Structured JSON results from every tool call

**User Story:** As an MCP agent, I want tool results returned as structured JSON alongside human-readable text, so that I can programmatically consume fields (counts, IDs, byte savings) without re-parsing prose.

**Acceptance Criteria:**
- WHEN a CLI invocation succeeds and its stdout is a JSON object THE SYSTEM SHALL return it in the MCP tool result's `structuredContent` field, and also render it as a text block in `content`.
- WHEN a CLI invocation succeeds and its stdout is a JSON array THE SYSTEM SHALL wrap it as `{ items: [...] }` before setting `structuredContent`, since the MCP protocol requires `structuredContent` to be an object.
- WHEN the CLI writes non-empty stderr alongside a successful exit THE SYSTEM SHALL append it to the text content under a `--- stderr ---` separator rather than discarding it.
- IF the CLI exits non-zero THEN THE SYSTEM SHALL set `isError: true` on the tool result and include the exit code and stderr/stdout in the text content.
- WHEN `invokeCli` parses stdout THE SYSTEM SHALL first attempt `JSON.parse`, THEN fall back to parsing as newline-delimited JSON (one record per line), THEN fall back to raw text if neither succeeds.

### Requirement 3: Capability and state discovery via MCP resources

**User Story:** As an MCP agent, I want to read localpress's configured sites, cumulative stats, backend capabilities, and undo history as passive resources, so that I can build context before deciding which tool to call, without spending a tool-call round trip.

**Acceptance Criteria:**
- WHEN the MCP server starts THE SYSTEM SHALL register exactly four resources in `src/cli/mcp/resources.ts`: `localpress://sites`, `localpress://stats`, `localpress://capabilities`, and `localpress://history`.
- WHEN `localpress://sites` is read THE SYSTEM SHALL return the output of `localpress sites --json` (configured sites with the active one marked).
- WHEN `localpress://stats` is read THE SYSTEM SHALL return the output of `localpress stats --json` for the active site.
- WHEN `localpress://capabilities` is read THE SYSTEM SHALL return the output of `localpress doctor --json`, i.e. the `AdapterResolver`'s per-capability report of which adapters are available and preferred.
- WHEN `localpress://history` is read THE SYSTEM SHALL return the output of `localpress history --json` (recent time-machine sessions/snapshots).
- IF the underlying CLI invocation for a resource fails THEN THE SYSTEM SHALL still return a resource content block, with the error text prefixed by `Error (exit <code>):` rather than throwing and breaking the resource read.

### Requirement 4: Concurrency control on bulk operations

**User Story:** As an agent running a bulk operation (optimize, caption, export, import, etc.) against a large media library, I want to control how many items are processed in parallel within a single CLI invocation, so that I can trade off speed against system/API load.

**Acceptance Criteria:**
- WHEN a bulk-capable tool (`optimize`, `convert`, `resize`, `remove_bg`, `caption`, `export`, `import`, and others that process multiple attachments) is registered THE SYSTEM SHALL expose a `concurrency` field in its input schema.
- WHEN `concurrency` is provided THE SYSTEM SHALL forward it as a top-level `--concurrency <n>` flag on the spawned CLI invocation (before the subcommand, per commander's global-option placement), via `invokeCli`'s `concurrency` option.
- WHEN `concurrency` is omitted THE SYSTEM SHALL NOT pass `--concurrency`, leaving the CLI's own default (CPU count − 1) in effect.
- IF a tool batches a large ID set into multiple sequential CLI invocations (Requirement 5) THEN THE SYSTEM SHALL still forward the same `concurrency` value to every chunked invocation.

### Requirement 5: Batching large ID sets to avoid MCP timeouts

**User Story:** As an agent asking to process many attachments by explicit ID in one tool call, I want the server to transparently split the work into smaller CLI invocations, so that a single slow item (e.g. a 30-second Ollama caption call) doesn't blow the MCP host's per-call timeout for the whole batch.

**Acceptance Criteria:**
- WHEN a tool that supports batching (`optimize`, `caption`) receives an explicit `ids` array longer than `BATCH_CHUNK_SIZE` (5) THE SYSTEM SHALL split it into sequential chunks of at most 5 IDs and invoke the CLI once per chunk via `runCliBatched`.
- WHEN chunks are processed THE SYSTEM SHALL run them sequentially (not in parallel with each other), passing the same non-ID arguments (quality, model, language, etc.) and the same `concurrency`/`site` values to each chunk.
- WHEN all chunks complete THE SYSTEM SHALL merge their per-chunk JSON output into one object via `mergeBatchedOutputs`, which concatenates `results` arrays, sums numeric fields, ORs boolean fields, and preserves any other field's first-seen value — without hardcoding any single command's JSON shape (so caption's `dryRun`/`skipped` fields and optimize's `totalSavedBytes` are each preserved as-is rather than coerced into one shared shape).
- IF one chunk's CLI invocation fails THEN THE SYSTEM SHALL record that chunk's failure count (`{ failures: chunk.length }`) and its stderr, continue processing the remaining chunks, and include the partial-failure detail in the final merged result rather than aborting the whole batch.
- WHEN an `ids` array is at or below `BATCH_CHUNK_SIZE` THE SYSTEM SHALL invoke the CLI once, unbatched.

### Requirement 6: REST-vs-WP-CLI capability resolution

**User Story:** As a developer or agent operating against a WordPress site, I want localpress to automatically pick the best available backend (REST or WP-CLI-over-SSH) for each operation, so that I get the fastest/most-capable path without having to know which adapter supports what.

**Acceptance Criteria:**
- WHEN a `SiteConfig` has valid SSH config (`host`, `user`, `wpPath` all present, per `isWpCliAvailableForSite`) THE SYSTEM SHALL construct both a `WpCliAdapter` and a `RestAdapter` for that site in `AdapterResolver`; WHEN SSH config is absent or incomplete THE SYSTEM SHALL construct only a `RestAdapter`, which is always available (Application Password auth is universal).
- WHEN `AdapterResolver.resolve(capability)` or `.tryResolve(capability)` is called for a capability in the read/write-heavy set (`list`, `get`, `upload`, `update-meta`, `delete`, `fast-references`) THE SYSTEM SHALL prefer the REST adapter over WP-CLI even when both support it, because WP-CLI-over-SSH has per-item round-trip overhead that makes these operations slow.
- WHEN `AdapterResolver.resolve(capability)` or `.tryResolve(capability)` is called for any other capability (`replace-in-place`, `regenerate-thumbnails`, `prune-orphans`, `full-references`, `find-unattached`) THE SYSTEM SHALL prefer WP-CLI over REST when both are available, since only WP-CLI implements them.
- IF no configured adapter supports the requested capability THEN `resolve()` SHALL throw an `Error`, and `tryResolve()` SHALL return `null` instead of throwing.
- WHEN `localpress doctor` (and therefore the `localpress://capabilities` MCP resource, and the `doctor` MCP tool) is invoked THE SYSTEM SHALL report, per capability, which adapters support it and which one would currently be chosen (`AdapterResolver.capabilityReport()`).

### Requirement 7: Graceful degradation when a capability is unavailable

**User Story:** As a user or agent on a REST-only site (no SSH configured), I want operations that require WP-CLI to fail with a clear, actionable message rather than a cryptic error or silent no-op, so that I understand what's missing and what my options are.

**Acceptance Criteria:**
- WHEN `RestAdapter.replaceInPlace()` is called THE SYSTEM SHALL throw `CapabilityUnavailableError` with a message explaining that true in-place replacement needs WP-CLI over SSH or the Enable Media Replace plugin, and that callers fall back to a new-attachment upload unless `--strict` is passed.
- WHEN `RestAdapter.regenerateThumbnails()`, `.pruneOrphans()`, or `.findUnattached()` is called THE SYSTEM SHALL throw `CapabilityUnavailableError` naming the unsupported capability and the `rest` adapter.
- WHEN `RestAdapter.findReferences(id, 'full')` is called THE SYSTEM SHALL throw `CapabilityUnavailableError`, explaining that only `'fast'` scope (featured images + Gutenberg block IDs) is available without WP-CLI.
- IF a non-force `RestAdapter.delete()` call fails because the site lacks `MEDIA_TRASH` support (REST returns `rest_trash_not_supported` or HTTP 501) THEN THE SYSTEM SHALL translate that into a message instructing the caller to re-run with `--force`, rather than surfacing the raw WordPress REST error.
- WHEN `CapabilityUnavailableError` propagates up through a CLI command THE SYSTEM SHALL let it reach `main()`'s error handling (per `CLAUDE.md`'s "capability resolution" convention: use `resolver.tryResolve()` and handle the error gracefully rather than assuming a capability is present).

### Requirement 8: Destructive-operation safety gates at the MCP layer

**User Story:** As an agent host operator, I want permanent-deletion tool calls to require an explicit double-confirmation, so that a single hallucinated or malformed tool call from an agent can't irreversibly destroy content.

**Acceptance Criteria:**
- WHEN the `delete` tool is called with `force: true` and `confirm` is not also `true` THE SYSTEM SHALL return an error result (`isError: true`) explaining that `confirm: true` is required alongside `force: true`, without invoking the underlying CLI at all.
- WHEN the `posts_delete` tool is called with `force: true` and `confirm` is not also `true` THE SYSTEM SHALL likewise refuse without invoking the CLI.
- WHEN `force` is omitted or `false` THE SYSTEM SHALL proceed with the CLI's default (trash) behavior without requiring `confirm`.

### Requirement 9: Process-isolated CLI invocation with bounded execution time

**User Story:** As an MCP host, I want each tool call to run in an isolated child process with a hard timeout, so that a hung or runaway operation (e.g. a stalled SSH connection or a stuck Ollama call) can't block the server indefinitely.

**Acceptance Criteria:**
- WHEN `invokeCli` spawns the CLI THE SYSTEM SHALL always append `--json` and `--quiet` if not already present, so every tool call gets machine-parseable output with info-level chatter suppressed.
- WHEN a `site` or `concurrency` value is provided THE SYSTEM SHALL prepend them as top-level flags (`--site`, `--concurrency`) before the subcommand args, since commander expects global options ahead of the subcommand.
- WHEN a spawned CLI invocation exceeds its timeout (default 10 minutes) THE SYSTEM SHALL send `SIGTERM`; IF the child has not exited within 8 seconds of `SIGTERM` THEN THE SYSTEM SHALL escalate to `SIGKILL`.
- WHEN resolving which binary to spawn THE SYSTEM SHALL use `getSelfBin`/`isDevMode` to pick the right invocation form for dev mode (`bun <script>`), a tarball install (`LOCALPRESS_BIN` wrapper), or a `localpress` binary on `PATH`, so the MCP server works identically whether it's built from source or run as a distributed binary.

### Requirement 10: Composite convenience tools for common agent workflows

**User Story:** As an agent doing an initial health check or resolving a WordPress media URL back to an attachment, I want a single tool call that combines multiple underlying CLI commands, so that I avoid unnecessary round trips.

**Acceptance Criteria:**
- WHEN the `health_check` tool is called THE SYSTEM SHALL run `doctor`, `stats`, and `audit --missing-alt` concurrently (via `Promise.all`) and return their combined results as one structured object, with each sub-result's own error (if any) nested under its key rather than failing the whole call.
- WHEN the `search_by_url` tool is called with a WordPress media URL THE SYSTEM SHALL extract the filename (stripping the extension) from the URL path and search the library for it via `list --search <filename> --limit 5`.
- IF the filename cannot be extracted from the given URL THEN THE SYSTEM SHALL return an error result rather than invoking the CLI with an empty search term.
