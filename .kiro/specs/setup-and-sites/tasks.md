# Setup & Site Management — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core data model & config infrastructure

- [x] Define `SiteConfig`, `SshConfig`, `OptimizationProfile`, and top-level `Config` shapes in `src/types.ts` (Req 1, 13, 17)
- [x] Define shared `ExitCode` enum for stable, script-consumable exit codes (Req 3, 5, 6, 7, 12, 13, 15, 16)
- [x] Implement `getConfigDir`/`getConfigPath`/`getSitesDir`/`getSiteDbPath` with XDG-aware resolution (Linux/macOS `$XDG_CONFIG_HOME` or `~/.config`, Windows `%APPDATA%`) in `src/cli/utils/config.ts` (Req 17)
- [x] Implement `isValidSiteName`/`assertValidSiteName` (path-traversal-safe site name regex) (Req 1, 3, 5, 17)
- [x] Implement `loadConfig` with default-empty-config-on-missing-file and `ConfigError` on malformed JSON/shape (Req 17)
- [x] Implement `saveConfig` with mode-0600 file creation plus explicit re-chmod on every save, and directory auto-creation (Req 17)
- [x] Implement `mergeSiteConfig` to preserve `ssh`/`createdAt` across credential-rotation re-runs of `init` (Req 1, 3)
- [x] Implement `resolveActiveSite` (site override → active site → error) shared by every command that needs "the current site" (Req 1, 9, 12)

## Capability resolution (shared by init, doctor)

- [x] Implement `Capability` union and `WpBackend` interface in `src/adapters/types.ts` (Req 1, 2, 9)
- [x] Implement `AdapterResolver` (`resolve`/`tryResolve`/`getAdapter`/`availability`/`capabilityReport`) with REST-preferred vs. WP-CLI-preferred capability priority rules in `src/adapters/resolver.ts` (Req 1, 2, 9)

## `init` command

- [x] Register `init` command with `--name`/`--url`/`--username`/`--app-password`/`--non-interactive` flags (Req 1, 3)
- [x] Implement interactive-vs-non-interactive branch selection (TTY detection, `--non-interactive`, presence of `--url`) (Req 1, 3)
- [x] Implement non-interactive URL normalization, site-name derivation/validation, and the required-flags error path (exit 2) (Req 3)
- [x] Implement the REST connection test (`GET /wp-json/wp/v2/users/me` with Basic auth) with distinct 401 / other-non-OK / thrown-exception handling (exit 5 / exit 5 / exit 4) (Req 1, 3)
- [x] Implement config save + active-site-if-unset logic + existing-site-update warning (Req 1, 3)
- [x] Implement capability-report printing (REST/WP-CLI/MCP availability, unavailable-capabilities list, SSH setup tip) (Req 1, 3)
- [x] Implement graceful fallback from Ink-wizard-render-failure to the non-interactive path (Req 1)

## `InitWizard.tsx` (Ink interactive component)

- [x] Implement the linear step state machine (url → name → username → password → testing → report → optional SSH sub-flow → final-report) (Req 1, 2)
- [x] Implement flag-prefill cascading logic (skip to first missing field) and existing-site value prefill (Req 1)
- [x] Implement masked password input rendering (Req 1)
- [x] Implement the wizard's own connection-test effect (duplicate of the non-interactive logic, saving into config on success) (Req 1)
- [x] Implement the SSH-configuration prompt gated on `hasMissingCapabilities` (Req 2)
- [x] Implement the SSH sub-flow steps (host/user/port/wpPath/identityFile input) with sensible defaults (hostname, port 22) (Req 2)
- [x] Implement SSH connection test (`wp --info` reachability + `wp-config.php` existence check via `sshExec`) and error step with recovery guidance (Req 2)
- [x] Implement final capability report re-run after SSH is configured, and persist `siteConfig.ssh` (Req 2)

## `sites` command

