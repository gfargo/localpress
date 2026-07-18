# MCP Server Integration

Backfilled spec documenting already-shipped functionality.

## Architecture

The MCP server does not talk to WordPress itself. It is a thin protocol adapter in front of the same CLI everything else in localpress uses — every tool call spawns the compiled/dev `localpress` binary as a child process and parses its `--json` output. This mirrors the layered picture in `README.md`, extended one level to show where the MCP server (and the markdown skill, which takes the identical path by shelling out directly) sits relative to the CLI, engine, and adapter layers:

```text
┌───────────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MCP Server (46 tools │────▶│  localpress CLI  │────▶│  Remote WP site │
│  + 4 resources)/Skill │     │  (TS + Bun,       │     │  (REST / SSH)   │
│  src/cli/mcp/         │     │  commander)       │     └─────────────────┘
└───────────────────────┘     └──────────────────┘              ▲
   spawns child process         parses argv,                    │
   (invoke.ts), reads              dispatches to                │
   stdout --json                   command handler               │
                                        │                         │
                                ┌───────┴────────┐                │
                                │  Engine layer  │                │
                                │  sharp/jsquash │                │
                                │  ONNX Runtime  │                │
                                │  Ollama vision │                │
                                │  SQLite state  │                │
                                └───────┬────────┘                │
                                        │                         │
                                ┌───────┴────────┐                │
                                │ Adapter layer  │────────────────┘
                                │ src/adapters/  │
                                │                │
                                │ AdapterResolver│
                                │  ├─ RestAdapter (always available)
                                │  └─ WpCliAdapter (opt-in via SSH)
                                └────────────────┘
```

Two things distinguish this from a "normal" layered service:

1. **The MCP server and the CLI are the same process image, invoked twice.** The long-lived `localpress mcp` process (an MCP server over stdio) does not import command handlers or adapters directly. Each tool call re-spawns `localpress <command> --json --quiet [...args]` as a *child* process, which goes through the exact same commander parsing, capability resolution, and adapter dispatch a human typing the command would trigger. This is a deliberate reuse strategy (see "Key design decisions" below), not an oversight — there is no separate in-process code path that could drift from the CLI's behavior.
2. **The adapter layer is single-tenant per CLI invocation.** Each spawned CLI process constructs its own `AdapterResolver` for the resolved site config (from `~/.config/localpress` or `XDG_CONFIG_HOME`), which in turn constructs a fresh `RestAdapter` (always) and optionally a `WpCliAdapter` (if SSH config is present for that site). There is no adapter instance shared across MCP tool calls; each call's isolation is a full process boundary.

## Key files/modules

### `src/cli/mcp/` — the MCP server

| File | Responsibility |
|---|---|
| `server.ts` | Boots the MCP server over stdio (`StdioServerTransport`). Constructs the `McpServer` with `name: 'localpress'`, the package version, `tools`/`resources` capabilities, and a static `instructions` string telling the agent host how site selection and dry-run defaults work. Calls `registerTools(server)` and `registerResources(server)`, then connects the transport. The process stays alive as long as stdin is open. |
| `tools.ts` | All tool definitions (46 `server.registerTool()` calls, verified by direct count — see "Verified counts" below). Contains the argv-building helpers (`flag`, `opt`, `ids`), the `runCli`/`runCliBatched` response-shaping functions, the `BATCH_CHUNK_SIZE` constant and `mergeBatchedOutputs` merge function, and the destructive-op confirm/force guard for `delete` and `posts_delete`. |
| `invoke.ts` | `invokeCli()` — spawns the CLI binary via `node:child_process.spawn`, forces `--json --quiet`, injects top-level `--site`/`--concurrency` flags ahead of the subcommand, resolves the right binary/args via `getSelfBin`/`isDevMode` from `src/cli/utils/self-invoke.ts` (dev mode vs tarball wrapper vs `PATH` binary), enforces a timeout (default 10 minutes) with SIGTERM→SIGKILL escalation, and parses stdout as JSON (falling back to NDJSON, then raw text). |
| `resources.ts` | Registers 4 resources (`localpress://sites`, `localpress://stats`, `localpress://capabilities`, `localpress://history`), each a thin wrapper (`readAsResource`) around `invokeCli` for a fixed CLI command (`sites`, `stats`, `doctor`, `history` respectively). |

### `src/adapters/` — the backend abstraction

