# Image Processing Engine

Backfilled spec documenting already-shipped functionality.

This subsystem is localpress's core media-compression pipeline: the `optimize`, `convert`, and `resize` CLI commands, the framework-agnostic image engine that backs them (`src/engine/image/`), and the browser-based preview UI that lets a human tune parameters before committing changes to WordPress. It exists so a user (or an AI agent driving localpress via the CLI or MCP server) can shrink, reformat, and resize a WordPress media library entirely on local hardware — no cloud image API, no recurring cost — while never corrupting an image (rasterizing SVGs, flattening animations, growing files, or duplicating attachments on re-runs).

### Requirement 1: Compress specific attachments by ID

**User Story:** As a site owner, I want to run `localpress optimize <id> [id...]` against specific attachment IDs, so that I can compress exactly the images I choose without touching the rest of the library.

**Acceptance Criteria:**
- WHEN one or more attachment IDs are passed as positional arguments THE SYSTEM SHALL process them immediately, without requiring `--apply`.
- WHEN an explicit ID fails to fetch (e.g. deleted attachment) THE SYSTEM SHALL report the error for that ID and continue processing the remaining IDs.
- WHEN no IDs, `--all`, or `--unoptimized` are supplied THE SYSTEM SHALL print a usage error and exit with a non-zero code rather than doing nothing silently.

### Requirement 2: Safe-by-default bulk optimization

**User Story:** As a site owner, I want bulk operations (`--all`, `--unoptimized`) to preview what would happen before they touch my media library, so that I don't accidentally re-encode thousands of images by mistake.

**Acceptance Criteria:**
- WHEN `--all` or `--unoptimized` is passed without `--apply` THE SYSTEM SHALL perform a dry run: list the matching items (capped at 20 shown, with a "...and N more" summary) and make no changes.
- WHEN `--apply` is passed alongside `--all` or `--unoptimized` THE SYSTEM SHALL execute the optimization for real.
- WHEN `--unoptimized` is used THE SYSTEM SHALL exclude attachments already recorded with a successful `optimize`, `convert`, or `resize` operation in the local SQLite state, and SHALL treat attachments with no recorded state (e.g. no local DB yet) as unoptimized.
- WHEN `--larger-than <bytes>` is combined with `--all` THE SYSTEM SHALL further filter to attachments at or above that size.
- WHEN bulk-listing media THE SYSTEM SHALL only include MIME types the engine can safely re-encode (`image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/avif`, `image/gif`) and SHALL silently skip anything else (e.g. SVG) rather than attempting to rasterize it.
- WHEN `--json` is passed during a dry run THE SYSTEM SHALL emit a structured `{ dryRun: true, count, items }` payload in addition to (or instead of) human-readable text.

### Requirement 3: Format conversion during optimize, and the dedicated `convert` command

**User Story:** As a site owner, I want to convert images to a more efficient format (e.g. JPEG to WebP) either as part of optimizing or as a standalone step, so that I can modernize my media library's formats.

**Acceptance Criteria:**
- WHEN `--to <format>` is passed to `optimize` THE SYSTEM SHALL encode the output in that format instead of the source format.
- WHEN no `--to`/profile format is given AND a cached `classify` result exists for the attachment THE SYSTEM SHALL apply a smart default: `screenshot`/`diagram` → PNG, `photo`/`illustration` → WebP; an explicit `--to` or profile format SHALL always take precedence over this default.
- WHEN `localpress convert <ids...> --to <format>` is invoked THE SYSTEM SHALL require `--to` to be one of `webp`, `avif`, `jpeg`, `png`, and SHALL reject any other value with a usage error before doing any work.
- WHEN `convert` changes the format of a replaced-in-place attachment THE SYSTEM SHALL pass the new MIME type and file extension through to the replace-in-place call so WordPress metadata and any rewritten references reflect the new format.
- IF the source is an animated image (GIF/WebP with multiple frames) AND the requested target format cannot hold animation (jpeg/png/avif) THEN THE SYSTEM SHALL refuse the conversion for that item (raising an `AnimatedImageError`) and skip it with a warning rather than flattening it to a single frame.
- IF the source format cannot be encoded by the engine (e.g. `image/svg+xml`) THEN THE SYSTEM SHALL raise an `UnsupportedFormatError` and skip the item rather than silently rasterizing it.

### Requirement 4: Resize attachments preserving aspect ratio

**User Story:** As a site owner, I want to cap the maximum width and/or height of my images, so that oversized uploads don't waste bandwidth and page-load time.

