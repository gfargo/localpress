# localpress v2.0 — From Media Tool to WordPress Management Platform

A blog post / project update covering everything that shipped between v1.2 (the original blog post) and v2.0.0. Use this as a draft, hand it to a writing agent, or pull sections for social posts.

---

## The headline

localpress started as a media optimization CLI. With v2.0, it's now a full WordPress management platform — posts CRUD, accessibility auditing, AI vision metadata, and a 40-tool MCP server that makes it the most agent-composable WordPress tool in existence.

---

## What changed since the original launch post

The original blog post covered v1.2: 15 commands, image optimization, background removal, and the edit round-trip. Here's what shipped in the 20 releases since then:

### The numbers

| Metric | v1.2 (launch) | v2.0 (now) |
| ------ | ------------- | ---------- |
| CLI commands | 15 | 38+ |
| MCP tools | 0 (skill only) | 40+ |
| Unit tests | 36 | 191+ |
| AI models supported | 3 (U2-Net) | 5 ONNX + any Ollama vision model |
| Post types supported | — | posts, pages, any custom post type |

---

## The big new features

### 1. First-party MCP server (v1.14)

localpress now ships a built-in Model Context Protocol server. One line of config and any AI agent (Claude Desktop, Cursor, VS Code, Kiro) can manage your WordPress site:

```jsonc
{
  "mcpServers": {
    "localpress": { "command": "localpress", "args": ["mcp"] }
  }
}
```

40+ typed tools with structured JSON results. Agents get capability discovery, concurrency control, and time-machine undo on every operation. This isn't a wrapper around the CLI — it's a first-class integration surface.

### 2. Posts & pages CRUD (v2.0)

The expansion that changes localpress's identity. Full WordPress content management:

```bash
# List posts with filters
localpress posts list --status draft --search "tutorial"

# Create from a local file
localpress posts create --title "New Guide" --content-file ./guide.html --status draft

# Update and publish
localpress posts update 456 --status publish --featured-image 2189

# Works with any custom post type
localpress posts list --type portfolio
localpress posts create --type event --title "Summer Conference"
```

Agents can now create drafts, publish content, manage categories/tags, and set featured images — all through the same MCP server they use for media operations.

### 3. Accessibility audit (v2.0)

The `a11y` command checks every published post and page for WCAG issues:

```bash
localpress a11y --json
```

Checks:
- **Heading hierarchy** — skipped levels (h1 → h3), multiple h1 elements
- **Generic link text** — "click here", "read more", "here" (not descriptive)
- **Missing img alt** — `<img>` tags in content without alt attributes
- **Empty links** — `<a>` tags with no text and no aria-label

With 309 images missing alt text on a single test site, and government accessibility mandates (ADA, EU EAA) making this a legal compliance issue, this is the beginning of localpress as "the accessibility MCP."

### 4. AI vision metadata suite (v1.18)

Beyond alt-text generation, localpress now has a full AI vision pipeline:

```bash
# Generate everything in one pass
localpress vision 123 --apply

# Individual commands for fine control
localpress title --missing-title --apply     # 3-7 word noun-phrase titles
localpress describe 123 --apply              # 2-3 sentence descriptions
localpress classify 123                      # screenshot/photo/illustration/diagram
localpress tag --missing-tags --apply        # 3-6 keyword tags
localpress rename 123 --smart                # AI-generated slugs
```

All powered by local Ollama models. No cloud API, no credits, no data leaving your machine.

### 5. Time-machine undo (v1.15)

Every destructive operation now captures a snapshot before executing. Walk it back anytime:

```bash
# Undo the last operation
localpress undo

# Browse history
localpress history

# Restore a specific attachment to its previous state
localpress undo --attachment 123
```

Default retention: 2 GB per site. Agents get `undo` as a first-class MCP tool — they can experiment safely knowing everything is reversible.

### 6. Export / import (v1.13)

Full media library portability:

```bash
# Export with metadata manifest
localpress export --all --to ./backup.zip

# Import with optimization on upload
localpress import ./photos/ --optimize --to webp --preserve-ids
```

The manifest preserves alt text, titles, captions, and SHA-256 hashes for round-trip integrity. Site migrations in one command.

### 7. Watch command (v1.11)

Continuous directory sync — drop files in a folder, they appear in WordPress:

```bash
localpress watch ./assets/images --optimize --to webp
```

Debounced writes, SHA-256 deduplication, persistent file→attachment mappings in SQLite. Survives restarts.

### 8. Named optimization profiles (v1.13)

Reusable presets for consistent optimization across a team:

```bash
localpress config set-profile hero --quality 75 --format webp --max-width 1920
localpress optimize --unoptimized --profile hero --apply
```

Profiles appear in the browser preview UI dropdown and the interactive list's optimize overlay.

### 9. Multilingual captions (v1.13.1)

Generate alt text in any language the Ollama model supports:

```bash
localpress caption --missing-alt --language Spanish --apply
localpress caption 123 --language Japanese
```

