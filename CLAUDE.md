# CLAUDE.md — handoff for the next agent

You're picking up `localpress` at **v2.1.0**. All 39 CLI commands are implemented and working, including a first-party MCP server. The project compiles, tests pass, and the CLI boots cleanly.

**Read in this order before writing any code:**

1. [`README.md`](README.md) — user-facing overview, install, quick start, MCP setup.
2. [`docs/blog-post-v2.md`](docs/blog-post-v2.md) — the *why* behind the v2.0 pivot from "media optimizer" to full WordPress content/AI workstation.
3. [`skill/SKILL.md`](skill/SKILL.md) — the AI agent skill with full command reference and JSON schemas.
4. This file — implementation status and conventions.

---

## Current status

**Version:** 2.1.0
**Status:** All planned v1.0 features plus the full v2.0 content/AI/MCP expansion have shipped. `CHANGELOG.md` is the authoritative release history — this file gives a summary, not a substitute.

### What's implemented

**39 CLI commands**, grouped by area:

- **Setup:** `init` (Ink wizard), `sites` (list/add/use/remove/run), `doctor` (capability matrix + plugin detection + `--fix`), `config` (get/set/list, named optimization profiles)
- **Discovery & audit:** `list` (filters, sort, interactive TUI `-i`), `show`, `stats` (cumulative SQLite stats, `--all-sites`), `audit` (unoptimized/large/missing-alt/orphans/display-size/duplicates/broken-refs/`--quality`/`--ocr-text`), `references` (fast + full scan, `--update-to` rewriting), `a11y` (WCAG audit for post/page content), `briefing` (aggregated site-health digest + Ollama narrative)
- **AI enrichment (local Ollama vision, no cloud):** `caption` (alt text), `title`, `describe`, `classify` (screenshot/photo/illustration/diagram, feeds `optimize` format defaults), `tag`, `vision` (composed alt+title+description+tags+classify in one pass), `metadata` (manual alt/title/caption/description writes)
- **Processing:** `optimize` (+ `--preview`, `--target-size`), `convert`, `resize`, `remove-bg` (ONNX + system rembg + `--preview`), `regenerate` (thumbnails), `rename` (slug rename, `--smart`)
- **Content management:** `posts` (list/show/create/update/delete for posts, pages, and custom post types), `delete` (attachments, trash or `--force`)
- **Round-trip & automation:** `edit` (download → editor → watch → sync), `watch` / `watch-status` (continuous directory sync)
- **History / safety:** `history`, `undo` (time-machine snapshot restore)
- **Low-level & ops:** `pull`, `push`, `export`, `import`, `update` (self-update), `completions`
- **Integration:** `mcp` (starts the first-party MCP server)

**Two backend adapters** (a third, `McpAdapter`, for users who already have a WP-connected MCP server as their *backend*, remains deferred — see `src/adapters/types.ts`):

- `RestAdapter` — always available, Application Password auth, REST API CRUD + fast reference scanning
- `WpCliAdapter` — opt-in via SSH, adds replace-in-place, thumbnail regeneration, orphan pruning, full reference scanning + rewriting

**Image processing:**
- sharp (libvips) as the default encoding backend
- jSquash WASM codecs as alternative (`--encoder jsquash`) — OxiPNG for PNG, MozJPEG, WebP, AVIF
- AI background removal via ONNX Runtime + 5 models: u2net, u2netp, silueta, isnet-general-use, birefnet-lite (MIT, state-of-the-art)
- Optional system Python rembg via `--rembg` flag
- Browser-based preview for `optimize` and `remove-bg` (`--preview` flag) — local Bun HTTP server with before/after comparison, parameter adjustment, and one-click upload to WordPress
- `--target-size` binary-searches quality to hit a file-size budget

**AI vision suite (local Ollama, no cloud API, no credits):**
- `caption`, `title`, `describe`, `classify`, `tag`, `vision` all share the same Ollama plumbing and time-machine safety net
- `--missing-alt` / `--missing-title` / `--missing-description` bulk-fill only what's absent
- `--list-models` shows locally available vision models
- Recommended model: `moondream` (~1.7 GB, fast); `llava` for higher quality
- See the Ollama setup notes in the README

**State management:**
- SQLite per-site databases with attachment tracking and processing history
- Idempotent processing via SHA-256 hash comparison
- Schema migrations — currently **schema v4** (see `src/engine/state/schema.ts`): v2 added the `preferences` table (UI state persistence), v3 added `watch_mappings` (directory-watch file→attachment tracking), v4 added `sessions` + `snapshots` (time-machine/undo)
- `stats` command exposes cumulative savings, per-operation breakdown, last-run dates
- Interactive browser position persistence across sessions (page + cursor saved to SQLite)