**Acceptance Criteria:**
- WHEN `localpress resize <ids...>` is run without `--max-width` or `--max-height` THE SYSTEM SHALL reject the command with a usage error requiring at least one of the two.
- WHEN either or both of `--max-width`/`--max-height` are given THE SYSTEM SHALL resize so the image fits inside that box, preserving aspect ratio, and SHALL NOT enlarge an image that is already smaller than the requested bounds.
- WHEN a resize is applied via replace-in-place AND a `regenerate-thumbnails` capability is available (WP-CLI adapter) THE SYSTEM SHALL regenerate WordPress's thumbnail sizes afterward; IF that capability is unavailable THE SYSTEM SHALL still consider the resize itself successful.

### Requirement 5: Quality and compression-mode control

**User Story:** As a site owner, I want explicit control over compression quality and lossy/lossless mode, so that I can trade off file size against visual fidelity per image or per format.

**Acceptance Criteria:**
- WHEN `--quality <n>` (0-100) is supplied THE SYSTEM SHALL use it for the codec's quality parameter; WHEN omitted THE SYSTEM SHALL apply a per-format default (JPEG 80, WebP 80, AVIF 65, or 100 for lossless).
- WHEN `--mode <lossy|lossless>` is supplied to `optimize` THE SYSTEM SHALL apply that compression mode; IF a value other than `lossy` or `lossless` is given THEN THE SYSTEM SHALL reject the command with a usage error.
- WHEN no `--mode` is given THE SYSTEM SHALL default PNG to `lossless` and every other supported format to `lossy`.
- WHEN the target format has no quality knob (PNG, GIF) THE SYSTEM SHALL ignore `--quality`/`--target-size` for that item and encode using format-appropriate lossless settings (PNG: compressionLevel 9, effort 10 via sharp).

### Requirement 6: Target-size binary search

**User Story:** As a site owner, I want to specify a target file size (e.g. `100kb`) instead of guessing a quality number, so that I can hit a size budget for images used in performance-sensitive contexts.

**Acceptance Criteria:**
- WHEN `--target-size <size>` (e.g. `100kb`, `1.5mb`, `500b`) is passed to `optimize` for a JPEG/WebP/AVIF output in lossy mode THE SYSTEM SHALL binary-search the quality parameter (1-100, up to 8 iterations) to find the highest quality whose output is at or under the target size, stopping early once within 5% of the target.
- IF no quality value produces an output at or under the target size THEN THE SYSTEM SHALL fall back to quality 1 (smallest achievable) and report that the target could not be reached.
- WHEN `--target-size` is combined with a lossless mode or a format without a quality knob (PNG/GIF) THE SYSTEM SHALL skip the binary search and encode normally, since there is no quality parameter to tune.
- IF `--target-size` and `--quality` are both passed to `optimize` THEN THE SYSTEM SHALL reject the command with a usage error, since the two are mutually exclusive. (This check runs only on the apply path, not during a bulk dry run — see design.md.)

### Requirement 7: Dual encoder backends (sharp and jSquash)

**User Story:** As a site owner, I want to choose between sharp's native encoders and the jSquash WASM codecs, so that I can get better PNG compression (OxiPNG) or Squoosh-level codec parity when I need it.

**Acceptance Criteria:**
- WHEN `--encoder sharp` (the default) is used THE SYSTEM SHALL encode JPEG via mozjpeg, PNG via sharp's built-in encoder, WebP/AVIF via sharp's built-in encoders, using sharp (libvips) for all transforms (resize, auto-rotate, metadata strip) as well.
- WHEN `--encoder jsquash` is used on a supported format (jpeg, png, webp, avif) THE SYSTEM SHALL use sharp only for decode/transform, then hand raw RGBA pixels to the corresponding `@jsquash/*` WASM codec for final encoding, and SHALL additionally run OxiPNG optimization on PNG output (falling back to the unoptimized PNG if OxiPNG fails).
- IF `--encoder jsquash` is requested for a format jSquash doesn't support (currently only gif is excluded) THEN THE SYSTEM SHALL fall back to the sharp encoder for that format.
- WHEN sharp or jSquash codecs are not yet loaded THE SYSTEM SHALL lazy-load them on first use via dynamic `import()` so the CLI's startup time is unaffected by users who never run image commands.
- IF sharp is not installed THEN THE SYSTEM SHALL detect this before attempting any processing and offer to auto-install it (respecting `--yes` to skip the prompt and `--json`/`--quiet` to suppress prompting and fail outright), rather than crashing mid-operation.

### Requirement 8: Replace-in-place with graceful new-attachment fallback

