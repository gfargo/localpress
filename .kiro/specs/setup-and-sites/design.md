# Setup & Site Management — Design

## Architecture

This subsystem sits at the top of localpress's layered architecture (CLI command layer → engine layer → adapter layer, per `CLAUDE.md`'s repo map) but is unusual in that most of its commands terminate at the **config layer** rather than the adapter layer — `config`, `sites use/remove`, and `completions` never talk to WordPress at all. Only `init`, `sites add`, `sites run`, and `doctor` reach out over the network (via the adapter layer), and only `update` reaches out to GitHub instead of WordPress.

```
┌─────────────────────────────────────────────────────────────────┐
│ CLI command layer (src/cli/commands/{init,sites,doctor,config,   │
│ update,completions}.ts + src/cli/components/InitWizard.tsx)      │
│  - flag parsing, prompting, --json/plain output                  │
└───────────────┬─────────────────────────────┬─────────────────┘
                │                             │
                ▼                             ▼
   ┌─────────────────────────┐   ┌─────────────────────────────┐
   │ Config utils             │   │ Adapter layer                │
   │ src/cli/utils/config.ts  │   │ src/adapters/resolver.ts     │
   │  - load/save config.json │   │  (AdapterResolver)           │
   │  - site name validation  │   │ src/adapters/{rest,wp-cli,   │
   │  - site resolution       │   │   ssh}.ts                    │
   └─────────────────────────┘   └───────────────┬─────────────┘
                                                  ▼
                                     WordPress REST API / SSH+WP-CLI
```

`sites run` is the one command that loops back into the CLI layer itself: it re-invokes the compiled/dev localpress binary as a child process per target site (via `src/cli/mcp/invoke.ts`'s `invokeCli`, shared with the MCP server's tool-dispatch mechanism) rather than calling command logic in-process. `update` talks to the GitHub REST API and to the local filesystem (`src/engine/update/{checksum,swap}.ts`) instead of to WordPress.

## Key files/modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/init.ts` | `init` command registration; non-interactive flag path; connection test; capability report printing; falls back from the Ink wizard when it can't render. |
| `src/cli/components/InitWizard.tsx` | Ink React component driving the interactive step machine (url → name → username → password → test → report → optional SSH sub-flow → final report). Owns its own SSH connection test via `sshExec`. |
| `src/cli/commands/sites.ts` | `sites` (list), `sites add`, `sites use`, `sites remove`, `sites run` subcommands. Exports `tokenizeCommand`, `resolveSiteNames`, `buildForwardedTopLevelFlags`, `aggregateExitCode` as pure, independently unit-tested helpers. |
| `src/cli/commands/doctor.ts` | Connection test, WP-CLI availability check, sharp-loadability check, plugin detection (`detectPlugins`), `--fix` auto-remediation, capability-matrix printing. |
| `src/cli/commands/config.ts` | `config get/set/list` (scalar keys via the `SETTABLE_KEYS` table) and `config set-profile/get-profile/list-profiles/remove-profile` (named `OptimizationProfile` CRUD). |
| `src/cli/commands/update.ts` | GitHub Releases lookup, Homebrew-install detection, download/checksum-verify/extract/atomic-swap orchestration. |
| `src/cli/commands/completions.ts` | Introspects the live `commander` `Command` tree into `CommandSpec[]`, then generates bash/zsh/fish completion scripts from that plus a small cosmetic `OPTION_HINTS`/`ARG_HINTS`/`ARG_LABELS` map. |
| `src/cli/utils/config.ts` | `loadConfig`/`saveConfig` (JSON file at `$XDG_CONFIG_HOME/localpress/config.json`, mode 0600), `isValidSiteName`/`assertValidSiteName`, `mergeSiteConfig`, `resolveActiveSite`, `getSiteDbPath`, `ConfigError`. |
| `src/cli/utils/run-mode.ts` | `resolveDryRun` — not used directly by this area's commands (none of `init`/`sites`/`doctor`/`config`/`update`/`completions` are bulk/destructive in the sense the shared dry-run helper targets), but `sites run` forwards `--apply`/`--dry-run`/`--strict` through to whatever child command is invoked, so it depends on the *convention* existing downstream. |
| `src/cli/utils/self-invoke.ts` | `isDevMode`/`getSelfBin`/`buildSelfArgs` — used by `sites run` (via `invokeCli`) to figure out how to re-exec the current binary (dev `bun` script vs. tarball wrapper vs. `localpress` on `PATH`). |
| `src/adapters/resolver.ts` | `AdapterResolver` — picks the best-available adapter per capability; exposes `availability()` and `capabilityReport()`, consumed directly by `init`, `doctor`, and the wizard. |
| `src/adapters/types.ts` | `Capability` union, `WpBackend` interface, `CapabilityUnavailableError` — the vocabulary `doctor`'s capability matrix is built from. |
| `src/engine/update/checksum.ts` | `parseChecksums` (sha256sum-format parser), `verifyChecksum` (streaming SHA-256 compare). |
| `src/engine/update/swap.ts` | `performAtomicSwap` — two-rename directory swap with backup/restore-on-failure. |
| `src/types.ts` | `SiteConfig`, `SshConfig`, `OptimizationProfile`, `Config`, `ExitCode` — the shared data shapes this whole area reads and writes. |

