# Project Structure

```
localpress/
├── src/
│   ├── types.ts                    # Shared types: SiteConfig, SshConfig, Config, ExitCode
│   ├── cli/
│   │   ├── index.ts                # Entry point — Commander setup, global flags, 39 commands
│   │   ├── commands/               # One file per CLI command (register pattern)
│   │   │   ├── init.ts             # Interactive site setup wizard (Ink)
│   │   │   ├── sites.ts            # List/switch/add/remove/run configured sites
│   │   │   ├── doctor.ts           # Backend availability, plugin detection, --fix
│   │   │   ├── config.ts           # Config get/set/list, named optimization profiles
│   │   │   ├── list.ts             # List media in WP library (filterable, interactive TUI -i)
│   │   │   ├── show.ts             # Show details for a single attachment
│   │   │   ├── stats.ts            # Cumulative processing stats (--all-sites)
│   │   │   ├── audit.ts            # Audit: unoptimized/large/missing-alt/orphans/display-size/duplicates/broken-refs/quality/ocr/budget-gate
│   │   │   ├── references.ts       # Find where an attachment is used, rewrite references
│   │   │   ├── a11y.ts             # WCAG accessibility audit for post/page content
│   │   │   ├── briefing.ts         # Aggregated site-health digest + Ollama narrative
│   │   │   ├── verify.ts           # Cross-check local DB state vs remote WordPress
│   │   │   ├── optimize.ts         # Compress/convert media (--profile, --target-size, --preview)
│   │   │   ├── convert.ts          # Convert between formats (webp, avif, jpeg, png)
│   │   │   ├── resize.ts           # Resize preserving aspect ratio
│   │   │   ├── remove-bg.ts        # AI background removal (ONNX + system rembg + --preview)
│   │   │   ├── caption.ts          # AI alt-text via Ollama (--language, --missing-alt)
│   │   │   ├── title.ts            # AI title generation via Ollama
│   │   │   ├── describe.ts         # AI description generation via Ollama
│   │   │   ├── classify.ts         # Image type classification (screenshot/photo/illustration/diagram)
│   │   │   ├── tag.ts              # AI keyword tagging via Ollama
│   │   │   ├── vision.ts           # Composed alt+title+description+tags+classify in one pass
│   │   │   ├── metadata.ts         # Manual alt/title/caption/description writes
│   │   │   ├── rename.ts           # Slug rename (--smart uses vision model)
│   │   │   ├── posts.ts            # Posts/pages/CPT CRUD (list/show/create/update/delete)
│   │   │   ├── delete.ts           # Delete attachments (trash or --force)
│   │   │   ├── edit.ts             # Round-trip: download → editor → watch → sync
│   │   │   ├── watch.ts            # Continuous directory watcher → auto-push
│   │   │   ├── watch-status.ts     # Report watched directories and last activity
│   │   │   ├── pull.ts             # Download media to local disk
│   │   │   ├── push.ts             # Upload local file to WP
│   │   │   ├── export.ts           # Export media library as ZIP/directory with manifest
│   │   │   ├── import.ts           # Bulk import files/directories/ZIPs with optimization
│   │   │   ├── regenerate.ts       # Rebuild WP thumbnails (requires WP-CLI)
│   │   │   ├── history.ts          # Browse time-machine sessions/snapshots
│   │   │   ├── undo.ts             # Restore from time-machine snapshot
│   │   │   ├── update.ts           # Self-update from GitHub Releases
│   │   │   ├── completions.ts      # Shell completion scripts (bash/zsh/fish)
│   │   │   └── mcp.ts              # Start the first-party MCP server
│   │   ├── components/
│   │   │   ├── InitWizard.tsx       # Ink React wizard for init command
│   │   │   ├── MediaBrowser.tsx     # Ink TUI for list --interactive
│   │   │   └── HistoryBrowser.tsx   # Ink TUI for history/undo browsing
│   │   ├── mcp/
│   │   │   ├── server.ts           # MCP server entry (localpress mcp)
│   │   │   ├── tools.ts            # 52 typed tool definitions
│   │   │   ├── invoke.ts           # Tool → CLI invocation bridge
│   │   │   └── resources.ts        # MCP resources
│   │   └── utils/
│   │       ├── config.ts           # Config file load/save ($XDG_CONFIG_HOME/localpress/)
│   │       ├── output.ts           # Output helpers: info/warn/error/printJson, --json/--quiet modes
│   │       ├── run-mode.ts         # resolveDryRun, dryRunPayload helpers
│   │       ├── args.ts             # CLI argument parsers (parseIntOption, etc.)
│   │       └── self-invoke.ts      # Helper for subprocess dispatch
│   ├── adapters/
│   │   ├── types.ts                # WpBackend interface, Capability type, MediaItem, Reference, etc.
│   │   ├── rest.ts                 # REST API adapter (always available, App Password auth)
│   │   ├── wp-cli.ts               # WP-CLI over SSH adapter (opt-in)
│   │   ├── ssh.ts                  # SSH/SCP execution helper
│   │   └── resolver.ts             # AdapterResolver — picks best adapter per capability
│   └── engine/
│       ├── image/
│       │   ├── types.ts            # ImageFormat, OptimizeOptions, OptimizeResult
│       │   ├── optimize.ts         # Image optimization engine (sharp + jsquash)
│       │   ├── jsquash.ts          # jSquash WASM codec integration
│       │   └── sharp-loader.ts     # Lazy sharp loading
│       ├── caption/
│       │   ├── ollama.ts           # Ollama HTTP client (vision + text generation)
│       │   ├── run-bulk.ts         # Shared bulk loop with FK-safe upserts
│       │   └── types.ts            # CaptionOptions, CaptionResult
│       ├── rembg/
│       │   ├── models.ts           # ONNX model manager (download + cache)
│       │   ├── remove-bg.ts        # Background removal engine
│       │   ├── system-rembg.ts     # System Python rembg integration
│       │   └── onnx-types.ts       # Type declarations for onnxruntime-node
│       ├── preview/
│       │   ├── server.ts           # Browser-based preview HTTP server
│       │   ├── ui-optimize.ts      # Preview UI for optimize
│       │   └── ui-remove-bg.ts     # Preview UI for remove-bg
│       ├── editor/
│       │   ├── detect.ts           # Editor detection and launching
│       │   └── watcher.ts          # File watcher for edit round-trip
│       ├── network/
│       │   └── download.ts         # Authenticated file download helper
│       ├── history/
│       │   ├── index.ts            # Time-machine snapshot creation/restore
│       │   ├── store.ts            # Snapshot storage (SQLite blobs)
│       │   └── types.ts            # Session, Snapshot types
│       └── state/
│           ├── schema.ts           # SQL DDL, migrations (schema v5)
│           └── db.ts               # SiteDb wrapper (bun:sqlite) + getStats()
├── test/
│   ├── unit/                       # 80 unit test files
│   ├── integration/                # Integration tests (Dockerized WP)
│   │   ├── docker-compose.yml
│   │   ├── setup-wp.sh
│   │   ├── wp-rest.test.ts
│   │   └── wp-rest-commands.test.ts
│   ├── quality/                    # Photorealistic remove-bg benchmarks
│   ├── tarball/                    # Built-binary end-to-end smoke tests
│   └── fixtures/                   # Test data files
├── skill/
│   └── SKILL.md                    # Full AI agent skill with JSON schemas
├── docs/
│   ├── blog-post-v2.md             # v2.0 announcement / positioning writeup
│   └── roadmap-ideas.md            # Extension brainstorm (450+ ideas, 61 domains)
├── Formula/
│   └── localpress.rb               # Homebrew formula (auto-updated on release)
├── scripts/
│   └── build-tarball.ts            # Distribution tarball builder
├── bin/
│   └── screenshot/                 # VHS-based screenshot/GIF generation pipeline
├── CLAUDE.md                       # Implementation status, locked decisions, conventions
└── .github/
    └── workflows/
        ├── ci.yml                  # Unit + integration tests on PR/push
        ├── pr-title-lint.yml       # Conventional-commit PR-title check
        ├── release-please.yml      # Maintains the Release PR; cuts tag on merge
        ├── release-build.yml       # Reusable: build → checksum → release → formula
        ├── release.yml             # Manual fallback: build/publish on a hand-pushed v* tag
        └── rebuild-on-wiki.yml     # Trigger Vercel deploy hook on wiki/release change
```