- [x] Implement `tokenizeCommand` (quote-aware argv tokenizer, preserving empty-quoted tokens, treating mid-word apostrophes literally) as an exported, independently testable function (Req 8)
- [x] Implement `resolveSiteNames` (`--all-sites` XOR `--sites` validation, unknown-site detection) as an exported function (Req 8)
- [x] Implement `buildForwardedTopLevelFlags` (`--apply`/`--dry-run`/`--strict` passthrough) as an exported function (Req 8)
- [x] Implement `aggregateExitCode` (all-ok → 0, else 1) as an exported function (Req 8)
- [x] Register `sites` (default list action, plain + `--json`) (Req 4)
- [x] Register `sites add <url>` with URL normalization, name validation, required-credentials check, duplicate-name check, first-site-becomes-active logic (Req 5)
- [x] Register `sites use <name>` with unknown-site error path (Req 6)
- [x] Register `sites remove <name>` with `--keep-db`, active-site-reassignment-on-removal, and SQLite file (+ `-wal`/`-shm`) cleanup with warn-not-fail on deletion error (Req 7)
- [x] Register `sites run <command>` wiring `resolveSiteNames`/`tokenizeCommand`/`buildForwardedTopLevelFlags`/`aggregateExitCode` together with `--timeout` (default 30 min) and per-site `invokeCli` dispatch, plain + `--json` result reporting (Req 8)

## `doctor` command

- [x] Register `doctor` with `--all-sites`/`--plugins`/`--fix` flags (Req 9, 10, 11)
- [x] Implement per-site connection test with classified issue messages (auth / unreachable-host / generic REST error) (Req 9)
- [x] Implement WP-CLI-not-configured informational issue (Req 9)
- [x] Implement sharp-loadability check via dynamic import of `sharp-loader.ts` (Req 9)
- [x] Implement `--fix` auto-install of sharp via `installSharpGlobally` with success/partial-failure/total-failure issue reporting (Req 11)
- [x] Implement `detectPlugins` (WP REST plugins endpoint query, `KNOWN_PLUGINS` matching, 401/403-warns/endpoint-unavailable-silently-skips handling) (Req 10)
- [x] Implement conflicting-optimizer-plugin warning issues and Enable-Media-Replace informational issue (Req 10)
- [x] Implement `--fix` remediation-suggestion printing for error-severity issues, including the auth-issue re-init suggestion (Req 11)
- [x] Implement plain-text and `--json` capability-matrix + issues + plugins output (Req 9, 10)

## `config` command

- [x] Register `config` command group (Req 12, 13)
- [x] Implement `SETTABLE_KEYS` table (`active-site`, `defaults.quality`, `defaults.format`, `defaults.concurrency`, `defaults.captionModel`, `history.enabled`, `history.maxSizeBytes`) with per-key get/set + validation (Req 12)
- [x] Implement `config get <key>` (plain + `--json`, unknown-key exit 2) (Req 12)
- [x] Implement `config set <key> <value>` (validation-error exit 2, persist on success) (Req 12)
- [x] Implement `config list` with `redactConfig` (app-password redaction on every site entry) (Req 12)
- [x] Implement `config set-profile <name>` (`--description`/`--quality`/`--format`/`--max-width`/`--max-height`/`--encoder`/`--strip-metadata`, per-field validation, additive merge into existing profile, no-options-provided error) (Req 13)
- [x] Implement `config get-profile <name>` (not-found exit 2) (Req 13)
- [x] Implement `config list-profiles` (empty-state guidance vs. per-profile summary line) (Req 13)
- [x] Implement `config remove-profile <name>` (not-found exit 2) (Req 13)

## `update` command

- [x] Implement `checkForUpdate` (GitHub Releases API fetch, tag/version comparison via `isNewerVersion`, https-only asset filtering, platform/arch asset-name resolution via `getAssetName`) (Req 14)
- [x] Implement `parseChecksums`/`verifyChecksum` in `src/engine/update/checksum.ts` (Req 15)
- [x] Implement `performAtomicSwap` (two-rename swap with timestamped backup, restore-on-failure, manual-recovery error message) in `src/engine/update/swap.ts` (Req 15)
- [x] Register `update` command with `--check` flag, honoring global `--json`/`--yes` (Req 14, 15)
- [x] Implement Homebrew-install detection (`/Cellar/`/`/homebrew/` path sniffing) short-circuiting to a `brew upgrade` suggestion (Req 15)
- [x] Implement no-matching-asset error path (exit 1) (Req 15)
- [x] Implement confirmation prompt (size/install-path display + y/N) bypassed by `--yes` (Req 15)
- [x] Implement download → checksums-required-and-verified → extract (`tar`/`unzip` via `spawnSync`) → stage-as-sibling-dir → atomic swap pipeline, with SIGINT/SIGTERM deferral during the swap window (Req 15)
- [x] Implement temp-file cleanup in a `finally` block covering archive, extraction dir, and any leftover staging dir (Req 15)

