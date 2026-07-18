# Round-trip & Automation

Backfilled spec documenting already-shipped functionality.

This subsystem lets a user or agent take a WordPress media attachment out to a local editor, work on it in a native application (GIMP, Photoshop, Preview, or anything else registered as the system default or passed via `--with`), and have every save synced straight back to WordPress without a manual re-upload step (`localpress edit`). A sibling capability, `localpress watch`, runs the same "detect a local file change → sync to WordPress" loop continuously over an entire directory rather than a single downloaded file, so a designer's export folder (e.g. from Photoshop/Figma) stays mirrored into the WordPress media library as long as the watcher is running. `localpress watch-status` reports on watch history so an agent can tell whether automation is already wired up for a site before starting its own. Together these commands exist because the alternative — download, edit, manually re-upload, manually find and replace the attachment ID — is exactly the kind of repetitive, error-prone loop localpress exists to eliminate.

## Requirement 1: Round-trip edit of a single attachment

**User Story:** As a site editor, I want to open a WordPress media attachment directly in my preferred image editor and have my saves sync back automatically, so that I don't have to manually download, edit, and re-upload the file every time I make a change.

**Acceptance Criteria:**
- WHEN a user runs `localpress edit <id>` THE SYSTEM SHALL fetch the attachment's metadata, download its file bytes, and write them to a local path (a generated temp directory by default, or `--to <dir>` if given).
- WHEN the file has been downloaded THE SYSTEM SHALL open it in the system default application, or in the application named by `--with <app>`, without blocking on the editor process exiting.
- IF `--no-watch` is passed THEN THE SYSTEM SHALL open the file and print the manual `localpress push --replace <id>` command instead of starting a watcher.
- WHEN watching is active THE SYSTEM SHALL wait for the user to press Enter (or Ctrl+C) before stopping, so an arbitrary number of saves can be synced in one session.
- WHEN the watch session ends THE SYSTEM SHALL report the total number of changes synced, and SHALL delete the temporary download directory unless `--keep-file` or `--to` was supplied.

## Requirement 2: Editor auto-detection across platforms

**User Story:** As a user on macOS, Linux, or Windows, I want `localpress edit` to open the downloaded file in whatever application my OS considers the default for that file type, so that I don't have to configure an editor path myself.

**Acceptance Criteria:**
- WHEN no `--with` flag is given and the platform is macOS THE SYSTEM SHALL invoke `open <file>`, deferring to the OS's registered default application (Preview, Photoshop, GIMP, etc.).
- WHEN no `--with` flag is given and the platform is Windows THE SYSTEM SHALL invoke `cmd /c start "" <file>`.
- WHEN no `--with` flag is given and the platform is Linux (or any other) THE SYSTEM SHALL invoke `xdg-open <file>`.
- IF `--with <app>` is given on macOS THEN THE SYSTEM SHALL invoke `open -a <app> <file>`.
- IF `--with <app>` is given on Linux or Windows THEN THE SYSTEM SHALL attempt to run `<app>` directly with the file path as an argument.
- WHEN the editor is launched THE SYSTEM SHALL spawn it detached and unreferenced so localpress's own process can continue (and later exit) independently of the editor's lifetime.

## Requirement 3: Debounced change detection

**User Story:** As a user editing a file in an application that performs multi-step writes (temp file + rename, or delete + recreate), I want localpress to treat a single logical save as one sync, so that I don't get duplicate uploads or uploads of a half-written file.

**Acceptance Criteria:**
- WHEN a watched file emits a filesystem `change` or `add` event THE SYSTEM SHALL wait for a debounce window (default 500ms for `edit`, configurable per call; default 800ms for `watch`, configurable via `--debounce`) before acting, resetting the timer on every new event.
- WHEN the underlying watcher is configured THE SYSTEM SHALL use chokidar's `awaitWriteFinish` (stability threshold equal to the debounce interval, 100ms poll interval) so a file that is still being written is not read mid-write.
- IF a save event arrives while a previous sync for the same file is still in flight THEN THE SYSTEM SHALL queue it and rerun once the in-flight sync completes, collapsing any number of overlapping events into a single rerun against the latest state, rather than dropping or interleaving them.
- WHEN `edit` watches a single downloaded file THE SYSTEM SHALL react to both `change` and `add` chokidar events, since some editors save via delete+recreate rather than in-place write.

## Requirement 4: Content-hash dedup before sync

**User Story:** As a user whose editor touches a file's mtime without changing its bytes (e.g. re-saving unmodified content, or an editor writing metadata-only), I want localpress to skip syncing files that haven't actually changed, so that WordPress doesn't accumulate no-op uploads or replacements.

**Acceptance Criteria:**
- WHEN `watch` processes a file change event THE SYSTEM SHALL compute a SHA-256 hash of the file's current bytes and compare it against the hash stored in the file's watch mapping.
- IF the newly computed hash matches the stored hash THEN THE SYSTEM SHALL treat the event as a no-op and skip uploading or replacing.
- WHEN `edit` syncs a change THE SYSTEM SHALL compute a SHA-256 hash of the changed bytes and persist it as both `source_hash` and `result_hash` in the attachment's processing-history record for that sync.