### 10. Search by URL + health check (v2.0 MCP)

Agent-convenience tools that eliminate multi-step workarounds:

- **`search_by_url`** — paste a WordPress image URL, get the attachment details back instantly
- **`health_check`** — combined doctor + stats + audit in one parallel call

---

## The positioning shift

The original pitch was "bring your own GPU for image optimization." That's still true, but v2.0 reframes localpress as something bigger:

> **localpress is the WordPress CLI that AI agents reach for when they need to do real work on WordPress sites.**

Humans use it too — it's a great CLI. But the audience that scales from hundreds to hundreds of thousands of users is the agent population running on Claude Desktop, Cursor, VS Code, Kiro, and whatever comes next.

Every feature compounds this lead:
- 40+ MCP tools with stable schemas
- Local AI (no API costs in agent loops)
- Time-machine undo (agents can experiment safely)
- Per-operation history in SQLite (agents have memory)
- Capability discovery via doctor (agents adapt to each site)

---

## Updated competitive positioning

| | localpress v2.0 | EWWW | ShortPixel | Smush | WP-CLI |
| --- | --- | --- | --- | --- | --- |
| Where processing happens | User's laptop | WP server | Cloud | Cloud | WP server |
| Recurring cost | $0 | $0-25/mo | $3.99-9.99/mo | $3-13/mo | $0 |
| Posts CRUD | ✓ | ✗ | ✗ | ✗ | ✓ |
| AI alt-text (local) | ✓ | ✗ | ✗ | ✗ | ✗ |
| AI background removal | ✓ (local) | ✗ | ✓ (cloud) | ✗ | ✗ |
| Accessibility audit | ✓ | ✗ | ✗ | ✗ | ✗ |
| MCP server | ✓ (40+ tools) | ✗ | ✗ | ✗ | ✗ |
| Time-machine undo | ✓ | ✗ | ✗ | ✗ | ✗ |
| Round-trip editing | ✓ | ✗ | ✗ | ✗ | ✗ |
| Custom post types | ✓ | — | — | — | ✓ |
| Open source | MIT | GPLv3 | Proprietary | Mixed | MIT |

---

## What's next

- **v2.1** — SEO audit (meta titles/descriptions, sitemaps, redirects)
- **v2.2** — Multi-site bulk ops (`sites run`, `sites compare`, `sites migrate`)
- **v2.3** — Database maintenance (`db export/import`, `cleanup`, `plugins list/audit`)
- **v3.0** — Full platform (sync, deploy, backup/restore, WooCommerce)

The full roadmap has 450+ ideas across 61 domains: [docs/roadmap-ideas.md](https://github.com/gfargo/localpress/blob/main/docs/roadmap-ideas.md)

---

## Install / upgrade

```bash
# New install
brew install gfargo/tap/localpress

# Upgrade existing
brew upgrade localpress

# Or self-update
localpress update
```

---

## Links

| Resource | URL |
| -------- | --- |
| GitHub | [github.com/gfargo/localpress](https://github.com/gfargo/localpress) |
| Website | [localpress.griffen.codes](https://localpress.griffen.codes) |
| Docs | [localpress.griffen.codes/docs](https://localpress.griffen.codes/docs) |
| Wiki | [github.com/gfargo/localpress/wiki](https://github.com/gfargo/localpress/wiki) |
| Releases | [github.com/gfargo/localpress/releases](https://github.com/gfargo/localpress/releases) |
| Sponsor | [github.com/sponsors/gfargo](https://github.com/sponsors/gfargo) |

---

## Social-ready snippets

**Twitter/X (short):**
> localpress v2.0 shipped. 38 commands, 40 MCP tools. Posts CRUD, accessibility audit, AI vision metadata — all local, all free. It's not just a media optimizer anymore. github.com/gfargo/localpress

**Twitter/X (thread opener):**
> localpress started as "optimize WordPress images on your laptop." v2.0 makes it "manage your entire WordPress site from the terminal — and let AI agents do it too." Here's what shipped 🧵

**LinkedIn:**
> Shipped localpress v2.0 today. What started as a CLI for compressing WordPress images has grown into a full WordPress management platform with 38+ commands and a 40-tool MCP server.
>
> The big additions: posts/pages CRUD (including custom post types), WCAG accessibility auditing, AI-powered vision metadata (alt text, titles, descriptions, tags, classification), time-machine undo, and export/import for migrations.
>
> All processing happens on your hardware. No cloud SaaS, no recurring credits. The MCP server means AI agents in Claude Desktop, Cursor, or VS Code can manage WordPress sites autonomously.
>
> MIT licensed, Homebrew installable: github.com/gfargo/localpress

**HN title options:**
- "localpress v2.0 – Local-compute WordPress CLI with 40-tool MCP server"
- "Show HN: localpress – Manage WordPress from the terminal with AI agents (MIT)"
- "localpress: 38 CLI commands for WordPress, powered by local AI and MCP"