**User Story:** As a site owner, I want optimized/converted/resized images to replace the original attachment in place (same ID, same URL) whenever possible, so that I don't end up with orphaned duplicate attachments and broken references.

**Acceptance Criteria:**
- WHEN a processing command completes AND `--keep-original` is not set AND replace-in-place is not disabled THE SYSTEM SHALL attempt to replace the attachment's file bytes in place via the highest-priority adapter that supports the `replace-in-place` capability (WP-CLI over SSH, when configured).
- IF no adapter supports `replace-in-place` (REST-only sites) OR the attempt throws `CapabilityUnavailableError` THEN THE SYSTEM SHALL fall back to uploading the result as a new attachment and warn that in-place replacement wasn't available — UNLESS the global `--strict` flag is set, in which case THE SYSTEM SHALL raise the error instead of falling back.
- WHEN `--keep-original` (or, for `optimize`, `--no-replace-in-place`) is passed THE SYSTEM SHALL always upload the result as a new attachment, never attempting in-place replacement.
- WHEN a replace-in-place call changes the file format (e.g. PNG→WebP) THE SYSTEM SHALL pass the new MIME type and extension so the adapter can update WordPress's attachment metadata and, when it rewrites post-content references, report the count of rewritten references (or a warning if the rewrite step itself failed while the file replacement still succeeded).
- WHEN `--regenerate-thumbnails` is passed to `optimize` THE SYSTEM SHALL regenerate WordPress's thumbnail sizes after a successful replace-in-place.

### Requirement 9: Idempotent re-runs via SHA-256 hash comparison

**User Story:** As a site owner (or an agent running `optimize --unoptimized --apply` on a schedule), I want re-running optimize on an already-processed attachment to be a no-op, so that repeated runs don't waste time, re-download bandwidth, or double-count savings in stats.

**Acceptance Criteria:**
- WHEN `optimize` downloads an attachment and computes its SHA-256 hash THE SYSTEM SHALL compare it against the previously recorded processing history for that attachment and operation before doing any encoding work.
- WHEN the prior run replaced the file in place (no separate new-attachment ID recorded) THE SYSTEM SHALL skip re-processing if the current live-file hash equals the *previous run's result hash* (not its source hash) — because after an in-place write, the live file IS that prior output.
- WHEN the prior run fell back to uploading a new attachment (REST-only site) THE SYSTEM SHALL skip re-processing if the current source attachment's hash is unchanged from the prior run's source hash, since the original attachment was never touched and re-running would just create another duplicate.
- WHEN the requested options (format, quality, target size, encoder, etc.) differ from the prior run's recorded parameters THE SYSTEM SHALL always re-run regardless of hash match.
- IF the prior recorded run has status `failure` THEN THE SYSTEM SHALL never treat it as a skip condition.
- WHEN `--force` is passed THE SYSTEM SHALL bypass the idempotency skip entirely and re-process even an exact match.
- WHEN a user runs `localpress undo` to restore an attachment's original bytes, a subsequent `optimize` run SHALL detect the restored hash no longer matches the recorded result hash and re-optimize.
- WHEN the optimized output would be larger than or equal to the source AND no real format conversion was requested (no `--to`, profile format, or smart default that differs from the source format) THE SYSTEM SHALL skip uploading that result, recording it as a `skipped` (not `success`) processing-history entry so future `--unoptimized` runs don't reselect it, while still allowing a later run with different options (e.g. a different `--to`) to reprocess it.

### Requirement 10: Browser-based preview before applying (`optimize --preview`)

**User Story:** As a site owner, I want to visually compare original vs. optimized output and adjust quality/format/resize parameters in a browser before committing, so that I can be confident about the trade-off before overwriting a live attachment.

