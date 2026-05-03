# localpress

> Your laptop, your library.

Local-compute WordPress media optimization. `localpress` is a CLI tool that uses your laptop's CPU and GPU to compress images, remove backgrounds, convert formats, and round-trip with desktop editors — then syncs the results back to your remote WordPress site via the REST API. No recurring credits. No cloud SaaS. No plugin to install on the WP side.

A companion **skill** (`skill/SKILL.md`) teaches AI agents how to drive the CLI and compose it with whatever WordPress MCP server you already have connected.

---

## Why this exists

The dominant WordPress image-optimization plugins (Smush, ShortPixel, Imagify, Optimole) charge for cloud compute that modern laptops can do for free. EWWW does free local processing but requires server-side binaries that many shared hosts block. Nobody currently combines (a) WordPress-awareness, (b) processing on the *user's* local machine, and (c) round-trip workflows with desktop editors.

`localpress` fills that gap.

---

## Install

### Homebrew (macOS / Linux)

```bash
brew tap gfargo/localpress
brew install localpress
```

Or in one step:

```bash
brew install gfargo/localpress/localpress
```

### Pre-built binaries

Download from the [releases page](https://github.com/gfargo/localpress/releases). Binaries are available for macOS (arm64/x64), Linux (arm64/x64), and Windows (x64).

### From source

Requires [Bun](https://bun.sh) >= 1.1.0.

```bash
git clone https://github.com/gfargo/localpress.git
cd localpress
bun install
bun run dev -- --help
```

---

## Quick start

```bash
# Connect a WordPress site (interactive Ink wizard)
localpress init

# See what backends and capabilities are available
localpress doctor

# Check for relevant WP plugins and potential conflicts
localpress doctor --plugins

# List unoptimized images in the library
localpress list --unoptimized

# Optimize a few attachments (compression + WebP/AVIF)
localpress optimize 123 124 125

# Optimize everything unprocessed (dry-run by default, --apply to execute)
localpress optimize --unoptimized --apply

# Convert to WebP
localpress convert 123 124 --to webp

# Resize to max 1200px wide
localpress resize 123 --max-width 1200

# Remove background using local AI (downloads model on first use)
localpress remove-bg 123

# Open in your editor, watch for saves, sync back automatically
localpress edit 123

# Find every place an attachment is used
localpress references 1234

# Generate alt text for all images missing it (requires Ollama)
localpress caption --missing-alt

# View cumulative processing stats
localpress stats

# Sort media by file size, largest first
localpress list --sort size

# Audit the library for issues (oversized, duplicates, broken refs, and more)
localpress audit
```

---

## Commands

| Command | Description |
| --- | --- |
| `init` | Connect a WordPress site (interactive Ink wizard) |
| `sites` | List, add, switch, or remove configured sites |
| `doctor` | Show backend availability, capability matrix, plugin detection, `--fix` |
| `config` | Read/write config values, manage named optimization profiles |
| `list` | List media with filters, sorting (`--sort size`/`name`/`id`), and interactive TUI |
| `show <id>` | Show metadata and optimization history for an attachment |
| `stats` | Cumulative processing stats from local SQLite — files touched, bytes saved, per-op breakdown |
| `audit` | Find unoptimized, large, missing-alt, oversized, duplicate, and orphan media |
| `optimize` | Compress and optionally convert media (the marquee command) |
| `convert` | Convert between formats (webp, avif, jpeg, png) |
| `resize` | Resize preserving aspect ratio, regenerate WP thumbnails |
| `caption` | AI alt-text generation using a local [Ollama](https://ollama.com) vision model — no cloud API |
| `remove-bg` | AI background removal using local ONNX Runtime + U2-Net |
| `edit` | Open in desktop editor, watch for saves, sync back to WP |
| `pull` | Download attachments to local directory |
| `push` | Upload local files, with replace-in-place fallback |
| `references` | Find where an attachment is used across posts and pages |

All commands accept `--json` for machine-readable output (used by the skill for AI agent integration).

---

## Audit checks

The `audit` command runs multiple checks in a single pass:

| Flag | What it finds |
| --- | --- |
| `--unoptimized` | Images not yet processed by localpress |
| `--large` | Images larger than `--threshold` (default 1 MB) |
| `--missing-alt` | Images without alt text |
| `--display-size` | Images significantly larger than their largest registered WP thumbnail |
| `--duplicates` | Perceptually identical or near-identical images (dHash via sharp) |
| `--broken-refs` | Attachment URLs that return 404 or are unreachable |
| `--orphans` | Files on disk with no DB record (requires WP-CLI) |

Run with no flags to execute all REST-based checks at once.

---

## Config & profiles

```bash
# Set global defaults
localpress config set defaults.quality 80
localpress config set defaults.format webp

# Create a named optimization profile
localpress config set-profile hero --quality 75 --format webp --max-width 1920 --description "Hero images"
localpress config set-profile thumbnail --quality 85 --max-width 400 --strip-metadata

# List profiles
localpress config list-profiles

# Use a profile (coming soon in optimize --profile)
localpress config get-profile hero
```

---

## Global flags

| Flag | Effect |
| --- | --- |
| `--site <name>` | Override the active site for this command |
| `--json` | Machine-readable NDJSON output |
| `--quiet` | Errors only; suppress info messages |
| `--dry-run` | Show what would happen without executing |
| `--apply` | Execute bulk operations (overrides default dry-run) |
| `--strict` | Fail loudly when capability fallbacks would activate |
| `--concurrency <n>` | Parallel workers for bulk ops (default: CPU count − 1) |
| `--yes` | Skip confirmation prompts |

---

## Architecture

```text
┌──────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Skill (md)  │───▶│  localpress CLI  │───▶│  Remote WP site │
│  for agents  │    │  (TS + Bun)      │    │  (REST / SSH)   │
└──────────────┘    └──────────────────┘    └─────────────────┘
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

The CLI talks to WordPress through a **backend adapter** that auto-detects what's available — REST API always, WP-CLI over SSH if configured. The capability resolver picks the best backend per operation.

**Two encoding backends:** sharp (default, native libvips) or jSquash WASM codecs (`--encoder jsquash`) for OxiPNG-level PNG compression and cross-platform consistency.

**AI background removal:** ONNX Runtime + U2-Net models (Apache-2.0), or system Python rembg via `--rembg` flag.

**AI alt-text generation:** `caption` command drives a local [Ollama](https://ollama.com) vision model — no cloud API, no credits, no data leaving your machine. Recommended model: `moondream` (~1.7 GB). See the [Ollama Setup guide](https://localpress.griffen.codes/docs/ollama-setup).

---

## Key behaviors

**Safe by default for bulk ops.** `optimize --all` and `optimize --unoptimized` dry-run unless `--apply` is passed. Explicit IDs execute immediately.

**Idempotent.** Re-running optimize on an already-processed attachment is a no-op if the source hasn't changed (SHA-256 hash comparison). Safe to run repeatedly.

**Replace-in-place fallback.** Tries WP-CLI first (if SSH is configured), falls back to new attachment + references report. `--strict` fails instead of falling back.

**Background removal models.** Downloads on first use and caches locally. Available models: `u2net` (~176MB, best quality), `u2netp` (~4.7MB, fast), `silueta` (~44MB, balanced). Use `--rembg` to shell out to system Python rembg instead.

---

## AI agent integration

The `skill/SKILL.md` file is a complete instruction sheet for AI agents (Claude Desktop, Cursor, VS Code with MCP, etc.). It covers:

- When to invoke localpress vs. the user's existing WP MCP server
- Full command reference with `--json` output schemas
- Composition patterns for mixed WP MCP + localpress workflows
- Error codes and handling guidance

Always pass `--json` when running from an agent — the human-readable output is not designed for parsing.

---

## Development

```bash
bun install              # install deps
bun run dev -- --help    # run the CLI from source
bun run typecheck        # tsc --noEmit
bun run lint             # biome check
bun test                 # run all tests (36 unit + 9 integration)
bun test test/unit/      # unit tests only
bun run build            # compile to single binary at ./dist/localpress
bun run build:all        # cross-compile for all 5 platforms
```

Integration tests require Docker. They spin up WordPress 6.7 + MySQL 8.0 via `test/integration/docker-compose.yml` and are skipped automatically when the environment variables aren't set.

---

## Docs

- [`docs/localpress-competitive-brief.md`](docs/localpress-competitive-brief.md) — market analysis and competitive positioning
- [`docs/roadmap-ideas.md`](docs/roadmap-ideas.md) — extension brainstorm with 40+ ideas
- [`docs/homebrew-tap.md`](docs/homebrew-tap.md) — Homebrew tap setup and release checklist
- [`CLAUDE.md`](CLAUDE.md) — implementation status, locked decisions, and conventions for contributors

---

## License

MIT. See [`LICENSE`](LICENSE).