## `completions` command

- [x] Implement `collectCommandSpecs`/`toCommandSpec` introspection of the live `commander` tree (one level of subcommand nesting) (Req 16)
- [x] Implement `OPTION_HINTS`/`ARG_HINTS`/`ARG_LABELS` cosmetic value-completion maps (Req 16)
- [x] Implement `generateBash` (word-list completion, one level of subcommand cases) (Req 16)
- [x] Implement `generateZsh` (`_arguments`-based completion with per-flag/arg value hints, recursive subcommand cases) (Req 16)
- [x] Implement `generateFish` (`complete -c localpress` line generation with conditional subcommand scoping) (Req 16)
- [x] Register `completions <shell>` with unsupported-shell validation (exit 2) and direct-stdout-write output (bypassing `--quiet`/`--json`) (Req 16)

## MCP tool wiring (exposing this area to agent hosts)

- [x] Wire `sites_list`, `sites_use`, `sites_add`, `sites_remove` MCP tools as thin wrappers over the CLI's `--json` output (`src/cli/mcp/tools.ts`, dispatched via `src/cli/mcp/invoke.ts`) (Req 4, 5, 6, 7)
- [x] Wire `doctor` MCP tool (with `allSites` param) (Req 9, 10)
- [x] Wire `config_get`, `config_set`, `config_list_profiles`, `config_get_profile`, `config_set_profile` MCP tools (Req 12, 13)
- [x] Wire `health_check` MCP tool combining `doctor` + `stats` + an alt-text audit in one round-trip for agent convenience (Req 9)
- [x] Rely on `self-invoke.ts`'s `isDevMode`/`getSelfBin` so `invoke.ts`'s subprocess dispatch (used by both `sites run` and every MCP tool) works consistently across dev/tarball/PATH installs (Req 8)

## Tests

- [x] `test/unit/init.test.ts` — non-interactive site-name path-traversal rejection (subprocess-level) (Req 3, 17)
- [x] `test/unit/sites-run.test.ts` — `tokenizeCommand`/`resolveSiteNames`/`aggregateExitCode`/`buildForwardedTopLevelFlags` unit coverage (Req 8)
- [x] `test/unit/config.test.ts` — config load/save round-trip, temp-`XDG_CONFIG_HOME`-isolated, including permission and corrupt-file handling (Req 17)
- [x] `test/unit/profile.test.ts` — profile-vs-explicit-flag resolution precedence simulation (Req 13)
- [x] `test/unit/completions.test.ts` — bash/zsh/fish generator coverage against the introspected command tree (Req 16)
- [x] `test/unit/update.test.ts` — update-check/version-comparison logic (Req 14)
- [x] `test/unit/update-checksum.test.ts` — `parseChecksums`/`verifyChecksum` coverage (Req 15)
- [x] `test/unit/update-swap.test.ts` — `performAtomicSwap` success and failure/restore paths (Req 15)

## Docs

- [x] Document `init`/`sites`/`doctor`/`config` in the README's command table and "Setup" quick-start section (Req 1, 4, 9, 12)
- [x] Document named-profile usage (`config set-profile` → `optimize --profile`) as a "Key behaviors" bullet in the README (Req 13)
- [x] Document capability resolution, WP-CLI/SSH setup, and the two-adapter model in `CLAUDE.md`'s locked architectural decisions and repo map (Req 2, 9)
- [x] Document the automated release pipeline that `update` consumes (GitHub Releases + `checksums.txt` + Homebrew tap) in `CLAUDE.md`'s "Releasing" section (Req 14, 15)