| File | Responsibility |
|---|---|
| `types.ts` | Defines the `Capability` union (`list`, `get`, `upload`, `update-meta`, `delete`, `replace-in-place`, `regenerate-thumbnails`, `prune-orphans`, `fast-references`, `full-references`, `find-unattached`), the `WpBackend` interface every adapter implements, normalized domain types (`MediaItem`, `Reference`, `PagedResult<T>`, etc.), and the `CapabilityUnavailableError`/`WpApiError` error classes. Also documents (in a header comment) the three planned backend names — `rest`, `wp-cli`, `mcp` — with `mcp` explicitly marked deferred. |
| `rest.ts` | `RestAdapter` — always-available baseline. Application Password Basic auth against `/wp-json/wp/v2/*`. Supports `list`, `get`, `upload`, `update-meta`, `delete`, `fast-references`. Throws `CapabilityUnavailableError` for everything else, with adapter-specific guidance in the message (e.g. pointing at WP-CLI or the Enable Media Replace plugin for `replace-in-place`). |
| `wp-cli.ts` | `WpCliAdapter` — opt-in via SSH. Shells out to `wp` on the remote host for every capability, including the ones REST can't do: `replaceInPlace` (SCP the new bytes, `mv` into place, handle format-change renaming/reference-rewriting/thumbnail-regeneration sequencing), `regenerateThumbnails`, `pruneOrphans` (diff filesystem against `wp_postmeta`), `findUnattached`, and `full`-scope `findReferences` (raw SQL scans of `wp_posts`/`wp_postmeta`). |
| `ssh.ts` | Low-level `ssh`/`scp` process execution (`sshExec`, `scpUpload`, `scpDownload`), plus `shellQuote` (single-quote escaping for safe remote command interpolation) and `buildSshArgs`/`sshDestination`. Shells out to the system `ssh`/`scp` binaries rather than a Node SSH library, so it reuses the user's existing agent/config/keys. |
| `resolver.ts` | `AdapterResolver` — given a `SiteConfig`, constructs the available adapters (`WpCliAdapter` only if `isWpCliAvailableForSite`, `RestAdapter` always) and exposes `resolve()`/`tryResolve()`/`availability()`/`capabilityReport()`. Encodes the REST-vs-WP-CLI preference split via the `REST_PREFERRED` capability set. |

## Data flow

1. **Agent host → MCP tool call.** The agent host (e.g. Claude Desktop) sends a `tools/call` JSON-RPC request over stdio with the tool name and a JSON args object matching the tool's Zod schema.
2. **Tool handler → argv.** The matching handler in `tools.ts` (e.g. `optimize`'s handler) builds a CLI `argv` array from the args using `ids()`/`opt()`/`flag()` — e.g. `{ ids: [12,13], quality: 75, apply: true }` becomes `['optimize', '12', '13', '--quality', '75', '--apply']`.
3. **Handler → `invokeCli`.** The handler calls `runCli(argv, site, concurrency)` (or `runCliBatched` for large explicit ID sets — see Requirement 5), which calls `invokeCli({ args, site, concurrency })`.
4. **`invokeCli` → child process.** `invokeCli` appends `--json --quiet`, prepends `--site`/`--concurrency` as top-level flags, resolves the binary path (dev/tarball/PATH), and spawns it with `stdio: ['ignore', 'pipe', 'pipe']`.
5. **CLI parses argv → command handler.** The spawned process is a completely normal `localpress` invocation: commander parses the subcommand and flags, the command handler runs, and for any WordPress-touching operation it asks an `AdapterResolver` (constructed for the resolved site) to `resolve()`/`tryResolve()` the capability it needs.
6. **Resolver → adapter → WordPress.** The resolver picks `RestAdapter` or `WpCliAdapter` per the priority rules (Requirement 6) and calls the corresponding method, which issues either an authenticated `fetch()` against `/wp-json/wp/v2/*` or an SSH-executed `wp` command.
7. **Command handler → JSON stdout.** The command handler formats its result via the CLI's shared `printJson()` (per `CLAUDE.md`'s output convention) and the child process exits 0 (or non-zero with an error on stderr/exit code).
8. **`invokeCli` → parsed result.** The parent process's `close` handler parses the accumulated stdout (JSON, then NDJSON, then raw text fallback) into a `CliResult { exitCode, stdout, stderr, ok }`.
9. **`runCli`/`runCliBatched` → MCP tool result.** The handler shapes this into the MCP protocol's `{ content: [{ type: 'text', text }], structuredContent?, isError? }`, batching/merging multiple chunk results first if applicable (Requirement 5).
10. **MCP server → agent host.** The `McpServer`/`StdioServerTransport` serializes this as the JSON-RPC tool result and writes it to stdout, where the host reads it back.

Because steps 5–7 are identical to what happens when a human runs the CLI directly, the MCP surface, the skill (`skill/SKILL.md`, which also shells out to the CLI), and direct CLI usage are guaranteed to behave identically — there is exactly one code path that talks to WordPress.

## Key design decisions

