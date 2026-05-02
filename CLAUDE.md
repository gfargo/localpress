# CLAUDE.md — handoff for the next agent

You're picking up `localpress` at **v1.1.0**. The full v1.0 implementation plan is complete. All 14 CLI commands are implemented and working. The project compiles, tests pass, and the CLI boots cleanly.

**Read in this order before writing any code:**

1. [`docs/localpress-v1-plan.md`](docs/localpress-v1-plan.md) — the implementation plan. Architecture, command surface, adapter pattern, roadmap.
2. [`docs/localpress-competitive-brief.md`](docs/localpress-competitive-brief.md) — the *why*. Competitive landscape, positioning, the gap we're filling.
3. [`README.md`](README.md) — user-facing overview.
4. [`skill/SKILL.md`](skill/SKILL.md) — the AI agent skill with full command reference and JSON schemas.
5. This file — implementation status and conventions.

---

## Current status

**Version:** 1.1.0
**Status:** All v1.0 plan features complete. Post-v1.0 polish shipped.

### What's implemented

**14 CLI commands:**
- Setup: `init` (Ink wizard), `sites` (list/add/use/remove), `doctor` (capability matrix)
- Discovery: `list`, `show`, `audit` (unoptimized/large/missing-alt/orphans), `references` (fast + full scan, `--update-to` rewriting)
- Processing: `optimize`, `convert`, `resize`, `remove-bg` (ONNX + system rembg)
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

**State management:**
- SQLite per-site databases with attachment tracking and processing history
- Idempotent processing via SHA-256 hash comparison
- Schema migrations support

**Testing:**
- 36 unit tests (SQLite, config, adapter resolver)
- 11 integration tests (Docker WordPress, skip when env vars not set)

**CI:**
- GitHub Actions: typecheck + lint + unit tests on PR
- Integration tests against Dockerized WordPress
- Binary builds for 5 platforms on v* tag

### Release history

| Tag | What shipped |
|---|---|
| v0.1.0 | Foundation: SQLite, config, REST adapter, 10 commands, image engine, integration tests |
| v0.2.0 | WP-CLI adapter, convert, resize, full audit, full references + rewriting |
| v0.3.0 | AI background removal (ONNX Runtime + U2-Net, 3 models) |
| v0.4.0 | Edit round-trip workflow (download → editor → watch → sync) |
| v1.0.0 | Full skill, --rembg flag for system Python rembg |
| v1.1.0 | Ink interactive wizard, jSquash WASM codec integration |

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
| WP integration | REST (always) + WP-CLI over SSH (opt-in) + MCP adapter (deferred to v1.x) | Auto-detect; pick best per operation |
| Replace-in-place | Default; falls back to new attachment + references report | REST API cannot replace attachment file bytes |
| State management | SQLite (source of truth) + WP post meta mirror (v1.x) | Local fast cache + portable |
| Bulk safety | Dry-run by default for `--all` / `--unoptimized`; explicit IDs execute | Don't surprise users |
| Auth storage | Plain config file, mode 0600 | System keychain is a v1.x upgrade |
| Skill (no MCP server) | Markdown skill that drives the CLI | Composes with whatever WP MCP the user has |

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
├── docs/
│   ├── localpress-competitive-brief.md  ← market analysis
│   └── localpress-v1-plan.md            ← implementation plan (the spec)
├── src/
│   ├── types.ts                      ← shared types (SiteConfig, ExitCode)
│   ├── cli/
│   │   ├── index.ts                  ← entry point; commander setup, 14 commands
│   │   ├── commands/                 ← one file per command (all implemented)
│   │   │   ├── init.ts, sites.ts, doctor.ts
│   │   │   ├── list.ts, show.ts, audit.ts, references.ts
│   │   │   ├── optimize.ts, convert.ts, resize.ts, remove-bg.ts
│   │   │   ├── edit.ts, pull.ts, push.ts
│   │   ├── components/
│   │   │   └── InitWizard.tsx        ← Ink React wizard for init
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
│           └── db.ts                 ← SiteDb wrapper (bun:sqlite)
├── test/
│   ├── unit/
│   │   ├── smoke.test.ts             ← 10 adapter/type tests
│   │   ├── db.test.ts                ← 17 SQLite tests
│   │   └── config.test.ts            ← 9 config tests
│   ├── integration/
│   │   ├── docker-compose.yml        ← WordPress 6.7 + MySQL 8.0
│   │   ├── setup-wp.sh               ← WP-CLI setup + test data
│   │   └── wp-rest.test.ts           ← 11 integration tests
│   └── fixtures/
├── skill/
│   └── SKILL.md                      ← Full AI agent skill with JSON schemas
└── .github/
    └── workflows/
        └── ci.yml                    ← Unit + integration tests; binary builds on tag
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

These are deferred features from the plan, not blocking any release:

- **McpAdapter** — third backend adapter for users with a WP MCP server connected
- **Multi-site bulk operations** — `--all-sites` flag or `localpress sites run`
- **Scheduled audits** — cron mode or `--watch`
- **System keychain integration** — macOS Keychain / Windows Credential Manager
- **Telemetry** — opt-in/opt-out, not decided
- **Auto-update mechanism** — notify-only vs apply
- **Scoop manifest** for Windows
- **npm distribution** — open question given Bun binaries
