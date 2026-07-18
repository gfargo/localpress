# Setup & Site Management

Backfilled spec documenting already-shipped functionality.

This subsystem is the entry point to localpress: it lets a user (or an agent driving the CLI) connect one or more WordPress sites, inspect what capabilities are available against each, manage local configuration (including reusable optimization profiles), keep the CLI binary itself up to date, and generate shell completions. Everything else in localpress (media processing, content management, AI enrichment) depends on a site having been configured here first, and on `doctor`/the capability resolver to know which backend (REST vs. WP-CLI) can serve a given operation.

The commands covered are `init`, `sites` (with `add`/`use`/`remove`/`run` subcommands), `doctor`, `config` (with `get`/`set`/`list`/`set-profile`/`get-profile`/`list-profiles`/`remove-profile` subcommands), `update`, and `completions`.

## Requirement 1: Interactive site connection wizard

**User Story:** As a new user, I want an interactive step-by-step wizard when I run `localpress init` in a terminal, so that I can connect my WordPress site without knowing the CLI's flag names up front.

**Acceptance Criteria:**
- WHEN `localpress init` is run with no `--url` flag and stdin is a TTY and `--non-interactive` was not passed THE SYSTEM SHALL render an Ink-based wizard (`InitWizard`) that prompts in order for site URL, site name (defaulting to the URL's hostname), WordPress username, and Application Password (masked input).
- WHEN CLI flags (`--name`, `--url`, `--username`, `--app-password`) are supplied alongside an interactive run THE SYSTEM SHALL pre-fill the corresponding wizard steps and skip directly to the first field still missing, cascading in the order url → name → username → password → connection test.
- WHEN `--name` matches an already-configured site THE SYSTEM SHALL pre-fill the wizard's fields from that site's existing stored values (URL, name, username, password) so re-running `init` can be used to rotate credentials.
- IF the Ink wizard fails to render (e.g. missing dependency, non-interactive CI environment misdetected as a TTY) THEN THE SYSTEM SHALL fall through to the non-interactive flag-based path instead of crashing.
- WHEN the wizard reaches the connection-test step THE SYSTEM SHALL send an authenticated `GET /wp-json/wp/v2/users/me` request using HTTP Basic auth built from `username:appPassword`, and on success display the authenticated user's display name.
- IF the connection test returns HTTP 401 THEN THE SYSTEM SHALL display an authentication-failed message; IF it returns any other non-OK status or the request throws THEN THE SYSTEM SHALL display a connection-failed message and route the user back to the error step.
- WHEN the connection test succeeds THE SYSTEM SHALL persist the site into the config file, set it as the active site if no active site is already set, and display a capability report (REST/WP-CLI/MCP adapter availability plus the per-capability matrix) before exiting.

## Requirement 2: Optional SSH / WP-CLI configuration during init

**User Story:** As a user who wants the fuller capability set (replace-in-place, thumbnail regeneration, orphan pruning, full reference scans), I want the init wizard to offer SSH configuration after the REST connection succeeds, so that I can unlock WP-CLI-backed capabilities without a separate command.

**Acceptance Criteria:**
- WHEN the REST connection test succeeds and any capability is unavailable (no `preferredAdapter`) THE SYSTEM SHALL prompt "Configure SSH now? [y/N]" after showing the capability report.
- IF the user declines (presses `n`/`N`/Enter) THEN THE SYSTEM SHALL exit without attempting SSH configuration, leaving the site usable via REST only.
- IF the user accepts THEN THE SYSTEM SHALL prompt in order for SSH host (defaulting to the site URL's hostname), SSH user, SSH port (default `22`), the absolute WordPress root path on the server, and an optional SSH identity file path.
- WHEN SSH details are collected THE SYSTEM SHALL test the connection by running `wp --info` and verifying `wp-config.php` exists at the given WordPress path over SSH, before persisting the SSH config onto the site record.
- IF the SSH connection fails, WP-CLI is not found on the remote host, or `wp-config.php` is missing at the given path THEN THE SYSTEM SHALL show a specific diagnostic message, leave the already-saved REST-only site config untouched, and instruct the user they can retry later via `localpress init --site <name>` or by editing the config file directly.
- WHEN SSH configuration succeeds THE SYSTEM SHALL re-run the capability report with the WP-CLI adapter now available and display it as a "final report" before exiting.

## Requirement 3: Non-interactive / scripted site connection

**User Story:** As an agent or CI script, I want to connect a WordPress site without any interactive prompts, so that `init` can be scripted end-to-end.

**Acceptance Criteria:**
- WHEN `--non-interactive` is passed, or stdin is not a TTY, or `--url` is supplied alongside interactive mode THE SYSTEM SHALL skip the Ink wizard and use the flag-based path.
- IF any of `--url`, `--username`, or `--app-password` is missing in the non-interactive path THEN THE SYSTEM SHALL print a usage error showing the required invocation and exit with code 2.
- WHEN a URL is supplied without a scheme THE SYSTEM SHALL prepend `https://`, and THE SYSTEM SHALL strip any trailing slashes from the normalized URL.
- WHEN `--name` is omitted THE SYSTEM SHALL derive the site name from the URL's hostname.
- IF the resolved site name fails validation (must match `^[A-Za-z0-9._-]+$` and not be `.` or `..`) THEN THE SYSTEM SHALL print an error explaining the allowed character set and exit with code 2, without writing any config.
- WHEN the connection test to `/wp-json/wp/v2/users/me` returns HTTP 401 THEN THE SYSTEM SHALL report an authentication failure (including a link to the site's Application Passwords admin page) and exit with code 5; WHEN it returns any other non-OK HTTP status THEN THE SYSTEM SHALL report the status and exit with code 5; WHEN the request throws (network failure) THEN THE SYSTEM SHALL report the failure and exit with code 4.
- WHEN the connection succeeds and a site of the same name already exists THE SYSTEM SHALL warn that the existing entry (including any SSH config) will be updated rather than overwritten wholesale, preserving fields not covered by the new connection details (notably `ssh` and the original `createdAt`).
- WHEN the site is saved successfully THE SYSTEM SHALL set it as the active site only if no active site was already configured, and print the same REST/WP-CLI/MCP availability and capability-gap summary as the interactive path.

## Requirement 4: List configured sites

**User Story:** As a user managing multiple WordPress sites, I want to see every site localpress knows about and which one is active, so that I can confirm which site my next command will target.

**Acceptance Criteria:**
- WHEN `localpress sites` is run with no subcommand THE SYSTEM SHALL list every configured site's name and URL, marking the active one.
- IF no sites are configured THE SYSTEM SHALL print a message directing the user to run `localpress init`, rather than an empty list.
- WHEN `--json` is set THE SYSTEM SHALL emit an array of `{ name, url, active }` objects instead of the human-readable listing.

## Requirement 5: Add a site non-interactively

**User Story:** As a scripting user, I want a lighter-weight, single-command way to register a site than the full `init` wizard, so that I can add sites from automation without Ink rendering.

**Acceptance Criteria:**
- WHEN `localpress sites add <url>` is run THE SYSTEM SHALL normalize the URL (prepend `https://` if missing, strip trailing slashes) and derive a default site name from the hostname unless `--name` overrides it.
- IF the resolved site name is invalid per the site-name rules THEN THE SYSTEM SHALL error and exit with code 2 without saving.
- IF `--username` or `--app-password` is not supplied THEN THE SYSTEM SHALL error, direct the user to `localpress init` for the interactive alternative, and exit with code 2. `sites add` does not perform a live connection test the way `init` does.
- IF a site with the resolved name already exists THEN THE SYSTEM SHALL error and exit with code 3 rather than silently overwriting it.
- WHEN the site is saved THE SYSTEM SHALL record a `createdAt` ISO timestamp and set it as the active site only if it is the first configured site.

## Requirement 6: Switch the active site

**User Story:** As a user with multiple sites configured, I want to switch which one is active, so that subsequent commands without `--site` target the right one.

**Acceptance Criteria:**
- WHEN `localpress sites use <name>` is run and `<name>` matches a configured site THE SYSTEM SHALL set it as the active site and persist the config.
- IF `<name>` does not match any configured site THE SYSTEM SHALL error, list the known site names when any exist, and exit with code 3.

## Requirement 7: Remove a site

**User Story:** As a user decommissioning a site connection, I want to remove it (and its local cache) cleanly, so that stale credentials and data don't linger.

**Acceptance Criteria:**
- WHEN `localpress sites remove <name>` is run and the site exists THE SYSTEM SHALL delete it from the config and persist the change.
- IF the removed site was the active site THEN THE SYSTEM SHALL set the active site to another remaining configured site (arbitrary selection) or clear it entirely if none remain.
- WHEN removal completes and `--keep-db` was NOT passed THE SYSTEM SHALL delete the site's local SQLite database file along with its `-wal` and `-shm` sidecar files.
- IF `--keep-db` is passed THEN THE SYSTEM SHALL leave the SQLite database on disk.
- IF the database file cannot be deleted THEN THE SYSTEM SHALL warn (not error/exit non-zero) that the user may need to remove it manually.
- IF `<name>` does not match any configured site THEN THE SYSTEM SHALL error and exit with code 3.

## Requirement 8: Run a command across multiple sites

**User Story:** As a user or agent managing a fleet of WordPress sites, I want to run the same localpress command against several sites in one invocation, so that I don't have to repeat `--site` manually per site.

**Acceptance Criteria:**
- WHEN `localpress sites run "<command>"` is invoked THE SYSTEM SHALL require exactly one of `--all-sites` or `--sites <comma-separated names>`; IF both or neither are supplied THEN THE SYSTEM SHALL error and exit with code 2.
- IF `--all-sites` is passed and no sites are configured THEN THE SYSTEM SHALL error and exit with code 3.
- IF `--sites` names any site not present in the config THEN THE SYSTEM SHALL error, list the unknown names plus the known site names, and exit with code 3.
- WHEN the command string is tokenized THE SYSTEM SHALL respect single- and double-quoted segments (so quoted arguments containing spaces stay together), preserve empty-quoted arguments (`""`) as empty tokens, and treat apostrophes inside an unquoted word (e.g. `don't`) as literal characters rather than quote delimiters.
- IF the tokenized command is empty, OR its first token is `sites` (to block `sites run` nesting itself) THEN THE SYSTEM SHALL error and exit with code 2.
- WHEN dispatching to each target site THE SYSTEM SHALL forward the parent invocation's `--apply`, `--dry-run`, and `--strict` top-level flags into each child invocation so bulk operations don't silently degrade to no-op dry-runs.
- WHEN `--timeout <ms>` is not supplied THE SYSTEM SHALL apply a 30-minute per-site timeout by default (longer than the default MCP-tool-call timeout, since bulk operations can run long).
- WHEN all per-site runs complete THE SYSTEM SHALL report, per site, its exit code and stdout/stderr, and print an aggregate `N/total succeeded` summary; WHEN `--json` is set THE SYSTEM SHALL instead emit `{ command, total, succeeded, failed, results }`.
- WHEN any site's run fails THE SYSTEM SHALL exit with a non-zero (1) process exit code overall, even if other sites succeeded.

## Requirement 9: Capability and connection diagnostics (`doctor`)

**User Story:** As a user or an AI agent about to run a bulk operation, I want a single command that reports whether the site is reachable, which backend adapters are available, and which specific capabilities each supports, so that I can decide which operations are safe to attempt.

**Acceptance Criteria:**
- WHEN `localpress doctor` is run with no options THE SYSTEM SHALL report on the active site only; WHEN `--all-sites` is passed THE SYSTEM SHALL report on every configured site.
- IF no sites are configured (and `--all-sites` resolves to zero sites) THEN THE SYSTEM SHALL error and exit with code 3.
- WHEN checking a site THE SYSTEM SHALL attempt a lightweight REST call (list 1 media item) as a connectivity test, and classify failures into authentication errors (401/"Unauthorized"), unreachable-host errors (`ENOTFOUND`/`ECONNREFUSED`), or a generic REST API error, each surfaced as a distinct issue with a severity and a suggested fix.
- IF WP-CLI/SSH is not configured for the site THEN THE SYSTEM SHALL report this as an informational issue naming which capabilities (replace-in-place, full reference scanning) remain unavailable as a result.
- WHEN checking image-processing readiness THE SYSTEM SHALL attempt to lazy-load `sharp` and report whether it's available, since `optimize`/`convert`/`resize`/`remove-bg` depend on it.
- WHEN `--json` is set THE SYSTEM SHALL emit `{ site, url, connectionOk, sharpAvailable, adapters, capabilities, issues, plugins? }` per site; THE `capabilities` array SHALL mirror the `AdapterResolver.capabilityReport()` shape (capability name, preferred adapter or null, all adapters that support it).

## Requirement 10: Plugin detection (`doctor --plugins`)

**User Story:** As a user, I want `doctor` to tell me about installed WordPress plugins that affect localpress's behavior (conflicting optimizers, replace-in-place enablers), so that I understand why a capability is or isn't available and can avoid double-processing images.

**Acceptance Criteria:**
- WHEN `--plugins` (or `--fix`) is passed THE SYSTEM SHALL query `GET /wp-json/wp/v2/plugins?per_page=100` and match the results against a known list (Enable Media Replace, WP-CLI marker, Jetpack, Smush Pro, ShortPixel, EWWW Image Optimizer).
- IF the plugin endpoint returns 401/403 THEN THE SYSTEM SHALL warn that plugin detection requires `manage_options` and continue without failing the whole command.
- IF the plugin endpoint is unavailable or the request otherwise fails THEN THE SYSTEM SHALL silently skip plugin detection (no error surfaced) rather than aborting `doctor`.
- WHEN any of Smush Pro, ShortPixel, or EWWW Image Optimizer is detected active THE SYSTEM SHALL add a warning-severity issue noting it may re-process images after localpress uploads them.
- WHEN Enable Media Replace is detected active THE SYSTEM SHALL add an informational issue noting REST-based replace-in-place is available as a result.
- THE reported plugin list SHALL include only plugins that are active, except Enable Media Replace which is always shown (active or not) since its status directly gates a capability.

## Requirement 11: Auto-remediation (`doctor --fix`)

**User Story:** As a user hitting a fixable setup problem, I want `doctor --fix` to attempt the fix automatically where it safely can, and to give me the exact next command otherwise.

**Acceptance Criteria:**
- IF `sharp` fails to load and `--fix` is passed THEN THE SYSTEM SHALL attempt to auto-install it via `installSharpGlobally()` (bun or npm), and report success, an install-succeeded-but-still-unloadable error, or an install-failed error (neither bun nor npm available) as appropriate.
- IF `--fix` is NOT passed and `sharp` is unavailable THEN THE SYSTEM SHALL surface an error issue with a fix hint pointing at `localpress doctor --fix` or a manual `bun install -g sharp`.
- WHEN `--fix` is passed and any issues were found THE SYSTEM SHALL print each error-severity issue's message and fix suggestion under an "Attempting auto-remediation..." heading.
- IF an authentication issue is present and the connection test failed THEN THE SYSTEM SHALL suggest re-running `localpress sites remove <name>` followed by `localpress init` to re-enter credentials, rather than attempting to silently retry with the same (rejected) credentials.

## Requirement 12: Read and write scalar configuration values

**User Story:** As a user, I want to inspect and change individual configuration settings (active site, default quality/format/concurrency, caption model, history retention) without hand-editing the config file, so that I have a safe, validated interface to persisted settings.

**Acceptance Criteria:**
- WHEN `localpress config get <key>` is run for a supported key THE SYSTEM SHALL print its current value (or, with `--json`, `{ key, value }`); IF the key is not one of the supported settable keys THEN THE SYSTEM SHALL error and exit with code 2 (this includes the case where a supported key like `active-site` has no value set — `get` cannot distinguish "unknown key" from "known key with no value").
- WHEN `localpress config set <key> <value>` is run THE SYSTEM SHALL validate and coerce the value per key: `active-site` must name an already-configured site; `defaults.quality` must parse as an integer in 1–100; `defaults.format` must be one of `webp`/`avif`/`jpeg`/`png`; `defaults.concurrency` must be a positive integer; `defaults.captionModel` must be a non-empty string (trimmed); `history.enabled` must be one of `true`/`false`/`1`/`0`/`yes`/`no` (case-insensitive); `history.maxSizeBytes` must be a non-negative integer.
- IF validation fails for any key THEN THE SYSTEM SHALL print the specific validation error and exit with code 2 without writing the config.
- IF an unsupported key is passed to `set` THEN THE SYSTEM SHALL error, listing the full set of settable keys, and exit with code 2.
- WHEN `localpress config list` is run THE SYSTEM SHALL print the full config as JSON with every site's `appPassword` field replaced by the literal string `***redacted***`, regardless of `--json`.

## Requirement 13: Named optimization profiles

**User Story:** As a user who repeatedly optimizes images with the same settings, I want to save those settings as a named, reusable profile, so that I can invoke `optimize --profile <name>` instead of repeating flags every time.

**Acceptance Criteria:**
- WHEN `localpress config set-profile <name>` is run with at least one of `--description`, `--quality`, `--format`, `--max-width`, `--max-height`, `--encoder`, `--strip-metadata` THE SYSTEM SHALL create the profile if it doesn't exist, or merge the supplied fields into the existing profile if it does (fields not passed are left unchanged).
- IF no profile options are supplied THEN THE SYSTEM SHALL error ("No profile options provided...") and exit with code 2.
- IF `--quality` is outside 1–100 THEN THE SYSTEM SHALL error and exit with code 2; IF `--format` is not one of `webp`/`avif`/`jpeg`/`png` THEN THE SYSTEM SHALL error and exit with code 2; IF `--encoder` is not `sharp` or `jsquash` THEN THE SYSTEM SHALL error and exit with code 2.
- WHEN a profile is created or updated THE SYSTEM SHALL print whether it was newly "Created" or "Updated" (plain-text mode) along with the resulting profile JSON and a usage hint (`optimize --profile <name>`).
- WHEN `localpress config get-profile <name>` is run for an existing profile THE SYSTEM SHALL print its full contents; IF the profile does not exist THEN THE SYSTEM SHALL error, direct the user to `config list-profiles`, and exit with code 2.
- WHEN `localpress config list-profiles` is run THE SYSTEM SHALL list every profile name with a compact summary of its set fields (quality, format, max-width, max-height, encoder, strip-metadata) and its description if present; IF no profiles exist THEN THE SYSTEM SHALL print guidance to create one instead of an empty list.
- WHEN `localpress config remove-profile <name>` is run for an existing profile THE SYSTEM SHALL delete it and persist the config; IF the profile does not exist THEN THE SYSTEM SHALL error and exit with code 2.

## Requirement 14: Self-update check

**User Story:** As a user running a downloaded binary or tarball install, I want to check whether a newer localpress release exists, so that I know when to update.

**Acceptance Criteria:**
- WHEN `localpress update` (or `update --check`) is run THE SYSTEM SHALL query the GitHub Releases API for the latest release, compare its tag (`vX.Y.Z`) against the running binary's version using semantic (major.minor.patch) comparison, and report whether an update is available.
- IF the GitHub API request fails or returns a non-OK status THEN THE SYSTEM SHALL report the failure and exit with code 4.
- WHEN `--check` is passed and an update is available THE SYSTEM SHALL exit with code 1 without installing anything; WHEN `--check` is passed and no update is available THE SYSTEM SHALL exit 0.
- WHEN `--json` is set THE SYSTEM SHALL emit `{ currentVersion, latestVersion, updateAvailable, downloadUrl, checksumsUrl, releaseUrl, assetName, assetSize }`.

## Requirement 15: Self-update installation

**User Story:** As a user on a non-Homebrew install, I want `localpress update` to download, verify, and install the new version in place, so that I don't have to manually re-download and re-extract tarballs.

**Acceptance Criteria:**
- IF the detected install directory looks like a Homebrew Cellar path THEN THE SYSTEM SHALL NOT attempt a direct download; instead it SHALL instruct the user to run `brew upgrade localpress`.
- IF no release asset matches the current platform/architecture (`darwin`/`linux` × `arm64`/`x64`, or `windows-x64.zip`) THEN THE SYSTEM SHALL error, pointing at the release page for a manual download, and exit with code 1.
- WHEN an update is confirmed (via `--yes` or an interactive y/N prompt showing the asset name/size and install path) THE SYSTEM SHALL download the release asset.
- THE SYSTEM SHALL refuse to download the asset or the checksums file from any URL that does not start with `https://`.
- IF the release has no `checksums.txt` asset, or no entry in it matches the downloaded asset's filename THEN THE SYSTEM SHALL abort the update without installing anything, treating an unverified binary as unacceptable.
- WHEN a checksum entry is found THE SYSTEM SHALL compute the downloaded file's SHA-256 and compare it byte-for-byte against the expected hash before extraction; a mismatch SHALL abort the update.
- WHEN the archive is extracted and staged THE SYSTEM SHALL copy it into a staging directory that is a sibling of (same filesystem as) the target install directory, then perform the swap as two `rename()` calls (target → timestamped backup, staging → target) so a crash mid-swap cannot leave a partially-deleted install.
- IF the final rename step fails after the target was already moved aside THEN THE SYSTEM SHALL attempt to rename the backup back into place; IF that restore also fails THEN THE SYSTEM SHALL report both the original and restore errors along with the manual `mv` command needed to recover.
- WHEN a SIGINT/SIGTERM arrives during the swap window THE SYSTEM SHALL defer exit with a warning rather than terminating mid-rename.
- WHEN the update completes (successfully or not) THE SYSTEM SHALL clean up all temporary download/extraction/staging directories.

## Requirement 16: Shell completion generation

**User Story:** As a user, I want tab-completion for localpress commands and flags in my shell, so that I can discover and invoke commands faster without memorizing the full surface.

**Acceptance Criteria:**
- WHEN `localpress completions <shell>` is run with `shell` one of `bash`, `zsh`, or `fish` (case-insensitive) THE SYSTEM SHALL print a completion script for that shell to stdout.
- IF an unsupported shell name is passed THEN THE SYSTEM SHALL error, listing the supported shells, and exit with code 2.
- THE SYSTEM SHALL derive the full command, subcommand, flag, and positional-argument list by introspecting the live `commander` `program` tree (one level of subcommand nesting, covering `sites`, `posts`, and `config`) rather than from a hand-maintained list, so newly added commands/flags cannot silently drift out of the generated completions.
- THE SYSTEM SHALL decorate a curated subset of enum-style flags (e.g. `optimize --to`, `list --sort`, `remove-bg --model`) with value-choice completions in zsh and fish, sourced from a supplementary hint map; flags without an entry in that map SHALL still complete by name, just without value suggestions.
- THE SYSTEM SHALL write the generated script directly to stdout, bypassing the `info()`/`--quiet`/`--json` output machinery, so the output remains a clean, pipeable script regardless of global output flags.

## Requirement 17: Cross-cutting configuration and safety conventions

**User Story:** As a maintainer, I want site credentials and configuration state to be stored predictably and safely, so that behavior is consistent across all setup commands.

**Acceptance Criteria:**
- THE SYSTEM SHALL store configuration at `$XDG_CONFIG_HOME/localpress/config.json` (or `~/.config/localpress/config.json` on Linux/macOS without `XDG_CONFIG_HOME` set; `%APPDATA%\localpress` or `~/AppData/Roaming/localpress` on Windows).
- WHEN the config file does not yet exist THE SYSTEM SHALL treat it as an empty config (`{ version: 1, sites: {} }`) rather than erroring.
- IF the config file exists but fails basic shape validation (not an object, missing `version`, missing `sites`) THEN THE SYSTEM SHALL throw a `ConfigError` explaining the file is corrupt and suggesting the user delete it and re-run `init`.
- WHEN the config file is written (on any platform except Windows) THE SYSTEM SHALL create it with file mode `0600` and re-apply `chmod 0600` on every save (since the `mode` option only takes effect on file creation), because Application Passwords are full WordPress credentials.
- IF chmod fails THEN THE SYSTEM SHALL warn but not abort the save.
- THE SYSTEM SHALL validate every site name (whether from `init`, `sites add`, or the wizard) against `^[A-Za-z0-9._-]+$` (excluding literal `.`/`..`) before using it as a filesystem path component for the site's SQLite database, to prevent path traversal.
