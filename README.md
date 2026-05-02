# localpress

> Your laptop, your library.

Local-compute WordPress media optimization. `localpress` is a CLI tool that uses your laptop's CPU and GPU to compress images, remove backgrounds, convert formats, and round-trip with desktop editors — then syncs the results back to your remote WordPress site via the REST API. No recurring credits. No cloud SaaS. No plugin to install on the WP side.

A companion **skill** (`skill/SKILL.md`) teaches AI agents how to drive the CLI and compose it with whatever WordPress MCP server you already have connected.

---

## Why this exists

The dominant WordPress image-optimization plugins (Smush, ShortPixel, Imagify, Optimole) charge for cloud compute that modern laptops can do for free. EWWW does free local processing but requires server-side binaries that many shared hosts block. Nobody currently combines (a) WordPress-awareness, (b) processing on the *user's* local machine, and (c) round-trip workflows with desktop editors.

`localpress` fills that gap.

## Install

> Homebrew tap and GitHub Releases binaries coming soon.

For now, clone and run from source:

```bash
git clone https://github.com/gfargo/localpress.git
cd localpress
bun install
bun run dev -- --help
```

Requires [Bun](https://bun.sh) >= 1.1.0.

## Quick tour

```bash
# Connect a WP site (interactive Ink wizard)
localpress init

# See what backends and capabilities are available
localpress doctor

# List media in the library
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

# Audit the library for issues
localpress audit
```

## Commands

| Command | Description |
| --- | --- |
| `init` | Connect a WordPress site (interactive Ink wizard) |
| `sites` | List, add, switch, or remove configured sites |
| `doctor` | Show backend availability and capability matrix |
| `list` | List media with filters (--unoptimized, --type, --larger-than) |
| `show <id>` | Show metadata and optimization history for an attachment |
| `audit` | Find unoptimized, large, missing-alt, and orphan media |
| `optimize` | Compress and optionally convert media (the marquee command) |
| `convert` | Convert between formats (webp, avif, jpeg, png) |
| `resize` | Resize preserving aspect ratio, regenerate WP thumbnails |
| `remove-bg` | AI background removal using local ONNX Runtime + U2-Net |
| `edit` | Open in desktop editor, watch for saves, sync back to WP |
| `pull` | Download attachments to local directory |
| `push` | Upload local files, with replace-in-place fallback |
| `references` | Find where an attachment is used across posts and pages |

All commands accept `--json` for machine-readable output (used by the skill for AI agent integration).

## Architecture

```
┌──────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Skill (md)  │───→│  localpress CLI  │───→│  Remote WP site │
│  for agents  │    │  (TS + Bun)      │    │  (REST/SSH)     │
└──────────────┘    └──────────────────┘    └─────────────────┘
                            │
                    ┌───────┴────────┐
                    │  Engine layer  │
                    │  sharp/jsquash │
                    │  ONNX Runtime  │
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

## Key behaviors

- **Safe by default:** Bulk operations (`--all`, `--unoptimized`) dry-run unless `--apply` is passed. Explicit IDs execute immediately.
- **Idempotent:** Re-running optimize on an already-processed attachment is a no-op if the source hasn't changed (SHA-256 hash comparison).
- **Replace-in-place fallback:** Tries WP-CLI first, falls back to new attachment + references report. `--strict` fails instead of falling back.

## Planning documents

- [`docs/localpress-competitive-brief.md`](docs/localpress-competitive-brief.md) — market analysis and competitive positioning.
- [`docs/localpress-v1-plan.md`](docs/localpress-v1-plan.md) — implementation plan: architecture, command surface, adapter pattern, roadmap.

## Development

```bash
bun install              # install deps
bun run dev -- --help    # run the CLI from source
bun run typecheck        # tsc --noEmit
bun run lint             # biome check
bun test                 # run unit tests
bun test test/unit/      # unit tests only
bun run build            # compile to single binary
bun run build:all        # cross-compile for all platforms
```

## License

MIT. See [`LICENSE`](LICENSE).
