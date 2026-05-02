# localpress

> Your laptop, your library.

Local-compute WordPress media optimization. `localpress` is a CLI tool that uses your laptop's CPU and GPU to compress images, remove backgrounds, convert formats, and round-trip with desktop editors — then syncs the results back to your remote WordPress site via the REST API. No recurring credits. No cloud SaaS. No plugin to install on the WP side.

A companion **skill** (markdown only — no protocol code) teaches AI agents how to drive the CLI and compose it with whatever WordPress MCP server you already have connected.

> ⚠️ **Status: pre-v0.1 scaffold.** This repo is in early development. Most commands are stubs. See the [v1 plan](#planning-documents) for the roadmap.

---

## Why this exists

The dominant WordPress image-optimization plugins (Smush, ShortPixel, Imagify, Optimole) charge for cloud compute that modern laptops can do for free. EWWW does free local processing but requires server-side binaries that many shared hosts block. Nobody currently combines (a) WordPress-awareness, (b) processing on the *user's* local machine, and (c) round-trip workflows with desktop editors.

`localpress` fills that gap.

## Install

> Not yet published. v0.1 will ship via Homebrew tap and GitHub Releases as a Bun-compiled single-file binary (~50–100MB per platform).

For now, clone and run from source:

```bash
git clone https://github.com/gfargo/localpress.git
cd localpress
bun install
bun run dev -- --help
```

## Quick tour

```bash
# Connect a WP site (interactive Ink wizard)
localpress init

# See what backends and capabilities are available for the active site
localpress doctor

# List media in the library
localpress list --unoptimized

# Optimize a few attachments (compression + WebP/AVIF)
localpress optimize 123 124 125

# Optimize everything that hasn't been processed yet (dry-run by default)
localpress optimize --unoptimized
localpress optimize --unoptimized --apply

# Find every place an attachment is used
localpress references 1234
```

Full command surface is documented in [`docs/v1-plan.md`](docs/v1-plan.md).

## Architecture at a glance

```
┌──────────────┐    ┌──────────────────┐    ┌─────────────────┐
│  Skill (md)  │───→│  localpress CLI  │───→│  Remote WP site │
│  for agents  │    │  (TS + Bun)      │    │  (REST/SSH/MCP) │
└──────────────┘    └──────────────────┘    └─────────────────┘
                            │
                            ▼
                    ┌──────────────────┐
                    │  Adapter layer   │
                    │  REST | wp-cli   │
                    │  (best per op)   │
                    └──────────────────┘
```

The CLI talks to WordPress through a **backend adapter** that auto-detects what's available — REST API always, WP-CLI over SSH if configured, MCP if the user has a WP MCP server connected. The capability resolver picks the best backend per operation.

The skill — distributed separately as `skill/SKILL.md` — teaches an AI agent how to drive the CLI and compose it with whatever WordPress MCP server the agent already has. We don't ship our own WP MCP server.

## Planning documents

These docs live alongside the code and are the authoritative source for *what* and *why*:

- [`docs/competitive-brief.md`](docs/competitive-brief.md) — market analysis: who else is in this space, where the gap is, and how `localpress` is positioned against incumbents.
- [`docs/v1-plan.md`](docs/v1-plan.md) — implementation plan: architecture, command surface, adapter pattern, roadmap from v0.1 → v1.0, and a concrete starting checklist.

Read the v1 plan before contributing.

## Contributing

Pre-v0.1 — not yet accepting external contributions. Once v0.1 is tagged, see `CONTRIBUTING.md` (TBD).

## License

MIT. See [`LICENSE`](LICENSE).