These are the decisions from `CLAUDE.md`'s "Locked architectural decisions" table most load-bearing for this subsystem, reproduced here because getting the rationale right matters for this spec specifically:

| Decision | Choice | Why |
|---|---|---|
| **Agent integration** | **First-party MCP server (`localpress mcp`), shipped v1.14.0, alongside the markdown skill.** | **Reverses the original "no MCP server" call.** At planning time the team assumed composing with whatever WP MCP the user already had was enough; in practice agent hosts wanted one typed tool surface that talks straight to the CLI's capability layer (dry-run, resolver, snapshots) rather than re-deriving REST calls themselves. The skill still works standalone; the MCP server is the deeper integration for MCP-native hosts. |
| **WP integration** | REST (always) + WP-CLI over SSH (opt-in); `McpAdapter` backend still deferred | Auto-detect; pick best per operation. |

Two additional decisions are reflected directly in the code but not called out in the top-level locked-decisions table:

- **CLI-reuse-via-subprocess, not in-process dispatch.** `invoke.ts`'s header comment states the tradeoff explicitly: "Long-running ops can't stream progress this way — we get the final JSON blob only. That's acceptable for v1.14; hot paths can move to in-process dispatch later without changing the tool schemas." This means every MCP tool call pays full process-spawn overhead and gets only a final JSON blob (no incremental progress), in exchange for the MCP surface being unable to drift from the CLI's documented `--json` contract — the same contract the skill and human users depend on. This has not been revisited since v1.14 as of this writing.
- **`McpAdapter` backend variant remains deferred.** This is a *different* thing from the first-party MCP *server* documented in this spec. `src/adapters/types.ts` names three planned backend implementations (`rest`, `wp-cli`, `mcp`) and documents `McpAdapter` as: "opt-in for users with a WP MCP server connected. Deferred to v1.x." That would be a backend where localpress's own CLI talks to WordPress *through* an already-connected third-party WP MCP server, instead of directly via REST/WP-CLI — the inverse direction of integration from the server documented here (which exposes localpress's capabilities *to* agents). It is unimplemented: `AdapterResolver` never constructs an `mcp`-named adapter, `WpBackend['name']` includes `'mcp'` in its type but no class implements it with that name, and `AdapterAvailability.mcp` is always `false` in the current code. `CLAUDE.md`'s "What's left" section confirms this is the one architecturally-deferred item from the original plan still genuinely undone.

## Error handling / edge cases