**Time-machine / undo:**
- Every mutating command snapshots before-state (binary blobs for file-changing ops, metadata deltas otherwise) into `sessions`/`snapshots`
- `history` lists past sessions; `undo <session-id>` restores
- Global `--dry-run` is honored consistently across destructive commands (`delete`, `posts delete`, `posts update`, `metadata`, `references --update-to`) via a shared `resolveDryRun` helper

**Config management:**
- Named optimization profiles (`config set-profile hero --quality 75 --format webp --max-width 1920`)
- Global defaults (`config set defaults.quality 80`, `config set defaults.captionModel llava-llama3:latest`)
- Scalar config read/write (`config get/set`)
- Full config listing with password redaction

**MCP server (`localpress mcp`):**
- First-party Model Context Protocol server exposing 47+ typed tools + resources — the CLI's full capability surface (media CRUD, posts CRUD, a11y audit, history/undo, export/import, health_check, search_by_url) available directly to any MCP-speaking agent host
- See `src/cli/mcp/{server,tools,invoke,resources}.ts` and the README's MCP section for setup

**Distribution:**
- Homebrew tap at `gfargo/homebrew-tap`
- GitHub Releases with binaries/tarballs for 5 platforms (darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64)
- `localpress update` self-update from a released tarball
- **Automated, conventional-commit-driven releases** via release-please: merging
  the auto-maintained "Release vX.Y.Z" PR cuts the tag → builds → checksums →
  GitHub Release → Homebrew formula bump. See **[Releasing](#releasing)** below.

**Testing:**
- 232 test cases across 23 files: unit tests (`test/unit/`), integration tests against Dockerized WordPress (`test/integration/`, fully passing — including write-auth via Application Passwords), and tarball smoke tests (`test/tarball/`, exercise the built binary end-to-end)

**CI:**
- GitHub Actions: typecheck + lint + unit tests on PR
- Integration tests against Dockerized WordPress (with proper pretty-permalinks + Apache auth-header passthrough)
- PR-title lint (conventional commits) so squash-merge subjects drive versioning
- release-please maintains the Release PR; merging it builds binaries/tarballs +
  GitHub Release + Homebrew formula update (see **[Releasing](#releasing)**)

### Release history

Full details in [`CHANGELOG.md`](CHANGELOG.md) — this is a summary of major milestones, not a replacement.

| Tag | What shipped |
|---|---|
| v0.1.0–v0.4.0 | Foundation: SQLite, config, REST + WP-CLI adapters, image engine, AI background removal, edit round-trip, integration tests |
| v1.0.0–v1.6.0 | Full skill, Ink init wizard, jSquash codecs, advanced audit, `config` command, Homebrew tap, interactive TUI media browser, `caption`/`stats` commands, browser-based preview for optimize/remove-bg |
| v1.7.0–v1.11.x | SSH config hardening, `update` + `completions` + `regenerate` commands, Sharp auto-install, `watch` command, tarball distribution |
| v1.12.0–v1.13.1 | Replace-in-place format conversion, `export`/`import` commands, `--profile` on optimize, bulk-caption safety flags |
| v1.14.0 | **First-party MCP server** (`localpress mcp`) — 20 tools + 3 resources |
| v1.15.0–v1.15.2 | Time-machine/undo (`history`, `undo`, schema v4), MCP fixes, replace-in-place path/regeneration fixes |
| v1.16.0–v1.16.1 | `metadata` + `delete` commands, `list --search`, `watch-status`, MCP surface → 27 tools |
| v1.17.0–v1.17.1 | Caption model config + pre-flight check, caption output cleanup/truncation safeguards |
| v1.18.0 | Vision-AI expansion: `title`, `describe`, `rename`, `classify`, `tag`, `vision` commands; `audit --quality`/`--ocr-text`; MCP surface → 33 tools |
| v2.0.0 | **`posts` command** (full post/page/CPT CRUD), **`a11y` command** (WCAG audit), matching MCP tools, `health_check`/`search_by_url` MCP tools — localpress becomes a WordPress content/accessibility tool, not just a media optimizer |
| v2.1.0 | Trust & correctness hardening: dry-run/idempotency/reference-rewrite safety fixes across `references`, `delete`, `posts`, `metadata`, `optimize`, `remove-bg` (see CHANGELOG for the full list) |

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
| AI background removal | `onnxruntime-node` + U2-Net/ISNet/BiRefNet ONNX models | `@imgly/background-removal-node` is **AGPL-3.0** — incompatible with MIT |
| AI captioning / vision | Ollama HTTP API (local) | No cloud dependency; `moondream` runs fast on CPU; user owns their data |
| WP integration | REST (always) + WP-CLI over SSH (opt-in); `McpAdapter` backend still deferred | Auto-detect; pick best per operation |
| **Agent integration** | **First-party MCP server (`localpress mcp`), shipped v1.14.0, alongside the markdown skill** | **Reverses the original "no MCP server" call.** At planning time we assumed composing with whatever WP MCP the user already had was enough; in practice agent hosts wanted one typed tool surface that talks straight to the CLI's capability layer (dry-run, resolver, snapshots) rather than re-deriving REST calls themselves. The skill still works standalone; the MCP server is the deeper integration for MCP-native hosts. |
| Replace-in-place | Default; falls back to new attachment + references report | REST API cannot replace attachment file bytes |
| State management | SQLite (source of truth), schema v4 | Local fast cache + portable; migrations tracked in `src/engine/state/schema.ts` |
| Bulk safety | Dry-run by default for `--all` / `--unoptimized`; explicit IDs execute; enforced via shared `resolveDryRun` helper | Don't surprise users |
| Auth storage | Plain config file, mode 0600 | System keychain remains a future upgrade |
| Distribution | Bun-compiled binaries/tarballs via Homebrew tap + GitHub Releases | No npm; single binary, no runtime deps |

---

## Project conventions

**Imports:** path imports use `.ts` extension (Bun-native). Use `@/` alias for absolute imports from `src/`.

**Error handling:** CLI commands let unhandled errors bubble to `main()` in `src/cli/index.ts`. Use `ExitCode` enum from `src/types.ts` for known failure modes.

**Output:** never `console.log` directly. Use `info()` / `warn()` / `error()` / `printJson()` from `src/cli/utils/output.ts`. They respect `--json` and `--quiet`.

**Capability resolution:** never call adapter methods directly when the capability might be unavailable. Use `resolver.tryResolve()` and handle `CapabilityUnavailableError` gracefully.

**`--json` output stability:** the skill and the MCP server both consume `--json`. Treat the JSON shapes as a public API.

**Dry-run:** destructive/bulk commands route through the shared `resolveDryRun` helper rather than checking `--dry-run` ad hoc — keep new destructive commands consistent with this.

**Lazy loading:** sharp, onnxruntime-node, and jsquash codecs are all lazy-loaded via dynamic `import()` so the CLI boots fast even if native binaries are missing.

**Command registration:** each command file exports `registerXxxCommand(program: Command)`, called from `src/cli/index.ts`.

**No AI attribution in pushed artifacts:** never add "Generated with Claude Code" / "Co-Authored-By" footers, session links, or any AI-tool attribution to PR titles/bodies, commit messages, code comments, or anything else committed or pushed. Write them as a human maintainer would. (Some tooling appends these by default — strip them.)

---

## Things that are tempting but wrong

- **Don't ship a companion WordPress plugin.** Use REST + Application Passwords + opt-in WP-CLI.
- **Don't bundle `@imgly/background-removal-node`.** AGPL-3.0.
- **Don't use a cloud vision API for `caption`/`title`/`describe`/`classify`/`tag`/`vision`.** Ollama keeps processing local and free.

(The MCP server *was* built — see the "Agent integration" row above. Don't remove it or treat it as out of scope; it's now a supported integration path.)

---

## Repo map

```
localpress/
├── CLAUDE.md                         ← you are here
├── README.md                         ← user-facing overview
├── CHANGELOG.md                      ← release history (release-please maintains the top)
├── LICENSE                           ← MIT
├── release-please-config.json        ← release automation config (bump rules, changelog sections)
├── .release-please-manifest.json     ← current released version (source of truth for next bump)
├── package.json                      ← Bun + TS deps; build/test scripts
├── tsconfig.json                     ← strict, ESM, bundler resolution
├── biome.json                        ← lint/format config
├── Formula/
│   └── localpress.rb                 ← Homebrew formula (auto-updated on release)
├── docs/
│   ├── blog-post-v2.md               ← v2.0 announcement / positioning writeup
│   └── roadmap-ideas.md              ← extension brainstorm
├── scripts/
│   └── build-tarball.ts              ← distribution tarball builder
├── bin/
│   └── screenshot/                   ← VHS-based screenshot/GIF generation pipeline
├── src/
│   ├── types.ts                      ← shared types (SiteConfig, ExitCode, OptimizationProfile)
│   ├── cli/
│   │   ├── index.ts                  ← entry point; commander setup, 37 commands
│   │   ├── commands/                 ← one file per command (37 total)
│   │   │   ├── init.ts, sites.ts, doctor.ts, config.ts
│   │   │   ├── list.ts, show.ts, stats.ts, audit.ts, references.ts, a11y.ts, briefing.ts
│   │   │   ├── caption.ts, title.ts, describe.ts, classify.ts, tag.ts, vision.ts, metadata.ts
│   │   │   ├── optimize.ts, convert.ts, resize.ts, remove-bg.ts, regenerate.ts, rename.ts
│   │   │   ├── posts.ts, delete.ts
│   │   │   ├── edit.ts, watch.ts, watch-status.ts, pull.ts, push.ts
│   │   │   ├── export.ts, import.ts, update.ts, completions.ts
│   │   │   ├── history.ts, undo.ts, mcp.ts
│   │   ├── components/
│   │   │   ├── InitWizard.tsx        ← Ink React wizard for init
│   │   │   ├── MediaBrowser.tsx      ← Ink TUI for list --interactive
│   │   │   └── HistoryBrowser.tsx    ← Ink TUI for history/undo browsing
│   │   ├── mcp/
│   │   │   ├── server.ts             ← MCP server entry (localpress mcp)
│   │   │   ├── tools.ts              ← tool definitions (47+ typed tools)
│   │   │   ├── invoke.ts             ← tool → CLI invocation bridge
│   │   │   └── resources.ts          ← MCP resources
│   │   └── utils/
│   │       ├── config.ts             ← config file load/save
│   │       ├── output.ts             ← info/warn/error/printJson
│   │       ├── prompt.ts, run-mode.ts, self-invoke.ts
│   ├── adapters/
│   │   ├── types.ts                  ← WpBackend interface, capabilities
│   │   ├── rest.ts                   ← RestAdapter (implemented)
│   │   ├── wp-cli.ts                 ← WpCliAdapter (implemented)
│   │   ├── ssh.ts                    ← SSH/SCP execution helper
│   │   └── resolver.ts               ← AdapterResolver
│   └── engine/
│       ├── image/                    ← optimize.ts, jsquash.ts, sharp-loader.ts, types.ts
│       ├── caption/                  ← ollama.ts, run-bulk.ts, types.ts (shared by caption/title/describe/classify/tag/vision)
│       ├── rembg/                    ← models.ts, remove-bg.ts, system-rembg.ts, onnx-types.ts
│       ├── preview/                  ← server.ts, ui-optimize.ts, ui-remove-bg.ts, quick-view.ts
│       ├── editor/                   ← detect.ts, watcher.ts (edit round-trip)
│       ├── history/                  ← index.ts, store.ts, types.ts (time-machine snapshots)
│       └── state/
│           ├── schema.ts             ← SQL DDL, migrations (schema v4)
│           └── db.ts                 ← SiteDb wrapper (bun:sqlite) + getStats()
├── test/
│   ├── unit/                         ← 21 files (db, config, ssh, mcp, history, export-import, profile, stats, ...)
│   ├── integration/
│   │   ├── docker-compose.yml        ← WordPress + MySQL
│   │   ├── setup-wp.sh               ← WP-CLI setup + test data
│   │   └── wp-rest.test.ts           ← integration tests against live WP
│   ├── tarball/
│   │   └── smoke.test.ts             ← built-binary end-to-end smoke tests
│   └── fixtures/
├── skill/
│   └── SKILL.md                      ← Full AI agent skill with JSON schemas
└── .github/
    └── workflows/
        ├── ci.yml                    ← Unit + integration tests on PR/push
        ├── pr-title-lint.yml         ← Conventional-commit PR-title check
        ├── release-please.yml        ← Maintains the Release PR; cuts tag on merge
        ├── release-build.yml         ← Reusable: build → checksum → release → formula
        └── release.yml               ← Manual fallback: build/publish on a hand-pushed v* tag
```

---

## Releasing

Releases are **automated and conventional-commit-driven** — you don't hand-pick
version numbers or write release notes by hand anymore. The version comes from
the commit types since the last release; the notes come from the commit
subjects.

### How a release happens (the normal path)

1. **Land conventional commits on `main`.** Because we squash-merge, the *PR
   title* becomes the single commit subject — so the PR title is what matters.
   `pr-title-lint.yml` enforces the format on every PR.
2. **release-please opens/updates a "Release vX.Y.Z" PR** (`release-please.yml`
   runs on each push to `main`). It computes the next version from the commits,
   and stages the `package.json` bump + a generated `CHANGELOG.md` section. This
   PR sits open and keeps updating itself as more commits land — it's the
   human-approval gate.
3. **Merge the Release PR when you want to ship.** On merge, release-please
   creates the `vX.Y.Z` tag + a GitHub Release (with generated notes) and sets
   `release_created=true`.
4. **That triggers the build** (`release-please.yml` calls the reusable
   `release-build.yml`): typecheck + unit tests → 5-platform binaries/tarballs →
   `checksums.txt` → uploads them to the Release → bumps `Formula/localpress.rb`
   and pushes it to both `main` and the `gfargo/homebrew-tap` → triggers a
   rebuild of the marketing site (`gfargo/localpress-www`) via its Vercel
   Deploy Hook, same mechanism `rebuild-on-wiki.yml` already uses for wiki
   changes.

That's it — merging one PR is the whole release.

### How the version is decided (semver from commit types)

| Commit type on `main` | Bump | Example |
|---|---|---|
| `fix:` | patch | 2.1.0 → 2.1.1 |
| `feat:` | minor | 2.1.0 → 2.2.0 |
| `feat!:` / `BREAKING CHANGE:` footer | major | 2.1.0 → 3.0.0 |
| `docs:` `chore:` `refactor:` `test:` `ci:` `build:` `perf:` | none on their own | — |

`perf:` shows in the changelog but doesn't force a release by itself; the
type→section mapping lives in `release-please-config.json` (keep it in sync with
the allowed `types` in `pr-title-lint.yml`).

### The pieces

- **`.github/workflows/release-please.yml`** — runs on push to `main`; maintains
  the Release PR and, on merge, tags + calls the build.
- **`.github/workflows/release-build.yml`** — reusable (`workflow_call`) build +
  publish + Homebrew pipeline, parameterized by tag. Single source of truth for
  "what a release produces."
- **`.github/workflows/release.yml`** — manual fallback. Push a `v*` tag by hand
  (`git tag -a v2.2.0 -m v2.2.0 && git push origin v2.2.0`) and it runs the same
  `release-build.yml`. Use only if the automated flow is wedged.
- **`.github/workflows/pr-title-lint.yml`** — conventional-commit check on PR
  titles (accurate versioning depends on it, since we squash-merge).
- **`release-please-config.json`** — bump rules, changelog sections, tag format
  (`vX.Y.Z`, no component prefix).
- **`.release-please-manifest.json`** — the current released version
  (`{ ".": "2.1.0" }`). release-please reads and updates this; it's the source of
  truth for computing the next bump. **Don't hand-edit it** except to correct a
  drift.

### Gotchas / invariants (don't break these)

- **Don't manually bump `package.json` or hand-write the top `CHANGELOG.md`
  section** — release-please owns both. Manual edits fight the Release PR.
- **The tag → build link relies on staying in one workflow.** A tag created by
  release-please uses `GITHUB_TOKEN`, which by GitHub's design does *not* trigger
  the `on: push: tags` workflow (`release.yml`) — that's why the build is invoked
  directly from `release-please.yml` via `needs`/`if`, not by listening for the
  tag. Don't "simplify" this into a tag-listener; it will silently stop building.
- **`HOMEBREW_TAP_TOKEN`** (repo secret, PAT with `repo` scope on
  `gfargo/homebrew-tap`) must be present or the tap-push step no-ops (the Release
  itself still succeeds).
- **`VERCEL_DEPLOY_HOOK`** (repo secret, same Vercel Deploy Hook URL
  `rebuild-on-wiki.yml` uses) triggers a `localpress-www` rebuild at the end of
  every release build. Missing it just skips the trigger — doesn't fail the
  release. Create it in Vercel → Project → Settings → Git → Deploy Hooks if it
  isn't already set from the wiki-rebuild setup.
- The formula commit back to `main` carries `[skip ci]` so it doesn't spin up
  another release-please run.
- `release-build.yml` creates the Release only if one doesn't already exist, so
  the manual-tag path works too (no release-please pre-created one there).

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
bun run build:all        # binaries/tarballs for all 5 platforms
```

---

## What's left

The only architecturally-deferred item from the original plan that's still genuinely undone:

- **`McpAdapter`** — a third *backend* adapter for users who want localpress to talk to WordPress *through* an already-connected WP MCP server, instead of REST/WP-CLI directly (distinct from the first-party MCP *server* localpress now ships, which exposes localpress *to* agents). See the comment in `src/adapters/types.ts`.

For broader open-ended ideas (not committed work), see `docs/roadmap-ideas.md`.