## Architecture: Three Surfaces, One Engine

```
┌──────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  MCP Server (52  │───▶│  localpress CLI  │───▶│  Remote WP site │
│  tools) / Skill  │    │  (TS + Bun)      │    │  (REST / SSH)   │
└──────────────────┘    └──────────────────┘    └─────────────────┘
                                │
                        ┌───────┴────────┐
                        │  Engine layer  │
                        │  sharp/jsquash │
                        │  ONNX Runtime  │
                        │  Ollama vision │
                        │  SQLite state  │
                        └───────┬────────┘
                        ┌───────┴────────┐
                        │ Adapter layer  │
                        │ REST | WP-CLI  │
                        └────────────────┘
```

## Three Architecture Layers

1. **CLI layer** (`src/cli/`) — User-facing commands. Each command file exports a `registerXxxCommand(program)` function that adds a Commander subcommand. Global flags (--site, --json, --quiet, --dry-run, --apply, --strict, --concurrency, --yes) are on the root program.

2. **Adapter layer** (`src/adapters/`) — WordPress communication. The `WpBackend` interface defines all operations. Each adapter declares its supported capabilities via a `Set<Capability>`. The `AdapterResolver` picks the best adapter per operation based on priority order (wp-cli > rest). A third `McpAdapter` (for users who already have a WP MCP server as their backend) remains deferred.