- **`CapabilityUnavailableError` as the graceful-degradation primitive.** `RestAdapter` throws this (not a generic `Error`) for every capability it can't provide, each with an adapter-specific, actionable message (e.g. pointing at WP-CLI-over-SSH or the Enable Media Replace plugin for `replace-in-place`; explaining that only `fast`-scope reference scans work without WP-CLI). Command handlers upstream of the adapter layer are expected to use `resolver.tryResolve()` and handle a `null` result, per `CLAUDE.md`'s capability-resolution convention — this spec's code confirms the error type exists and is thrown consistently, but the calling convention itself lives in the individual command files, not in `src/adapters/`.
- **REST-specific error translation.** `RestAdapter.delete()` special-cases a non-force delete against a site without `MEDIA_TRASH` enabled (WordPress returns `rest_trash_not_supported` or HTTP 501) and rewrites it into an instruction to re-run with `--force` rather than surfacing the raw WP REST error text.
- **MCP-layer destructive-op guard, independent of the CLI.** The `delete` and `posts_delete` tool handlers in `tools.ts` check `force === true && confirm !== true` *before* calling `runCli` at all, returning an `isError: true` result with no CLI invocation. This is a belt-and-suspenders check specific to the MCP surface (an agent's tool call is a single opaque request, unlike a human typing a CLI flag they can see) — the CLI itself does not require a `--confirm` flag for `--force` deletes.
- **Timeout escalation.** `invokeCli` uses a two-stage kill: `SIGTERM` at the timeout (default 10 minutes), then `SIGKILL` after an 8-second grace period if the child hasn't exited — so a child that ignores `SIGTERM` (or is stuck in an uninterruptible syscall) cannot hang the MCP server indefinitely.
- **Stdout parsing fallback chain.** `invokeCli` tries `JSON.parse` on the full trimmed stdout first; if that fails, it tries treating each non-empty line as its own JSON record (NDJSON); if that also fails, it falls back to the raw trimmed text. This means a command that unexpectedly prints non-JSON (e.g. a crash before `--json` mode engages) still returns *something* usable rather than throwing inside the MCP server.
- **Partial-failure batching.** In `runCliBatched`, a chunk whose CLI invocation fails does not abort the remaining chunks — its failure is recorded as `{ failures: chunk.length }`, appended to the accumulated stderr, and folded into the final merged result via `mergeBatchedOutputs`, so an agent that requests optimize/caption on e.g. 23 IDs still gets results for the 20 that succeeded even if one 5-ID chunk errors.
- **Dev-mode vs. distributed-binary spawn resolution.** `getSelfBin`/`isDevMode` (`src/cli/utils/self-invoke.ts`) distinguish three run modes (`bun src/cli/index.ts` dev mode, a tarball's `LOCALPRESS_BIN`-wrapped install, and a `localpress` binary on `PATH`) so the same `invoke.ts` code spawns the correct child regardless of how `localpress mcp` itself was launched.

## Testing approach

- **`test/unit/mcp.test.ts`** — the primary MCP protocol test. Boots `localpress mcp` as a real subprocess (via `bun run src/cli/index.ts mcp`) with an isolated `XDG_CONFIG_HOME`, and drives it with the actual `@modelcontextprotocol/sdk` `Client`/`StdioClientTransport` — no mocks of the protocol layer. Covers: full tool listing (spot-checks core tool names, asserts `tools.length >= 20`), the exact 4-resource listing, a `sites_list` call against a fresh/empty config, schema shape assertions (`optimize` has `ids`/`quality`/`apply`; bulk tools expose `concurrency`; `delete` has `ids`/`force`; `update_metadata` has the expected fields), the `delete`/`posts_delete` force-without-confirm guard, and a named regression (`optimize` must expose `to`, not a stale `format` field, regression for issue #50).
- **`test/unit/mcp-schema-cli-parity.test.ts`** — a static-analysis guard, not a runtime protocol test: it parses `tools.ts`'s source to extract, per tool, the literal CLI subcommand prefix and every `--flag` its handler can push onto argv, then asserts each flag actually appears in that subcommand's real `--help` output. This is a regression test for issue #110, where the `optimize` tool advertised `maxWidth`/`maxHeight`/`stripMetadata` mapped to flags the CLI hadn't declared yet, so agent calls using them failed with "unknown option."
- **`test/unit/mcp-batch-merge.test.ts`** — pure unit tests of the exported `mergeBatchedOutputs` function: preserves caption's `dryRun`/`skipped` shape without injecting a bogus `totalSavedBytes`, correctly sums `totalSavedBytes` for optimize-shaped output, and correctly accounts for a chunk that only contributes a `{ failures: n }` record. Regression coverage for issue #208 (batched caption used to come back shaped like optimize's output).
- **Adapter-layer coverage supporting the resolver:**
  - `test/unit/rest-adapter.test.ts` — mocked-`fetch` regression tests for `context=edit` usage (raw block markup / raw caption fields needed for read-modify-write flows like `tag`/`vision`), issue #101.
  - `test/unit/rest-adapter-list.test.ts` — an in-process fake WP REST endpoint (`Bun.serve()`) verifying whole-library `--sort size` and exact-MIME-type `--type` filtering, issue #123.
  - `test/unit/wp-cli.test.ts`, `wp-cli-getmedia.test.ts`, `wp-cli-references.test.ts`, `wp-cli-replace.test.ts` — `WpCliAdapter` unit tests with `sshExec`/`scpUpload` mocked via `mock.module`: exact shell-command construction and `shellQuote` round-tripping, meta-key-absent vs. real-SSH-failure disambiguation, the ID-boundary-safe `matchesBlockId` Gutenberg matcher, and the `replaceInPlace` format-change sequencing (metadata updated before old bytes are deleted; reference-rewrite failure is non-fatal).
  - `test/unit/ssh.test.ts` — `sshDestination`/`buildSshArgs`/`isWpCliAvailableForSite` plus `AdapterResolver` behavior across various SSH config shapes.
  - `test/unit/self-invoke.test.ts` — `isDevMode`/`getSelfBin`/`buildSelfArgs` across dev/tarball/fallback modes, which `invoke.ts` depends on directly.
- **`test/integration/wp-rest.test.ts`** — runs against a real Dockerized WordPress instance (see `test/integration/docker-compose.yml`). Directly exercises `RestAdapter` (list/get/upload/delete/updateMetadata/slug rename/`replaceInPlace` rejection/reference finding/trash-not-supported translation) and includes an explicit `AdapterResolver` assertion: for a REST-only `SiteConfig` (no SSH), `availability()` reports `wpCli: false, mcp: false`, and `capabilityReport()` shows `list` resolved to `rest` while `replace-in-place` has no available adapter.

No test file in the repository directly exercises `WpCliAdapter` (or the WP-CLI side of `AdapterResolver`) against a live SSH-reachable WordPress — that path is covered only by the mocked unit tests listed above. This is worth flagging: WP-CLI-adapter correctness against a real remote `wp` binary is unverified by CI as of this writing.
