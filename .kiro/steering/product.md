# Product: localpress

> "Your laptop, your library."

Local-compute WordPress management CLI. Uses the user's own CPU/GPU to optimize media, manage content, audit accessibility, and generate AI metadata — then syncs results back to a remote WordPress site via the REST API. No cloud SaaS, no recurring credits, no WP plugin required.

## Current status

**v2.0.0 — actively maintained.** 38+ CLI commands, 40+ MCP tools. Homebrew tap is live at `gfargo/homebrew-localpress`. GitHub Releases binaries are automated for darwin-arm64, darwin-x64, linux-arm64, linux-x64, and windows-x64.

## 38+ commands

**Setup:** `init`, `sites`, `doctor`, `config`
**Discovery:** `list`, `show`, `audit`, `references`, `stats`
**Processing:** `optimize`, `convert`, `resize`, `remove-bg`, `caption`, `metadata`
**AI Vision:** `title`, `describe`, `classify`, `tag`, `vision`, `rename`
**Content:** `posts` (list/show/create/update/delete — supports custom post types)
**Accessibility:** `a11y`
**Migration:** `export`, `import`
**Server-side:** `regenerate` (thumbnail rebuild via WP-CLI)
**Automation:** `watch`
**Round-trip:** `edit`
**Low-level:** `pull`, `push`, `delete`
**Time-machine:** `history`, `undo`
**Maintenance:** `update`, `completions`
**Server:** `mcp` (Model Context Protocol server with 40+ tools)

## Target audiences

1. Solo developers and small agencies running 1–20 WordPress sites who don't want recurring SaaS bills for image optimization (primary CLI users)
2. Privacy-conscious site owners who don't want images going to a third-party processor
3. AI-tool users (Claude Desktop, Cursor, VS Code, Kiro) who want agents to manage WordPress without a paid service (MCP users)
4. Accessibility-conscious teams needing automated WCAG auditing

## Competitive position

The market gap: no existing tool combines (a) WordPress-awareness, (b) processing on the user's local machine, (c) round-trip workflows with desktop editors, and (d) agent-native MCP integration. EWWW Image Optimizer is the closest competitor but runs binaries on the WordPress server, not the user's laptop. Cloud plugins (Smush, ShortPixel, Imagify, Optimole) charge for compute that modern laptops can do for free. No competitor offers posts CRUD + media optimization + accessibility auditing in a single agent-composable tool.

## Five differentiator pillars

1. "Bring your own GPU" — user's hardware does the work, no credits or recurring fees
2. "No host required" — works against any standard WP install via Application Passwords, even cheapest shared hosting
3. "Round-trip your real editor" — open in GIMP/Photoshop/Preview, save, sync back
4. "Agent-native" — first-party MCP server with 40+ typed tools, structured JSON, capability discovery
5. "Beyond media" — posts CRUD, accessibility audit, AI vision metadata — one tool for the whole site

## What localpress is NOT

- NOT a WordPress plugin — runs on the user's machine, talks to WP via REST API
- NOT a hosted service — the user's laptop is the runtime
- NOT trying to replace WordPress — it's a management layer on top

## Shipped roadmap

| Version | What shipped |
|---|---|
| v0.1–v0.4 | Foundation, WP-CLI adapter, background removal, edit round-trip |
| v1.0–v1.2 | Skill, Ink wizard, jSquash, advanced audit, Homebrew tap, config profiles |
| v1.3–v1.5 | Interactive TUI, caption (Ollama), stats, browser preview |
| v1.6–v1.10 | BiRefNet models, SSH wizard, update/completions, regenerate, sharp auto-install |
| v1.11–v1.13 | Watch command, tarball distribution, export/import, --profile, --language |
| v1.14–v1.16 | MCP server (32 tools), time-machine undo, metadata/delete/search, bulk tools |
| v1.17–v1.18 | Vision AI expansion (title/describe/classify/tag/rename), audit --quality/--ocr |
| v2.0.0 | Posts CRUD, accessibility audit, search_by_url, health_check, custom post types |

## Next milestones

- **v2.1** — SEO audit (meta titles/descriptions, sitemaps, redirects)
- **v2.2** — Multi-site bulk ops (`sites run`, `sites compare`, `sites migrate`)
- **v2.3** — Database maintenance (`db export/import`, `cleanup`, `plugins list/audit`)
- **v3.0** — Full platform (sync, deploy, backup/restore, WooCommerce)

## Key planning documents

- `docs/localpress-competitive-brief.md` — market analysis and positioning
- `docs/roadmap-ideas.md` — 450+ feature ideas across 61 domains
- `CLAUDE.md` — implementation status, locked decisions, conventions
