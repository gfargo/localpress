# CLAUDE.md — handoff for the next agent

You're picking up `localpress` at **v1.4.3**. The full v1.0 implementation plan is complete plus post-v1.0 enhancements. All 18 CLI commands are implemented and working. The project compiles, tests pass, and the CLI boots cleanly.

**Read in this order before writing any code:**

1. [`docs/localpress-competitive-brief.md`](docs/localpress-competitive-brief.md) — the *why*. Competitive landscape, positioning, the gap we're filling.
2. [`README.md`](README.md) — user-facing overview.
3. [`skill/SKILL.md`](skill/SKILL.md) — the AI agent skill with full command reference and JSON schemas.
4. This file — implementation status and conventions.

---

## Current status

**Version:** 1.4.3
**Status:** All v1.0 plan features complete. Post-v1.0 enhancements shipped: advanced audit checks, config management, Homebrew distribution, interactive TUI browser, AI captioning, cumulative stats, media sort.

### What's implemented

**18 CLI commands:**
- Setup: `init` (Ink wizard), `sites` (list/add/use/remove), `doctor` (capability matrix + plugin detection + `--fix`)
- Config: `config` (get/set/list, named optimization profiles)
- Discovery: `list` (filters, sort `--sort`/`--order`, interactive TUI `-i`), `show`, `stats` (cumulative SQLite stats, `--all-sites`), `audit` (unoptimized/large/missing-alt/orphans/display-size/duplicates/broken-refs), `references` (fast + full scan, `--update-to` rewriting)
- Processing: `optimize`, `convert`, `resize`, `remove-bg` (ONNX + system rembg), `caption` (local Ollama vision model, no cloud)
- Round-trip: `edit` (download → editor → watch → sync)
- Low-level: `pull`, `push`

**Two backend adapters:**
- `RestAdapter` — always available, Application Password auth, REST API CRUD + fast reference scanning
- `WpCliAdapter` — opt-in via SSH, adds replace-in-place, thumbnail regeneration, orphan pruning, full reference scanning + rewriting

**Image processing:**
- sharp (libvips) as the default encoding backend
- jSquash WASM codecs as alternative (`--encoder jsquash`) — OxiPNG for PNG, MozJPEG, WebP, AVIF
- AI background removal via ONNX Runtime + U2-Net (3 models: u2net, u2netp, silueta)
- Optional system Python rembg via `--rembg` flag

