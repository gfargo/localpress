# Project Structure

```
localpress/
├── src/
│   ├── types.ts                    # Shared types: SiteConfig, SshConfig, Config, ExitCode
│   ├── cli/
│   │   ├── index.ts                # Entry point — Commander setup, global flags, 24 commands
│   │   ├── commands/               # One file per CLI command (register pattern)
│   │   │   ├── init.ts             # Interactive site setup wizard (Ink)
│   │   │   ├── sites.ts            # List/switch/add/remove configured sites
│   │   │   ├── doctor.ts           # Backend availability, plugin detection, --fix
│   │   │   ├── config.ts           # Config get/set, named optimization profiles
│   │   │   ├── list.ts             # List media in WP library (filterable)
│   │   │   ├── show.ts             # Show details for a single attachment
│   │   │   ├── audit.ts            # Audit: unoptimized/large/missing-alt/display-size/duplicates/broken-refs
│   │   │   ├── optimize.ts         # Compress/convert media (marquee command, --profile)
│   │   │   ├── convert.ts          # Convert between formats (webp, avif, jpeg, png)
│   │   │   ├── resize.ts           # Resize preserving aspect ratio
│   │   │   ├── remove-bg.ts        # AI background removal (ONNX + system rembg)
│   │   │   ├── caption.ts          # AI alt-text via Ollama (--language, --all)
│   │   │   ├── export.ts           # Export media library as ZIP/directory with manifest
│   │   │   ├── import.ts           # Bulk import files/directories/ZIPs with optimization
│   │   │   ├── edit.ts             # Round-trip: download → editor → watch → sync
│   │   │   ├── watch.ts            # Continuous directory watcher → auto-push
│   │   │   ├── pull.ts             # Download media to local disk
│   │   │   ├── push.ts             # Upload local file to WP
│   │   │   └── references.ts       # Find where an attachment is used
│   │   ├── components/
│   │   │   └── InitWizard.tsx      # Ink React wizard for init command
│   │   └── utils/
│   │       ├── config.ts           # Config file load/save ($XDG_CONFIG_HOME/localpress/)
│   │       └── output.ts           # Output helpers: info/warn/error/printJson, --json/--quiet modes
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
│       │   └── jsquash.ts          # jSquash WASM codec integration
│       ├── rembg/
│       │   ├── models.ts           # ONNX model manager (download + cache)
│       │   ├── remove-bg.ts        # Background removal engine
│       │   ├── system-rembg.ts     # System Python rembg integration
│       │   └── onnx-types.ts       # Type declarations for onnxruntime-node
│       ├── editor/
│       │   ├── detect.ts           # Editor detection and launching
│       │   └── watcher.ts          # File watcher for edit round-trip
│       └── state/
│           ├── schema.ts           # SQL DDL, migrations array
│           └── db.ts               # SiteDb class wrapping bun:sqlite
├── test/
│   ├── unit/                       # Unit tests (bun test) — 36 tests
│   ├── integration/                # Integration tests (Dockerized WP) — 11 tests
│   └── fixtures/                   # Test data files
├── skill/
│   └── SKILL.md                    # AI agent skill — full command reference + JSON schemas
├── docs/
│   ├── localpress-competitive-brief.md  # Market analysis and positioning
│   ├── roadmap-ideas.md                 # Extension brainstorm (40+ ideas)
│   └── homebrew-tap.md                  # Homebrew tap setup guide
├── Formula/
│   └── localpress.rb                    # Homebrew formula (auto-updated on release)
├── CLAUDE.md                       # Implementation status, locked decisions, conventions
└── .github/
    └── workflows/
        ├── ci.yml                  # Lint + test on PR; binary builds on v* tag
        └── release.yml             # Build + release + Homebrew formula update
```

## Architecture: Two Surfaces, One Engine

The CLI is the product. The skill is a markdown instruction sheet for AI agents.

```
Skill (markdown) → Agent reads, decides, runs CLI
                        ↓
              localpress CLI (TS + Bun)
              ┌─────────────────────────┐
              │   Engine (TS library)   │
              │  • Image processing     │
              │  • State (SQLite)       │
              │  • Adapter resolution   │
              └─────────────────────────┘
                 │         │         │
            RestAdapter  WpCli    McpAdapter
            (always on)  (SSH)    (v1.x
                                  deferred)
                        ↓
              Remote WordPress (REST API / SSH)
```

## Three Architecture Layers

1. **CLI layer** (`src/cli/`) — User-facing commands. Each command file exports a `registerXxxCommand(program)` function that adds a Commander subcommand. Global flags (--site, --json, --quiet, --dry-run, --apply, --strict, --concurrency, --yes) are on the root program.

2. **Adapter layer** (`src/adapters/`) — WordPress communication. The `WpBackend` interface defines all operations. Each adapter declares its supported capabilities via a `Set<Capability>`. The `AdapterResolver` picks the best adapter per operation based on priority order (wp-cli > rest). MCP adapter is deferred to v1.x.

3. **Engine layer** (`src/engine/`) — Domain logic independent of WordPress or CLI concerns. Image processing (sharp + jsquash codecs), AI background removal (ONNX Runtime + U2-Net), SQLite state management (per-site databases), editor detection and file watching.

## Key Patterns

- **Command registration:** Each command file exports `registerXxxCommand(program: Command)` — called from `src/cli/index.ts`
- **Capability resolution:** Never call adapter methods directly when the capability might be unavailable. Use `resolver.tryResolve()` and handle `CapabilityUnavailableError` gracefully with actionable guidance.
- **Safe-by-default bulk ops:** Bulk filters (--all, --unoptimized) dry-run unless --apply is passed. Explicit IDs execute immediately.
- **Dual output modes:** Human-readable by default (with Ink-rendered progress for bulk ops); `--json` for machine consumption (NDJSON to stdout, structured warnings/errors to stderr). Skills always use --json. Treat --json output shapes as a public API.
- **Replace-in-place fallback chain:** WP-CLI → Enable Media Replace plugin → new attachment + references report → fail if --strict.
- **Lazy loading:** sharp, onnxruntime-node, and jsquash codecs are all lazy-loaded via dynamic `import()` so the CLI boots fast even if native binaries are missing.

## State Management

- **SQLite (per-site, source of truth):** `$XDG_CONFIG_HOME/localpress/sites/<name>.db` — tracks attachments, content hashes, processing history
- **WP post meta (eventually-consistent mirror, v1.x):** `_localpress_processed` meta key on each attachment — survives across machines, shareable across agency
- **Config file:** `$XDG_CONFIG_HOME/localpress/config.json` (mode 0600) — sites, active site, App Passwords

## Config Location

- **macOS/Linux:** `~/.config/localpress/config.json`, sites at `~/.config/localpress/sites/<name>.db`
- **Windows:** `%APPDATA%\localpress\config.json`
- Respects `$XDG_CONFIG_HOME` if set

## 21 Commands (all implemented)

Setup: `init`, `sites`, `doctor`
Config: `config`
Discovery: `list`, `show`, `stats`, `audit`, `references`
Processing: `optimize`, `convert`, `resize`, `remove-bg`, `caption`
Server-side: `regenerate`
Round-trip: `edit`
Low-level: `pull`, `push`
Maintenance: `update`, `completions`