## Data flow

### `init` (non-interactive path, also what the wizard's "testing" step does internally)

1. Parse/validate flags → normalize URL (prepend `https://`, strip trailing slash) → derive/validate site name.
2. `GET {url}/wp-json/wp/v2/users/me` with `Authorization: Basic base64(username:appPassword)`.
3. On success: `loadConfig()` → `mergeSiteConfig(existingSiteOrUndefined, { name, url, username, appPassword })` (preserves `ssh`/`createdAt` if the site already existed) → write into `config.sites[name]` → set `config.activeSite` if unset → `saveConfig(config)`.
4. `new AdapterResolver(siteConfig)` → `availability()` + `capabilityReport()` → printed as the capability summary.

### `init` (interactive wizard)

Same network call and config merge/save logic, duplicated inside `InitWizard.tsx`'s `testConnection` effect (it does not call into `init.ts`'s non-interactive function — the two paths independently implement equivalent logic). The wizard is a linear state machine (`WizardStep` union) driven by `useInput`; each step's `submitCurrentStep()` validates and advances. The SSH sub-flow, if entered, calls `sshExec` from `src/adapters/ssh.ts` twice (`wp --info`, then a `test -f wp-config.php` check) before writing `siteConfig.ssh` and re-running the capability report.

### `doctor`

1. Resolve target site name(s) (active site, or every configured site with `--all-sites`).
2. Per site: `new AdapterResolver(site)` → `availability()`/`capabilityReport()`.
3. Connectivity: `resolver.getAdapter('rest').listMedia({ perPage: 1, page: 1 })` — errors are pattern-matched on message text (`401`/`Unauthorized`, `ENOTFOUND`/`ECONNREFUSED`) to classify the issue.
4. Sharp check: dynamic `import('../../engine/image/sharp-loader.ts')` → `loadSharp()`; on failure, `--fix` triggers `installSharpGlobally()`.
5. Plugin check (only if `--plugins`/`--fix`): direct `fetch` to `{url}/wp-json/wp/v2/plugins?per_page=100`, matched against a hardcoded `KNOWN_PLUGINS` table.
6. All findings accumulate into an `issues: DoctorIssue[]` array with `severity`/`message`/optional `fix`, printed or emitted as JSON.

### `sites run`

1. Resolve target sites via `resolveSiteNames` (validates `--all-sites` XOR `--sites`, and that named sites exist).
2. `tokenizeCommand(commandStr)` splits the quoted command string into argv, rejecting empty results and `sites` as the first token (no self-nesting).
3. For each site: `invokeCli({ site, concurrency, args, extraTopLevelFlags: buildForwardedTopLevelFlags(parentOpts), timeoutMs })` — this spawns the *same* localpress executable as a subprocess (`getSelfBin`/`isDevMode` from `self-invoke.ts` decide whether to prefix with a `bun <script>` invocation), always appending `--json --quiet` to the child so its stdout is parseable, and forwards `--site`, `--concurrency`, and the parent's `--apply`/`--dry-run`/`--strict`.
4. Results are collected per site and aggregated; `aggregateExitCode` reduces the run to a single process exit code (0 only if every site succeeded).

### `config set-profile` / `optimize --profile`