## Requirement 5: New vs. changed file routing during directory watch

**User Story:** As a user watching a directory of images, I want new files to become new WordPress attachments and edits to existing, previously-synced files to replace the same attachment in place, so that my media library doesn't fill up with duplicate uploads for every edit.

**Acceptance Criteria:**
- WHEN `watch` detects a newly added file (chokidar `add` event) THE SYSTEM SHALL upload it as a new attachment and record a file→attachment mapping.
- WHEN `watch` detects a changed file (chokidar `change` event) AND a watch mapping with a WordPress ID already exists for that file THE SYSTEM SHALL attempt to replace that attachment in place rather than uploading a new one.
- IF replace-in-place is unavailable (no WP-CLI/SSH backend configured) THEN THE SYSTEM SHALL fall back to uploading the changed file as a new attachment and update the mapping to point at the new ID, UNLESS `--strict` is set, in which case THE SYSTEM SHALL skip the file and warn instead of falling back.
- WHEN `--optimize` or `--to <format>` is passed THE SYSTEM SHALL run the optimization/conversion pipeline on the file before upload, and IF the output format differs from the source format THEN THE SYSTEM SHALL rewrite the filename's extension and MIME type to match before uploading or replacing.
- IF a file's MIME type is not optimizable and `--optimize`/`--to` was requested THEN THE SYSTEM SHALL upload the file unmodified and note that optimization was skipped, rather than failing.

## Requirement 6: Persistent file-to-attachment mappings across restarts

**User Story:** As a user who stops and restarts a long-running `watch` process (e.g. after a reboot or a deploy), I want localpress to remember which local files map to which WordPress attachments, so that watch resumes replace-in-place behavior instead of re-uploading everything as new.

**Acceptance Criteria:**
- WHEN `watch` uploads or replaces a file THE SYSTEM SHALL persist a `(site, watch_dir, rel_path) → (file_hash, wp_id)` mapping in the site's SQLite database (`watch_mappings` table, added in schema migration v3).
- WHEN `watch` is started again against the same directory after a restart THE SYSTEM SHALL read existing mappings from SQLite to determine whether a file is "new" or "previously synced," rather than relying on in-memory state.
- WHEN a mapped file is deleted locally and `--delete` was NOT passed THEN THE SYSTEM SHALL warn that the WordPress attachment still exists and SHALL remove the now-stale mapping so a future file at that path is not mistakenly treated as a replace target for the old attachment.
- WHEN a mapped file is deleted locally and `--delete` WAS passed THEN THE SYSTEM SHALL force-delete (skip trash) the corresponding WordPress attachment, first best-effort capturing an undo snapshot of its bytes and metadata, and SHALL remove the mapping.

## Requirement 7: Watch orchestration status reporting

**User Story:** As an agent or user about to start automation on a site, I want to check what directories have previously been watched, so that I don't start a redundant or conflicting watcher.

**Acceptance Criteria:**
- WHEN a user runs `localpress watch-status` THE SYSTEM SHALL query the site's `watch_mappings` table and report, per unique watched directory, the number of mapped files and the timestamp of the most recent mapping update.
- WHEN no watch history exists for the active site THE SYSTEM SHALL say so and suggest `localpress watch <directory>` to start one.
- THE SYSTEM SHALL report `running: false` and `runningDetectionImplemented: false` in all cases, since it has no mechanism (as of this version) to detect whether a `watch` process is currently alive — the report reflects historical mapping data only, not live process state.

## Requirement 8: Fallback and safety behavior during sync

**User Story:** As a user relying on the edit round-trip or a directory watch, I want a failed or degraded sync (missing SSH/WP-CLI capability, transient upload error) to be visible and non-destructive, so that I don't lose track of what did or didn't make it to WordPress.

**Acceptance Criteria:**
- WHEN `edit`'s in-place replace attempt raises `CapabilityUnavailableError` and `--strict` is not set THE SYSTEM SHALL fall back to uploading the changed bytes as a new attachment and warn that in-place replacement was unavailable.
- IF `--strict` is set and replace-in-place is unavailable THEN THE SYSTEM SHALL propagate the failure rather than silently uploading a duplicate.
- WHEN an upload or replace fails during `edit`'s watch loop THE SYSTEM SHALL report the error for that save but SHALL keep watching for subsequent saves rather than exiting the process.
- WHEN `watch` encounters an `AnimatedImageError` or `UnsupportedFormatError` during optimization THE SYSTEM SHALL treat it as a deliberate skip (warn and continue), not a fatal error, so an animated GIF or unsupported file doesn't get flattened or crash the watcher.
- WHEN either command receives SIGINT or SIGTERM THE SYSTEM SHALL close the underlying file watcher, close any open history session and database handle, and exit cleanly rather than leaving the SQLite connection or watcher handle open.
