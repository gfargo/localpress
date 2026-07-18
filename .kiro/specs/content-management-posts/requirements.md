# Content Management — Posts & Delete

Backfilled spec documenting already-shipped functionality.

localpress became a full WordPress content-management tool (not just a media optimizer) in the v2.0 expansion. This subsystem covers two CLI commands — `posts` (list/show/create/update/delete for posts, pages, and custom post types, talking directly to `/wp-json/wp/v2/*`) and `delete` (attachment removal, trash vs. permanent) — plus their MCP tool equivalents (`posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`, `delete`). It exists so an agent or script can manage WordPress content and clean up the media library from the command line or an MCP host, with the same dry-run and undo safety net as the rest of localpress.

### Requirement 1: List posts and pages with filters

**User Story:** As a site operator, I want to list posts, pages, or custom post type entries with common filters, so that I can find content without opening the WordPress admin.

**Acceptance Criteria:**
- WHEN `posts list` is run with no options THE SYSTEM SHALL request post type `post`, order by `date` descending, and return up to 20 items on page 1.
- WHEN `--status`, `--author`, `--search`, or `--category` are supplied THE SYSTEM SHALL pass them through as REST query parameters (`status`, `author`, `search`, `categories`).
- WHEN `--per-page` exceeds 100 THE SYSTEM SHALL cap the request at 100 (WordPress's REST API maximum).
- WHEN `--orderby` or `--order` are supplied THE SYSTEM SHALL sort accordingly (`date`, `title`, `id`, `modified`, `slug`; `asc` or `desc`).
- WHEN `--json` is passed THE SYSTEM SHALL print `{ items, total, totalPages, page }`, where `total`/`totalPages` come from the `X-WP-Total`/`X-WP-TotalPages` response headers.
- WHEN no items match THE SYSTEM SHALL print a plain-language "No posts found" message in human mode rather than an empty table.
- WHEN more pages remain THE SYSTEM SHALL print a hint for the next-page command in human mode.
- WHEN the WordPress API responds with a non-2xx status THE SYSTEM SHALL print the status code and truncated response body and exit with `NetworkError` (4).

### Requirement 2: Show full details for a single post or page

**User Story:** As a site operator or agent, I want to fetch the full content and metadata of one post/page/CPT entry by ID, so that I can inspect or feed it into further processing.

**Acceptance Criteria:**
- WHEN `posts show <id>` is run THE SYSTEM SHALL request the item with `context=edit` (so raw, unfiltered `title`/`content`/`excerpt` are available) rather than the rendered/sanitized form.
- WHEN the ID is not a valid integer THE SYSTEM SHALL exit with `InvalidUsage` (2) before making a network request.
- WHEN `--json` is passed THE SYSTEM SHALL emit `id, title, status, type, date, modified, slug, link, excerpt, author, featuredMedia, content, categories, tags`.
- WHEN human-readable output is used THE SYSTEM SHALL print a truncated excerpt (200 chars) and the content length in characters rather than the full body.
- WHEN `--type` names a custom post type THE SYSTEM SHALL resolve it to its REST base the same way `posts list` does (see Requirement 6).

### Requirement 3: Create a post, page, or custom post type entry

**User Story:** As a site operator or agent, I want to create new content (post, page, or CPT) from the command line, so that I can publish or draft content without a browser.

**Acceptance Criteria:**
- WHEN `posts create` is run THE SYSTEM SHALL require `--title` and default `--status` to `draft` if not supplied, so a bare create never accidentally publishes.
- WHEN `--content-file <path>` is given THE SYSTEM SHALL read the file as UTF-8 content, overriding any `--content` value; a read failure SHALL exit with `InvalidUsage` (2).
- WHEN `--slug`, `--excerpt`, `--featured-image`, `--category`, or `--tag` are given THE SYSTEM SHALL include them in the create request (`--category`/`--tag` accept comma-separated numeric ID lists).
- WHEN `--type` is a custom post type THE SYSTEM SHALL resolve its REST endpoint before posting (Requirement 6).
- WHEN creation succeeds THE SYSTEM SHALL print (or, in `--json` mode, return) `{ action: "created", post: {...} }` including the new post's `id` and `link`.
- IF the WordPress API rejects the request THE SYSTEM SHALL print the status and response body and exit with `NetworkError` (4).
- WHEN creating an entry, `create` SHALL NOT support `--dry-run` (creation is treated as a normal, non-bulk action — only `update` and `delete` route through the dry-run helper).

### Requirement 4: Update an existing post, page, or custom post type entry

**User Story:** As a site operator or agent, I want to change specific fields of an existing post without resending the whole object, so that partial edits are safe and cheap.

**Acceptance Criteria:**
- WHEN `posts update <id>` is run with one or more of `--title`, `--content`/`--content-file`, `--status`, `--slug`, `--excerpt`, `--featured-image`, `--category`, `--tag` THE SYSTEM SHALL send only the fields explicitly provided.
- IF none of those fields are supplied THE SYSTEM SHALL refuse with an error and exit `InvalidUsage` (2) rather than sending an empty PATCH.
- WHEN `--slug` or `--excerpt` is passed as an explicit empty string THE SYSTEM SHALL still include it in the update body (fields are checked with `!== undefined`, not truthiness), so a field can be intentionally cleared.
- WHEN the global `--dry-run` flag is set (and `--apply` is not) THE SYSTEM SHALL preview the change — printing which fields would be updated — and make no network request. In `--json` mode it SHALL print `{ dryRun: true, action: "update", id, fields }`.
- WHEN `--apply` is passed THE SYSTEM SHALL execute even if `--dry-run` is also present (apply always wins).
- WHEN the update succeeds THE SYSTEM SHALL report `{ action: "updated", post: {...} }`.
- WHEN the ID is not a valid integer THE SYSTEM SHALL exit `InvalidUsage` (2) before any network call.

### Requirement 5: Trash or permanently delete a post, page, or custom post type entry

**User Story:** As a site operator or agent, I want to remove a post either recoverably (trash) or permanently, so that cleanup matches the intended risk level.

**Acceptance Criteria:**
- WHEN `posts delete <id>` is run without `--force` THE SYSTEM SHALL move the item to WordPress trash (no `force` query parameter sent).
- WHEN `--force` is passed THE SYSTEM SHALL append `?force=true` to the DELETE request, permanently removing the item.
- WHEN the global `--dry-run` flag is honored (and `--apply` is not set) THE SYSTEM SHALL preview the action without calling the API, reporting whether it *would* trash or permanently delete, and in `--json` mode return `{ dryRun: true, action: "trash"|"delete", id }`.
- WHEN the delete succeeds THE SYSTEM SHALL report `{ action: "trashed"|"deleted", id }` in JSON, or an equivalent human-readable line.
- WHEN the ID is not a valid integer THE SYSTEM SHALL exit `InvalidUsage` (2) before any network call.
- Note: unlike attachment `delete`, `posts delete` does NOT capture a time-machine snapshot before deleting — post content is not restorable via `localpress undo`. This is an asymmetry with attachment delete; it is not called out as an explicit warning to the user in the command's own output (verified from source; not documented further in-app).

### Requirement 6: Custom post type REST endpoint resolution

**User Story:** As a site operator managing a custom post type whose REST base differs from its registered slug, I want `--type <slug>` to still work, so that I don't need to know WordPress's internal `rest_base` mapping.

**Acceptance Criteria:**
- WHEN `--type` is `post` or `page` THE SYSTEM SHALL use the hardcoded `/posts` or `/pages` endpoint without any network lookup.
- WHEN `--type` names any other value THE SYSTEM SHALL query `/wp-json/wp/v2/types/<type>` to find its registered `rest_base`, and use `/​<rest_base>` (falling back to the type slug itself if `rest_base` is absent).
- IF that lookup 404s (the type slug itself isn't a registered type name) THE SYSTEM SHALL fall back to scanning the full `/wp-json/wp/v2/types` collection for a registered type whose `rest_base` equals the given value, so callers may pass either the type slug or its `rest_base`.
- IF neither lookup succeeds THE SYSTEM SHALL raise a `PostTypeError` with `InvalidUsage` (2) and a message suggesting `posts list --type <slug>` to check the registration.
- IF the resolved type has `show_in_rest: false` THE SYSTEM SHALL raise a `PostTypeError` with `CapabilityUnavailable` (6), since such a type cannot be managed via the REST API at all.
- WHEN a type has been resolved once THE SYSTEM SHALL cache the resolution (endpoint path keyed by the requested type string) for the remainder of the process, avoiding repeat network lookups within a single command invocation.

### Requirement 7: Delete media attachments — trash by default, permanent with --force

**User Story:** As a site operator or agent, I want to remove one or more media attachments from the library, defaulting to a recoverable action, so that accidental bulk deletes don't destroy files irreversibly.

**Acceptance Criteria:**
- WHEN `delete <ids...>` is run without `--force` THE SYSTEM SHALL move each attachment to WordPress trash (recoverable from the WP admin).
- WHEN `--force` is passed THE SYSTEM SHALL permanently delete each attachment and its underlying file.
- WHEN one or more of the given IDs is not a valid integer THE SYSTEM SHALL exit `InvalidUsage` (2) before processing any of them.
- `delete` SHALL NOT offer `--all` or `--unoptimized` bulk-selection flags — callers must pre-enumerate explicit attachment IDs (e.g. from `audit --duplicates --json`), by design, because of the operation's blast radius.
- WHEN the underlying WordPress site lacks `MEDIA_TRASH` support and a non-force delete is attempted, causing a `rest_trash_not_supported` (HTTP 501) response, THE SYSTEM SHALL translate this into an actionable error suggesting `--force` rather than surfacing the raw REST error.
- WHEN the global dry-run is active (and `--apply` is not set) THE SYSTEM SHALL list which IDs would be deleted and in what mode (trash/permanent), performing no network calls, snapshot captures, or database writes.
- WHEN multiple IDs are given and some fail THE SYSTEM SHALL continue processing the remaining IDs, collect a per-ID result (`deleted` or `failed` with a reason), and exit with code 1 if any failures occurred.
- WHEN `--json` is passed THE SYSTEM SHALL emit `{ deleted, failures, force, results: [{ id, filename, status, force, reason? }] }`.

### Requirement 8: Time-machine snapshot before attachment delete

**User Story:** As a site operator, I want a real chance to recover a deleted attachment's file bytes and metadata, so that a mistaken `delete --force` isn't automatically catastrophic.

**Acceptance Criteria:**
- WHEN history is enabled (the default; `history.enabled` is not explicitly `false` in config) AND a non-dry-run `delete` is executed THE SYSTEM SHALL open one history session per invocation and, for each attachment, attempt to download its current file bytes and capture a binary snapshot (SHA-256 hash + metadata: filename, mimeType, altText, title, caption, description, width, height, sizeBytes) before issuing the WordPress delete request.
- IF the snapshot download fails (network error, non-2xx response, attachment already inaccessible) THE SYSTEM SHALL log a warning that undo will not restore the file, and still proceed with the delete — a snapshot failure must never block the deletion the user asked for.
- WHEN the delete completes THE SYSTEM SHALL upsert the attachment's last-known state into the local SQLite site database and record a `delete` processing-history row (status `success` or `failed`, duration, params).
- WHEN `localpress undo` is later used to restore a deleted attachment THE SYSTEM SHALL re-upload the captured bytes as a new attachment (WordPress assigns a new ID on re-upload) — this is inherently different from undoing an in-place metadata/file change, and callers should expect any content that referenced the old attachment ID to need reference rewriting afterward.

### Requirement 9: Dry-run consistency across posts/delete via the shared resolver

**User Story:** As a user of any localpress destructive command, I want `--dry-run` and `--apply` to behave identically everywhere, so that I can trust the safety net without re-learning per-command semantics.

**Acceptance Criteria:**
- WHEN any of `posts update`, `posts delete`, or `delete` check whether to preview vs. execute THE SYSTEM SHALL call the shared `resolveDryRun(parentOpts, defaultDryRun)` helper rather than reading `options.dryRun` ad hoc.
- WHEN `--apply` is passed THE SYSTEM SHALL always execute, regardless of any `--dry-run` also present.
- WHEN neither `--dry-run` nor `--apply` is passed THE SYSTEM SHALL use each command's own default posture — `false` (execute) for `posts update`, `posts delete`, and `delete`, since these commands operate on explicit, caller-supplied IDs rather than broad `--all`/`--unoptimized` selections.
- WHEN `posts create` is used THE SYSTEM SHALL NOT offer a dry-run preview at all (creation isn't gated by `resolveDryRun` in the current implementation) — this is a real gap relative to update/delete and is called out here rather than assumed away.
- `posts list` and `posts show` are read-only and SHALL NOT be affected by `--dry-run`/`--apply` in any way.

### Requirement 10: MCP tool parity with guarded permanent deletion

**User Story:** As an AI agent operating through the MCP server, I want the same posts/delete capabilities as the CLI, with an explicit extra confirmation step for irreversible actions, so that an agent can't accidentally trigger a permanent deletion from a single ambiguous instruction.

**Acceptance Criteria:**
- THE SYSTEM SHALL expose MCP tools `posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`, and `delete`, each translating its typed arguments into the equivalent CLI invocation (`runCli`) and returning the CLI's JSON output.
- WHEN the `delete` or `posts_delete` MCP tool is called with `force: true` but `confirm` is not also `true` THE SYSTEM SHALL refuse the call, returning an error result whose text mentions `confirm`, without invoking the CLI at all.
- WHEN `force: true` and `confirm: true` are both supplied THE SYSTEM SHALL proceed to the underlying CLI command with `--force`.
- Note: none of `posts_list`, `posts_show`, `posts_create`, `posts_update`, `posts_delete`, or `delete` expose a `dryRun` argument in their MCP input schema (unlike, e.g., `rename`) — an MCP-driven call always runs in each underlying CLI command's default posture (execute, per Requirement 9), since there is no way for an MCP caller to pass `--dry-run` through to these specific tools today.