`config set-profile` only writes `config.profiles[name]`; it does not itself touch image processing. The consuming side (`optimize.ts`, exercised by `test/unit/profile.test.ts`'s `resolveProfileOptions` simulation) reads `config.profiles[name]` and layers explicit CLI flags on top, so profile values act as defaults a direct flag can override. This module boundary — `config` owns storage, `optimize` owns resolution/precedence — keeps profile semantics out of this area's own code.

### `update`

1. `checkForUpdate()`: `fetch` GitHub's `/releases/latest`, compare `tag_name` (stripped of `v`) against `package.json`'s `version` via a manual major/minor/patch integer comparison (`isNewerVersion`) — not a semver range comparison.
2. Filter release assets to `https://` URLs only, match the current platform/arch's expected asset name, and locate the `checksums.txt` asset.
3. If proceeding past the check: detect Homebrew install (path contains `/Cellar/` or `/homebrew/`) and short-circuit to a `brew upgrade` suggestion.
4. Otherwise: download the archive → download+parse `checksums.txt` (`parseChecksums`) → `verifyChecksum` (streaming SHA-256) → extract with `tar`/`unzip` via `spawnSync` → locate the extracted `localpress-<platform>/` subdirectory → `cp` it into a `<targetDir>-staging-<timestamp>` sibling directory → `performAtomicSwap(targetDir, stagingDir)` (rename target → `.bak-<timestamp>`, rename staging → target, delete backup; restore backup on failure) → clean up temp files in a `finally` block regardless of outcome.

### `completions`

1. `collectCommandSpecs(program)` walks `program.commands` recursively (one level deep, since only `sites`/`posts`/`config` have subcommands) into a `CommandSpec[]` tree of names, descriptions, flags, and positional args — read directly off the live `commander` objects, not hand-copied.
2. `generateBash`/`generateZsh`/`generateFish` render that tree into shell-specific completion scripts, consulting `OPTION_HINTS`/`ARG_HINTS`/`ARG_LABELS` only for cosmetic value-completion decoration.
3. Output is written with `process.stdout.write` directly, bypassing `output.ts`'s `info()`.

## Key design decisions

- **Plain config file at mode 0600, not a system keychain** (locked decision from `CLAUDE.md`). `saveConfig` creates the file with `{ mode: 0o600 }` and additionally re-`chmod`s on every save, because Bun's `mode` option on `writeFileSync` only applies at file-creation time — without the explicit re-chmod, an already-existing world-readable config file would silently stay that way after an update. This is a deliberate belt-and-suspenders choice given the file holds Application Passwords in plaintext.
- **Capability resolution is centralized in `AdapterResolver`**, not duplicated per command. `init`, the wizard, and `doctor` all call the same `capabilityReport()`/`availability()` methods, so the "what can I do against this site" answer can't drift between the three surfaces that show it to the user.
- **`init`'s non-interactive path and the Ink wizard independently re-implement the same connection-test-and-save logic** rather than sharing a function. This is a real duplication in the codebase (not a design decision this doc endorses) — worth flagging for a future refactor, but as of v2.1.0 the two code paths must be kept in sync by hand.
- **Named optimization profiles** (`OptimizationProfile` in `src/types.ts`, CRUD in `config.ts`) are stored config, not a separate subsystem — deliberately kept as simple partial-object merges (`{ ...existing, ...newFields }`) so profile updates are additive by default.
- **`sites run` re-execs the CLI as a subprocess per site** instead of calling command handlers in-process. This reuses the exact same `--json` code path every other integration (the skill, the MCP server) depends on, at the cost of process-spawn overhead per site — judged acceptable since `sites run` is inherently a multi-site batch operation.
- **Self-update only trusts `https://` URLs and requires a matching `checksums.txt` entry.** There is no `--skip-checksum` escape hatch in the code; a release missing `checksums.txt`, or missing an entry for the current platform's asset, hard-fails the update rather than degrading to an unverified install.
- **Atomic swap via two renames**, not delete-then-copy, so a crash or forced-kill mid-update can't leave a half-deleted install directory. The trade-off is `stagingDir` must be on the same filesystem as `targetDir` (enforced implicitly by making it a sibling directory) or the `rename()` calls fail with `EXDEV`.
- **Completions are generated from live `commander` introspection**, not hand-maintained per-shell lists, specifically so new commands/flags can't silently go undocumented in shell completions — the code comment in `completions.ts` calls this out explicitly. Only the cosmetic value-hints (`OPTION_HINTS` etc.) can go stale; flag *existence* cannot.
- **Doctor's `--fix` is remediation-by-suggestion for most issues** (it prints the fix command rather than running it) — the one issue it auto-remediates in-process is a missing `sharp` install.

## Error handling / edge cases

- **Site name validation doubles as a path-traversal guard.** `isValidSiteName` (`^[A-Za-z0-9._-]+$`, excluding `.`/`..`) is enforced in `init`, `sites add`, and the wizard before the name is ever used to build `getSiteDbPath(name)` — regression-tested by `test/unit/init.test.ts` (`../evil` as `--name` must be rejected with exit 2 and no config file written).
- **`init`'s HTTP error handling conflates "auth failed" and "other non-OK status" into the same exit code (5)** — both a 401 and, say, a 500 from the connection test exit with code 5, only the message text differs. Only a thrown/network-level failure (unreachable host, DNS failure) gets exit code 4. This is real, observed behavior, not a bug being described as a feature — worth knowing if scripting against exit codes.
- **`config get <key>` cannot distinguish "unrecognized key" from "recognized key with no value set".** `active-site` with no site ever configured returns `undefined` from `getConfigValue`, which `config get` reports as `Unknown config key: active-site` — the same message as passing a genuinely nonexistent key name.
- **`doctor`'s plugin detection fails soft.** A 401/403 from the plugins endpoint produces a warning (not an error) and an empty plugin list; any other failure (network error, 404 on older WP versions without the endpoint) is swallowed entirely with no user-visible message. `doctor` as a whole never fails because of plugin detection.
- **`sites remove` failing to delete the SQLite file warns rather than exits non-zero** — the site config removal is considered the primary, successful operation even if filesystem cleanup partially fails.
- **`update`'s atomic swap has a documented unrecoverable failure mode**: if the rename-in (`staging → target`) fails *and* the rename-back (`backup → target`) also fails, the user is left with the old install renamed to `<targetDir>.bak-<timestamp>` and nothing at `<targetDir>`. The error message includes the exact `mv` command to run manually — this is treated as an acceptable last resort given both renames failing implies a serious filesystem-level problem outside the tool's control.
- **`sites run` explicitly disallows self-nesting** (`args[0] === 'sites'` check) to prevent a user from accidentally writing `sites run "sites run ..."` and fanning out combinatorially.
- **Commander usage errors are normalized centrally**, not per-command: `src/cli/index.ts` calls `exitOverride()` recursively over the whole command tree (`applyExitOverride`) specifically because commander's `exitOverride` doesn't automatically propagate to subcommands registered via `.command()` — relevant here because `sites add/use/remove/run` and `config set-profile/get-profile/...` are exactly that kind of nested subcommand.

## Testing approach

Unit tests (all under `test/unit/`, run via `bun test`):

- **`test/unit/init.test.ts`** — subprocess-level test of `init --non-interactive`'s site-name validation (path-traversal rejection), since the non-interactive branch inside `init.ts`'s `action()` isn't exported for direct in-process testing.
- **`test/unit/sites-run.test.ts`** — direct unit tests of the exported pure helpers from `sites.ts`: `tokenizeCommand` (quoting edge cases), `resolveSiteNames`, `aggregateExitCode`, `buildForwardedTopLevelFlags`.
- **`test/unit/config.test.ts`** — `loadConfig`/`saveConfig` round-tripping against a temp `XDG_CONFIG_HOME`, including the 0600 permission behavior and corrupt-file error path.
- **`test/unit/profile.test.ts`** — profile resolution precedence (profile values vs. explicit CLI flag overrides) via an extracted simulation of the logic `optimize.ts` uses when consuming `config.profiles`.
- **`test/unit/completions.test.ts`** — exercises the generators for all three shells against the introspected command tree.
- **`test/unit/update.test.ts`**, **`test/unit/update-checksum.test.ts`**, **`test/unit/update-swap.test.ts`** — the GitHub-release-comparison logic, `parseChecksums`/`verifyChecksum`, and `performAtomicSwap` (including the rename-failure/restore path), respectively.

Not directly covered by dedicated unit tests: `doctor`'s plugin-detection HTTP parsing, the Ink `InitWizard.tsx` component's interactive state machine (Ink UIs are not exercised in this suite), and `sites list`/`sites add`/`sites use`/`sites remove`'s top-level command wiring (only their extracted logic, where extracted, is tested directly). The `test/integration/` suite (Dockerized WordPress) and `test/tarball/` smoke tests exercise the CLI end-to-end but are not organized per-command, so this area's live-network paths (the actual `fetch` calls in `init`/`doctor`) are covered incidentally at best — this is a real gap worth flagging rather than a documented decision.