3. **Engine layer** (`src/engine/`) — Domain logic independent of WordPress or CLI concerns. Image processing (sharp + jsquash codecs), AI background removal (ONNX Runtime + U2-Net/BiRefNet), AI text generation (Ollama HTTP), SQLite state management (per-site databases), editor detection and file watching, time-machine snapshots.

## Key Patterns

- **Command registration:** Each command file exports `registerXxxCommand(program: Command)` — called from `src/cli/index.ts`
- **Capability resolution:** Never call adapter methods directly when the capability might be unavailable. Use `resolver.tryResolve()` and handle `CapabilityUnavailableError` gracefully with actionable guidance.
- **Safe-by-default bulk ops:** Bulk filters (--all, --unoptimized) dry-run unless --apply is passed. Explicit IDs execute immediately. Enforced via shared `resolveDryRun` helper.
- **Dual output modes:** Human-readable by default (with Ink-rendered progress for bulk ops); `--json` for machine consumption (NDJSON to stdout, structured warnings/errors to stderr). The MCP server and skill both consume `--json`. Treat --json output shapes as a public API.
- **Replace-in-place fallback chain:** WP-CLI → Enable Media Replace plugin → new attachment + references report → fail if --strict.
- **Lazy loading:** sharp, onnxruntime-node, and jsquash codecs are all lazy-loaded via dynamic `import()` so the CLI boots fast even if native binaries are missing.
- **Dry-run contract:** Every mutating command's `--json` dry-run uses `dryRun: true` discriminator + normalized `changes` block via `dryRunPayload()`.
- **Time-machine:** Every destructive op snapshots before-state for undo. Binary blobs for file ops, metadata deltas otherwise.

## State Management

- **SQLite (per-site, source of truth):** `$XDG_CONFIG_HOME/localpress/sites/<name>.db` — tracks attachments, content hashes, processing history, sessions/snapshots, watch mappings, preferences
- **Schema version:** 5 (see `src/engine/state/schema.ts`)
- **Config file:** `$XDG_CONFIG_HOME/localpress/config.json` (mode 0600) — sites, active site, App Passwords, defaults, profiles

## Config Location

- **macOS/Linux:** `~/.config/localpress/config.json`, sites at `~/.config/localpress/sites/<name>.db`
- **Windows:** `%APPDATA%\localpress\config.json`
- Respects `$XDG_CONFIG_HOME` if set

## 39 Commands

**Setup:** `init`, `sites`, `doctor`, `config`
**Discovery & audit:** `list`, `show`, `stats`, `audit`, `references`, `a11y`, `briefing`, `verify`
**AI vision:** `caption`, `title`, `describe`, `classify`, `tag`, `vision`, `metadata`, `rename`
**Processing:** `optimize`, `convert`, `resize`, `remove-bg`, `regenerate`
**Content:** `posts`, `delete`
**Round-trip & automation:** `edit`, `watch`, `watch-status`
**Data:** `pull`, `push`, `export`, `import`
**Time-machine:** `history`, `undo`
**Ops:** `update`, `completions`, `mcp`