**Acceptance Criteria:**
- WHEN `optimize <id> --preview` is run with exactly one attachment ID THE SYSTEM SHALL download the source image, start a local HTTP preview server on `127.0.0.1` (auto-assigned port unless `--preview-port` is given), and open it in the default browser.
- IF `--preview` is combined with zero IDs, multiple IDs, or bulk flags THEN THE SYSTEM SHALL reject the command with a usage error, since preview operates on exactly one attachment.
- WHEN the preview UI's "Generate Preview" action is triggered THE SYSTEM SHALL re-run the image engine in-process with the browser-supplied parameters (format, quality, encoder, max-width/height) and return updated stats (before/after size, saved bytes/ratio, applied steps) without touching WordPress.
- WHEN the preview UI's "Apply & Upload" action is triggered THE SYSTEM SHALL commit the last-processed result using the same replace-in-place-with-fallback logic as the non-preview path, record it in local processing history exactly like a normal run, and return fresh post-apply metadata for the UI to display.
- WHEN configured optimization profiles exist THE SYSTEM SHALL expose them to the preview UI (via `/api/meta`) so the user can pick a profile that pre-fills quality/format/encoder/resize fields; WHEN `--profile` was also passed on the CLI THE SYSTEM SHALL pre-select that profile in the UI.
- WHEN every request to the preview server (other than the initial page load) arrives THE SYSTEM SHALL require a per-session token (delivered only via the URL fragment, never sent to the server by browsers) and a `Host` header matching the server's own bound port, rejecting anything else with a generic 404 so a malicious page or DNS-rebinding attempt cannot reach the state-changing endpoints or read the private image bytes.
- WHEN the browser tab is closed (WebSocket disconnects and does not reconnect within a short grace period) OR no activity occurs for the configured idle timeout (default 10 minutes) THEN THE SYSTEM SHALL shut down the preview server and resolve the command as "not applied" (unless apply already happened).
- WHEN the user clicks "Cancel" in the UI THE SYSTEM SHALL shut down the server without applying any changes.

### Requirement 11: Named optimization profiles

**User Story:** As a site owner, I want to save a reusable set of optimization parameters (e.g. "hero": quality 75, WebP, max-width 1920) under a name, so that I don't have to re-type flags for common use cases.

**Acceptance Criteria:**
- WHEN `--profile <name>` is passed to `optimize` AND the named profile exists in config THE SYSTEM SHALL apply that profile's quality/format/max-width/max-height/encoder/stripMetadata values as defaults.
- IF `--profile <name>` is passed and no such profile exists THEN THE SYSTEM SHALL print the available profile names (or note that none exist) and exit with a non-zero code rather than proceeding with defaults.
- WHEN both an explicit CLI flag (e.g. `--quality`) and a profile value are present THE SYSTEM SHALL prefer the explicit CLI flag over the profile's value.

### Requirement 12: Local processing history and undo integration

**User Story:** As a site owner, I want every optimize/convert/resize run to be safely reversible, so that a bad batch job doesn't permanently damage my media library.

**Acceptance Criteria:**
- WHEN `optimize`, `convert`, or `resize` is about to overwrite an attachment's bytes THE SYSTEM SHALL capture a pre-write snapshot (source bytes plus metadata: filename, mime type, alt text, title, caption, description, dimensions, size) into the local time-machine store before performing the write, grouped under one session per command invocation.
- WHEN the command invocation finishes THE SYSTEM SHALL close the history session and prune old snapshots down to the configured retention size cap.
- WHEN history is disabled in config THE SYSTEM SHALL skip snapshot capture entirely rather than failing the operation.

### Requirement 13: Result reporting and exit behavior

**User Story:** As a site owner or an agent parsing output programmatically, I want clear success/failure/skip counts and machine-readable output, so that I can act on the results or feed them into automation.

**Acceptance Criteria:**
- WHEN a batch of items finishes processing THE SYSTEM SHALL report counts of processed/converted/resized, failed, and (for convert/resize) skipped items, plus total bytes saved.
- WHEN `--json` is set THE SYSTEM SHALL emit a structured JSON summary (including per-item results) instead of, or in addition to, human-readable log lines.
- IF one or more items failed THEN THE SYSTEM SHALL exit with a non-zero exit code even if other items in the same batch succeeded.
- WHEN an item is skipped due to the animated-source guard or the unsupported-format guard THE SYSTEM SHALL warn and continue rather than counting it as a failure.

### Requirement 14: MCP tool parity

**User Story:** As an AI agent using localpress's MCP server, I want `optimize`, `convert`, and `resize` exposed as typed tools with the same safety semantics as the CLI, so that I can drive image processing without shelling out.

**Acceptance Criteria:**
- WHEN the MCP `optimize` tool is invoked THE SYSTEM SHALL translate its typed arguments (ids, unoptimized, all, quality, to, maxWidth, maxHeight, encoder, profile, stripMetadata, apply, concurrency) into the equivalent `optimize` CLI invocation and SHALL preserve the CLI's dry-run-by-default behavior for bulk modes (`apply` must be explicitly `true` to execute `--all`/`--unoptimized`).
- WHEN the MCP `optimize` tool receives more IDs than the internal batch-chunk size THE SYSTEM SHALL split the request into multiple batched CLI invocations rather than passing an unbounded argument list.
- WHEN the MCP `convert` or `resize` tools are invoked THE SYSTEM SHALL translate their typed arguments into the corresponding CLI invocation, including optional `concurrency` for parallel workers on bulk operations.