**AI captioning:**
- Local Ollama vision models — no cloud API, no credits
- `caption --missing-alt` bulk-captions everything with no alt text
- `caption --list-models` shows locally available vision models
- Recommended model: `moondream` (~1.7 GB, fast); `llava` for higher quality
- See [Ollama Setup guide](https://localpress.griffen.codes/docs/ollama-setup)

**State management:**
- SQLite per-site databases with attachment tracking and processing history
- Idempotent processing via SHA-256 hash comparison
- Schema migrations support
- `stats` command exposes cumulative savings, per-operation breakdown, last-run dates

**Config management:**
- Named optimization profiles (`config set-profile hero --quality 75 --format webp --max-width 1920`)
- Global defaults (`config set defaults.quality 80`)
- Scalar config read/write (`config get/set`)
- Full config listing with password redaction

**Distribution:**
- Homebrew tap at `gfargo/homebrew-localpress`
- GitHub Releases with binaries for 5 platforms (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64)
- Automated release workflow: build → checksum → release → update formula

**Testing:**
- 36 unit tests (SQLite, config, adapter resolver)
- 9 integration tests (Docker WordPress, fully passing — including write-auth via Application Passwords)

**CI:**
- GitHub Actions: typecheck + lint + unit tests on PR
- Integration tests against Dockerized WordPress (with proper pretty-permalinks + Apache auth-header passthrough)
- Binary builds + GitHub Release + Homebrew formula update on v* tag

### Release history

| Tag | What shipped |
|---|---|
| v0.1.0 | Foundation: SQLite, config, REST adapter, 10 commands, image engine, integration tests |
| v0.2.0 | WP-CLI adapter, convert, resize, full audit, full references + rewriting |
| v0.3.0 | AI background removal (ONNX Runtime + U2-Net, 3 models) |
| v0.4.0 | Edit round-trip workflow (download → editor → watch → sync) |
| v1.0.0 | Full skill, --rembg flag for system Python rembg |
| v1.1.0 | Ink interactive wizard, jSquash WASM codec integration |
| v1.2.0 | Advanced audit (display-size, duplicates, broken-refs), doctor --fix + plugin detection, config command + named profiles, Homebrew tap |
| v1.3.0 | Interactive TUI media browser (`list -i`) with inline thumbnails, spinner, page-nav hints |
| v1.3.1 | TypeScript narrowing fix for `list --interactive`; TUI sidebar thumbnail always-on |
| v1.4.0 | `caption` command (local Ollama alt-text), `stats` command, `list --sort`/`--order`, integration test CI fixes |
| v1.4.1 | `list -i` preview on-demand (`[p]`), full-screen overlay mode, no more layout gaps from iTerm2 escape sequences |
| v1.4.2 | `list -i` live search (`/`), client-side filter by filename/title, two-stage Esc behaviour |
| v1.4.3 | CI docker compose rewrite (no more services: block), setup-wp.sh consolidation, all 9 integration tests local-reproducible via `act` |

---

## Locked architectural decisions

These were debated and resolved during planning. **Don't relitigate without strong cause.**

| Decision | Choice | Why |
|---|---|---|
| Language / runtime | TypeScript on Bun | Maintainer fluency + `--compile` for single-binary distribution + native `bun:sqlite` and `fetch` |
| Linter / formatter | Biome | Single tool, fast, modern defaults |
| Test runner | `bun test` | Bundled, no extra dep; runs `.ts` directly |
| License | MIT | Matches the rembg/Squoosh/sharp ecosystem; agency-friendly |
| Image processing | sharp + @jsquash WASM codecs | sharp for transforms, jsquash for encoding when `--encoder jsquash` |
| AI background removal | `onnxruntime-node` + U2-Net ONNX models | `@imgly/background-removal-node` is **AGPL-3.0** — incompatible with MIT |
| AI captioning | Ollama HTTP API (local) | No cloud dependency; `moondream` runs fast on CPU; user owns their data |
| WP integration | REST (always) + WP-CLI over SSH (opt-in) + MCP adapter (deferred to v1.x) | Auto-detect; pick best per operation |
| Replace-in-place | Default; falls back to new attachment + references report | REST API cannot replace attachment file bytes |
| State management | SQLite (source of truth) + WP post meta mirror (v1.x) | Local fast cache + portable |
| Bulk safety | Dry-run by default for `--all` / `--unoptimized`; explicit IDs execute | Don't surprise users |
| Auth storage | Plain config file, mode 0600 | System keychain is a v1.x upgrade |
| Skill (no MCP server) | Markdown skill that drives the CLI | Composes with whatever WP MCP the user has |
| Distribution | Bun-compiled binaries via Homebrew tap + GitHub Releases | No npm; single binary, no runtime deps |

---

## Project conventions

**Imports:** path imports use `.ts` extension (Bun-native). Use `@/` alias for absolute imports from `src/`.

**Error handling:** CLI commands let unhandled errors bubble to `main()` in `src/cli/index.ts`. Use `ExitCode` enum from `src/types.ts` for known failure modes.

**Output:** never `console.log` directly. Use `info()` / `warn()` / `error()` / `printJson()` from `src/cli/utils/output.ts`. They respect `--json` and `--quiet`.

**Capability resolution:** never call adapter methods directly when the capability might be unavailable. Use `resolver.tryResolve()` and handle `CapabilityUnavailableError` gracefully.

**`--json` output stability:** the skill consumes `--json`. Treat the JSON shapes as a public API.

**Lazy loading:** sharp, onnxruntime-node, and jsquash codecs are all lazy-loaded via dynamic `import()` so the CLI boots fast even if native binaries are missing.

**Command registration:** each command file exports `registerXxxCommand(program: Command)`, called from `src/cli/index.ts`.

---

## Things that are tempting but wrong

- **Don't ship a companion WordPress plugin.** Use REST + Application Passwords + opt-in WP-CLI.
- **Don't bundle `@imgly/background-removal-node`.** AGPL-3.0.
- **Don't build a custom MCP server.** Ship the markdown skill instead.
- **Don't use a cloud vision API for `caption`.** Ollama keeps processing local and free.

---

## Repo map

```
localpress/
├── CLAUDE.md                         ← you are here
├── README.md                         ← user-facing overview
├── CHANGELOG.md                      ← release history
├── LICENSE                           ← MIT
├── package.json                      ← Bun + TS deps; build/test scripts
├── tsconfig.json                     ← strict, ESM, bundler resolution
├── biome.json                        ← lint/format config
├── Formula/
│   └── localpress.rb                 ← Homebrew formula (auto-updated on release)
├── docs/
│   ├── localpress-competitive-brief.md  ← market analysis
│   ├── roadmap-ideas.md                 ← extension brainstorm (40+ ideas)
│   └── homebrew-tap.md                  ← Homebrew tap setup guide
├── src/
│   ├── types.ts                      ← shared types (SiteConfig, ExitCode, OptimizationProfile)
│   ├── cli/
│   │   ├── index.ts                  ← entry point; commander setup, 18 commands
│   │   ├── commands/                 ← one file per command (all implemented)
│   │   │   ├── init.ts, sites.ts, doctor.ts, config.ts
│   │   │   ├── list.ts, show.ts, stats.ts, audit.ts, references.ts
│   │   │   ├── optimize.ts, convert.ts, resize.ts, remove-bg.ts, caption.ts
│   │   │   ├── edit.ts, pull.ts, push.ts
│   │   ├── components/
│   │   │   ├── InitWizard.tsx        ← Ink React wizard for init
│   │   │   └── MediaBrowser.tsx      ← Ink TUI for list --interactive
│   │   └── utils/
│   │       ├── config.ts             ← config file load/save
│   │       └── output.ts             ← info/warn/error/printJson
│   ├── adapters/
│   │   ├── types.ts                  ← WpBackend interface, capabilities
│   │   ├── rest.ts                   ← RestAdapter (implemented)
│   │   ├── wp-cli.ts                 ← WpCliAdapter (implemented)
│   │   ├── ssh.ts                    ← SSH/SCP execution helper
│   │   └── resolver.ts              ← AdapterResolver
│   └── engine/
│       ├── image/
│       │   ├── types.ts              ← ImageFormat, OptimizeOptions
│       │   ├── optimize.ts           ← Image optimization engine (sharp + jsquash)
│       │   └── jsquash.ts            ← jSquash WASM codec integration
│       ├── caption/
│       │   ├── ollama.ts             ← Ollama HTTP API client (isAvailable, generate, listModels)
│       │   └── types.ts              ← CaptionResult, CaptionOptions
│       ├── rembg/
│       │   ├── models.ts             ← ONNX model manager (download + cache)
│       │   ├── remove-bg.ts          ← Background removal engine
│       │   ├── system-rembg.ts       ← System Python rembg integration
│       │   └── onnx-types.ts         ← Type declarations for onnxruntime-node
│       ├── editor/
│       │   ├── detect.ts             ← Editor detection and launching
│       │   └── watcher.ts            ← File watcher for edit round-trip
│       └── state/
│           ├── schema.ts             ← SQL DDL, migrations
│           └── db.ts                 ← SiteDb wrapper (bun:sqlite) + getStats()
├── test/
│   ├── unit/
│   │   ├── smoke.test.ts             ← adapter/type tests
│   │   ├── db.test.ts                ← SQLite tests
│   │   └── config.test.ts            ← config tests
│   ├── integration/
│   │   ├── docker-compose.yml        ← WordPress 6.7 + MySQL 8.0
│   │   ├── setup-wp.sh               ← WP-CLI setup + test data
│   │   └── wp-rest.test.ts           ← 9 integration tests (fully passing)
│   └── fixtures/
├── skill/
│   └── SKILL.md                      ← Full AI agent skill with JSON schemas
├── .wiki/                            ← GitHub Wiki source (committed here)
│   ├── Commands-Reference.md
│   ├── Ollama-Setup.md
│   └── ...
├── .tap/                             ← Homebrew tap repo checkout (gitignored)
└── .github/
    └── workflows/
        ├── ci.yml                    ← Unit + integration tests; binary builds on tag
        └── release.yml               ← Build + release + Homebrew formula update
```

---

## How to run things

```bash
bun install              # install deps
bun run dev -- --help    # run the CLI from source
bun run typecheck        # tsc --noEmit
bun run lint             # biome check
bun run lint:fix         # biome check --write
bun run format           # biome format --write
bun test                 # all tests
bun test test/unit/      # unit tests only
bun run build            # single binary at ./dist/localpress
bun run build:all        # binaries for all 5 platforms
```

---

## What's left (v1.x and beyond)

These are deferred features from the plan, not blocking any release. See `docs/roadmap-ideas.md` for the full brainstorm.

- **McpAdapter** — third backend adapter for users with a WP MCP server connected
- **Multi-site bulk operations** — `--all-sites` flag or `localpress sites run`
- **`watch` command** — continuous directory sync to WordPress
- **Scheduled audits** — cron mode or `--watch`
- **System keychain integration** — macOS Keychain / Windows Credential Manager
- **Auto-update mechanism** — notify-only vs apply
- **Scoop manifest** for Windows
- **WP post meta state mirror** — `_localpress_processed` meta key for cross-machine state sharing
