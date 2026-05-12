# localpress — Roadmap & Feature Brainstorm

A living document of ideas for extending localpress beyond its current media-optimization core. Organized by domain, with effort estimates and strategic notes. Nothing here is committed — it's a menu to pick from.

**Current state (v1.16.0):** 30 CLI commands, 32 MCP tools, media optimization + AI captioning + background removal + export/import + time-machine undo. The foundation (REST adapter, WP-CLI over SSH, SQLite state, MCP server, Ollama integration) supports expansion into broader WordPress management.

---

## ✅ Shipped (for reference)

These ideas from the original brainstorm are now implemented:

- ~~`audit --display-size`~~ → v1.2
- ~~`audit --duplicates`~~ → v1.2
- ~~`audit --broken-refs`~~ → v1.2
- ~~`optimize --profile`~~ → v1.13
- ~~`caption` (AI alt-text)~~ → v1.4 (Ollama-based, multilingual)
- ~~`watch` command~~ → v1.11
- ~~`export`/`import`~~ → v1.13
- ~~`config` command~~ → v1.2
- ~~Shell completions~~ → v1.8
- ~~`stats` command~~ → v1.4
- ~~Homebrew tap~~ → v1.2
- ~~`localpress update`~~ → v1.8
- ~~`doctor --fix` + plugin detection~~ → v1.2
- ~~`metadata` command~~ → v1.16
- ~~`delete` command~~ → v1.16
- ~~`list --search`~~ → v1.16
- ~~MCP server (32 tools)~~ → v1.14–v1.16

---

## 1. MCP & Agent Experience

### 1a. `search_by_url` — Reverse URL lookup

Given a full image URL (from post content or user input), resolve it to an attachment ID instantly. Eliminates paginating through `list` to find a specific image.

```
search_by_url { url: "https://site.com/wp-content/uploads/2026/05/hero.png" }
→ { id: 2189, filename: "hero.png", ... }
```

**Effort:** Low (URL path parsing + REST API query by slug)

### 1b. `bulk_metadata` — Batch metadata updates

Accept an array of `{id, altText?, title?, caption?, description?}` objects in one MCP call. Reduces 309 sequential tool invocations to 1 for bulk alt-text fixes.

**Effort:** Low (loop over existing `update_metadata` logic)

### 1c. `health_check` — Combined status tool

Single MCP tool that returns doctor + stats + audit summary in one call. Agents often want "what's the state of this library?" without 3 round-trips.

**Effort:** Low (compose existing commands)

### 1d. `diff` — Show what changed

Compare current state vs last snapshot for an attachment. "What did optimize do?" — format, dimensions, metadata, bytes, all in one structured response.

**Effort:** Low (read from history + current state)

### 1e. `batch_optimize` — Per-item settings

Accept `[{id: 123, quality: 75, format: "webp"}, {id: 456, profile: "thumbnail"}]` — different settings per item in one call. Reduces round-trips for agents triaging an audit.

**Effort:** Medium (new dispatch logic in optimize)

### 1f. `cost_estimate` — Predict bulk operation time/savings

"If I optimize these 45 images, how long and how much space?" Based on historical averages from stats. Helps agents give users a heads-up before long operations.

**Effort:** Low (math on existing stats data)

### 1g. MCP resources expansion

- `localpress://library-summary` — total count, size, format breakdown (no network call)
- `localpress://profiles` — all named profiles for agent reference
- `localpress://recent-operations` — last 10 operations for context

**Effort:** Low (read from SQLite)

---

## 2. Content Management

### 2a. `posts list/show/create/update`

CRUD for posts and pages via REST API. Filter by status, category, author, date. The adapter layer already talks to `/wp-json/wp/v2/posts`.

```bash
localpress posts list --status draft --json
localpress posts show 456 --json
localpress posts create --title "New Post" --status draft --content-file ./post.md
```

**Effort:** Medium (new adapter methods, new command files)
**Strategic value:** Very high — transforms localpress from media tool to WordPress management platform

### 2b. `posts publish/draft/trash`

Lifecycle management. Bulk schedule, bulk unpublish, bulk trash old drafts.

```bash
localpress posts publish 456 457 458
localpress posts trash --older-than 90d --status draft --apply
```

### 2c. `posts search`

Full-text search across post content. Find posts mentioning a keyword, containing a specific shortcode, or linking to a URL.

```bash
localpress posts search "broken-link.jpg" --json
localpress posts search --shortcode "gallery" --json
```

### 2d. `posts export` — Markdown export

Export posts as markdown files with YAML frontmatter. Mirror of media export but for content.

```bash
localpress posts export --all --to ./content/
localpress posts export --category "tutorials" --to ./tutorials/
```

### 2e. `posts import` — Markdown/HTML import

Import markdown or HTML files as WordPress posts. Bulk content migration from static sites, Ghost, Hugo, Jekyll.

```bash
localpress posts import ./hugo-content/ --status draft
localpress posts import ./migration/ --preserve-dates --apply
```

### 2f. `content audit`

Find broken internal links, orphan pages (no parent/menu), thin content (< 300 words), posts with no featured image, posts with no categories/tags, stale drafts.

```bash
localpress content-audit --json
localpress content-audit --broken-links --thin-content --no-featured-image
```

---

## 3. SEO & Performance

### 3a. `seo audit`

Check meta titles/descriptions (via Yoast/RankMath REST fields if available), find missing meta, duplicate titles, titles too long/short, missing canonical URLs, missing Open Graph images.

```bash
localpress seo audit --json
localpress seo audit --missing-meta --duplicate-titles
```

**Effort:** Medium (depends on SEO plugin REST extensions)

### 3b. `seo bulk-meta` — AI-generated SEO metadata

Use Ollama to generate meta titles and descriptions for posts missing them. Like `caption` but for SEO.

```bash
localpress seo generate --missing-meta --model llava-llama3 --apply
```

### 3c. `lighthouse` — Performance tracking

Run Lighthouse/PageSpeed against specific URLs. Track scores over time in SQLite. Alert when performance drops below threshold.

```bash
localpress lighthouse https://site.com/ --json
localpress lighthouse --sitemap --threshold 80
```

**Effort:** High (external tool integration, score storage)

### 3d. `cache warm`

Hit every public URL to prime caches after a deploy or cache flush. Crawl the sitemap.

```bash
localpress cache warm --sitemap --concurrency 5
```

### 3e. `sitemap validate`

Fetch and validate the XML sitemap. Find URLs that 404, pages excluded that shouldn't be, missing images in image sitemap.

```bash
localpress sitemap validate --json
```

---

## 4. Theme & Plugin Management

### 4a. `plugins list/activate/deactivate/update`

Plugin management via WP-CLI over SSH. Agents could manage plugin state.

```bash
localpress plugins list --json
localpress plugins update --all --apply
localpress plugins deactivate jetpack
```

**Effort:** Low (WP-CLI commands already exist, just need command wrappers)

### 4b. `themes list/activate`

Switch themes, check active theme info, list installed themes.

```bash
localpress themes list --json
localpress themes activate flavor-developer
```

### 4c. `plugins audit`

Find outdated plugins, plugins with known vulnerabilities (cross-reference WPScan API), inactive plugins wasting space, plugins not updated in 2+ years.

```bash
localpress plugins audit --json
localpress plugins audit --vulnerabilities --outdated
```

### 4d. `scaffold`

Generate starter theme files, child themes, or plugin boilerplate locally and push to the site via SSH.

```bash
localpress scaffold child-theme flavor-developer-child
localpress scaffold plugin my-custom-plugin
```

---

## 5. Database & Maintenance

### 5a. `db export/import`

Dump and restore the WordPress database via WP-CLI. Essential for migrations.

```bash
localpress db export --to ./backup.sql.gz
localpress db import ./backup.sql.gz --site staging
```

**Effort:** Low (thin wrapper around `wp db export/import`)

### 5b. `db search-replace`

Run `wp search-replace` for domain migrations (http→https, staging→production, old-domain→new-domain).

```bash
localpress db search-replace "staging.example.com" "example.com" --dry-run
```

### 5c. `cleanup`

Remove post revisions older than N days, auto-drafts, trashed posts, spam comments, expired transients. Reclaim database bloat.

```bash
localpress cleanup --revisions-older-than 30d --spam --trash --apply
localpress cleanup --transients --auto-drafts --dry-run
```

### 5d. `options get/set`

Read and write WordPress options (site title, permalink structure, timezone, etc.) via REST or WP-CLI.

```bash
localpress options get blogname
localpress options set permalink_structure "/%postname%/"
```

### 5e. `cron list/run`

View and trigger WordPress cron jobs via WP-CLI. Find stuck or overdue cron events.

```bash
localpress cron list --json
localpress cron run wp_scheduled_auto_draft_delete
```

---

## 6. Users & Security

### 6a. `users list/create/update/delete`

User management via REST API. Filter by role, search by name/email.

```bash
localpress users list --role administrator --json
localpress users create --username editor1 --email editor@example.com --role editor
```

### 6b. `users audit`

Find admin accounts with weak indicators, dormant users (no login in 6+ months), users with excessive capabilities, orphan users (no posts).

```bash
localpress users audit --dormant 180d --json
```

### 6c. `app-passwords rotate`

Generate a new Application Password and update the local config atomically. Security hygiene automation.

```bash
localpress app-passwords rotate --site production
```

### 6d. `security audit`

Check file permissions (via WP-CLI), wp-config.php exposure, debug mode enabled in production, directory listing enabled, XML-RPC enabled unnecessarily.

```bash
localpress security audit --json
```

---

## 7. Deployment & Sync

### 7a. `sync` — Bidirectional site sync

Two-way sync between two configured sites (staging ↔ production). Media, posts, or both. Conflict detection via timestamps and content hashes.

```bash
localpress sync --from staging --to production --media --dry-run
localpress sync --from production --to staging --posts --apply
```

**Effort:** High (conflict resolution, selective sync, state tracking)
**Strategic value:** Very high for agencies

### 7b. `deploy`

Push local theme/plugin files to the remote via SSH/SCP. Atomic deployment with rollback capability.

```bash
localpress deploy ./theme/ --to /var/www/html/wp-content/themes/flavor-developer/
localpress deploy --rollback
```

### 7c. `backup full`

Combine `db export` + `export --all` into a single timestamped backup. Optionally push to S3/R2 via presigned URLs.

```bash
localpress backup --to ./backups/
localpress backup --to s3://my-bucket/backups/ --include-db --include-media
```

### 7d. `restore`

Reverse of backup. Import database + media from a backup archive.

```bash
localpress restore ./backups/2026-05-12-full.tar.gz --site staging
```

### 7e. `diff sites`

Compare two configured sites: what posts/media/plugins differ between staging and production. Useful before deploying.

```bash
localpress diff --from staging --to production --json
```

---

## 8. Multi-Site & Agency

### 8a. `sites run <command>` — Cross-site execution

Run any localpress command against all configured sites (or a named subset).

```bash
localpress sites run "audit --json" --sites production,staging
localpress sites run "optimize --unoptimized --apply" --all-sites
localpress sites run "plugins update --all --apply" --all-sites
```

**Effort:** Medium
**Strategic value:** Very high for agencies managing 10+ sites

### 8b. `sites compare` — Cross-site library diff

Compare media libraries of two sites. Report what's in one but not the other.

```bash
localpress sites compare production staging --json
```

### 8c. `sites migrate <from> <to>` — Cross-site migration

Copy attachments (or posts) from one site to another with optional re-optimization. Handle URL rewriting in content.

```bash
localpress sites migrate staging production --ids 123 124 125
localpress sites migrate old-site new-site --all --optimize --to webp
```

### 8d. Per-site defaults

Site-specific default quality, format, concurrency stored in config. Commands inherit site defaults unless overridden.

```json
{
  "sites": {
    "production": { "defaults": { "quality": 80, "format": "webp" } },
    "staging": { "defaults": { "quality": 60, "format": "avif" } }
  }
}
```

---

## 9. AI & Smart Features

### 9a. `tag` — AI keyword/category tagging

Generate descriptive tags for images using a vision model. Write to WP attachment taxonomy. Improves media library searchability.

```bash
localpress tag --untagged --model llava-llama3 --apply
localpress tag 123 --json
```

### 9b. `upscale` — AI super-resolution

Use Real-ESRGAN ONNX model to upscale low-resolution images. Useful for legacy content predating high-DPI displays.

```bash
localpress upscale 123 --scale 2x
localpress upscale --smaller-than 800 --apply
```

**Effort:** High (new ONNX model integration, large model files)

### 9c. `describe` — Detailed image analysis

Run a vision model to produce structured descriptions: objects detected, colors, text in image (OCR), scene type. Richer than caption's alt-text output.

```bash
localpress describe 123 --json
# → { "objects": ["mug", "desk", "laptop"], "text": ["EveryKey"], "scene": "office" }
```

### 9d. `generate post` — AI content drafting

Use Ollama to draft a blog post from a prompt, outline, or existing content. Write to WordPress as a draft.

```bash
localpress generate post --prompt "Tutorial on image optimization for WordPress" --status draft
```

### 9e. `summarize` — Auto-excerpts

Generate excerpts for posts that don't have one. Like caption but for post content.

```bash
localpress summarize --missing-excerpt --apply
```

### 9f. `translate`

Translate posts/pages to another language using a local model. Create translated copies as drafts.

```bash
localpress translate 456 --to Spanish --status draft
localpress translate --all --to French --apply
```

### 9g. `remove-bg --subject <type>` — Subject-aware routing

Hint the subject type to route to the best model: `--subject person` → BiRefNet, `--subject product` → ISNet, `--subject general` → U2-Net.

### 9h. `smart-crop` — AI attention-based cropping

Use sharp's attention/entropy crop or a dedicated model to generate social media thumbnails from landscape photos.

```bash
localpress smart-crop 123 --aspect 1:1 --strategy attention
localpress smart-crop 123 --aspect 16:9 --strategy entropy
```

---

## 10. Media Processing Enhancements

### 10a. `optimize --target-size <bytes>`

Binary-search the quality parameter to hit a target file size. Useful for hero images with strict performance budgets.

```bash
localpress optimize 123 --target-size 100kb
```

### 10b. `optimize --watermark <file>`

Composite a watermark (logo, copyright) onto attachments. Support position, opacity, margin.

```bash
localpress optimize 123 --watermark ./logo.png --watermark-position bottom-right --watermark-opacity 0.3
```

### 10c. `convert --to jxl` — JPEG XL support

Add JPEG XL as a target format when browser support matures. Better compression than AVIF for photos, lossless JPEG re-encoding.

### 10d. `resize --crop <gravity>` — Smart cropping

Crop mode for resize: `--crop center`, `--crop attention`, `--crop entropy`.

```bash
localpress resize 123 --width 800 --height 800 --crop attention
```

### 10e. `remove-bg --feather <px>` — Edge feathering

Post-process the alpha mask with Gaussian blur on edges to reduce the "cut-out" look.

### 10f. `audit --exif` — Privacy audit

Scan for EXIF data that shouldn't be public: GPS coordinates, device serial numbers, author names. Report without stripping.

### 10g. `audit --format-opportunities`

For each JPEG/PNG, estimate savings from WebP/AVIF conversion. Output a ranked "convert these first" list.

### 10h. `optimize --strip-metadata` granular control

Fine-grained: `--keep-copyright`, `--keep-icc-profile`, `--strip-gps`. For agencies preserving copyright while removing location.

---

## 11. Monitoring & Reporting

### 11a. `report` — Generate client reports

PDF/markdown report: library health, SEO scores, performance metrics, security findings. Agencies deliver these to clients.

```bash
localpress report --format pdf --to ./reports/may-2026.pdf
localpress report --format markdown --to ./reports/
```

### 11b. `--webhook <url>` — Post-operation notifications

After bulk operations, POST a JSON summary to a webhook. Slack notifications, CI pipelines, dashboards.

```bash
localpress optimize --unoptimized --apply --webhook https://hooks.slack.com/...
```

### 11c. `uptime check`

Ping the site periodically, log response times, alert on downtime. Lightweight monitoring.

```bash
localpress uptime --interval 5m --alert-webhook https://...
```

### 11d. `changelog generate`

Auto-generate a site changelog from recent post/page/media changes. "What changed this week?"

```bash
localpress changelog --since "7 days ago" --json
```

---

## 12. Distribution & Ecosystem

### 12a. Scoop manifest (Windows)

A Scoop bucket for Windows users. Parallel to the Homebrew tap.

### 12b. McpAdapter — Third backend

An adapter that talks to a connected WP MCP server instead of REST directly. Enables richer operations when an MCP server is available without SSH.

### 12c. VS Code extension

Minimal extension: media library panel, drag-and-drop optimization, inline image preview. Shells out to the CLI.

### 12d. Raycast extension

Quick actions: optimize clipboard image and upload, search media library, run audit from Raycast.

### 12e. GitHub Action

`gfargo/localpress-action` — run audits, optimize, or caption as part of a CI/CD pipeline. Post results as PR comments.

```yaml
- uses: gfargo/localpress-action@v1
  with:
    command: audit --json
    site-url: ${{ secrets.WP_URL }}
    app-password: ${{ secrets.WP_APP_PASSWORD }}
```

### 12f. Skill marketplace distribution

Package the skill for Claude's skill marketplace, Cursor's extension registry, and similar agent platforms.

---

## 13. E-commerce (WooCommerce)

### 13a. `products list/show/update`

WooCommerce product management via REST API (`/wp-json/wc/v3/products`).

```bash
localpress products list --status publish --json
localpress products show 789 --json
```

### 13b. `products bulk-image`

Assign and optimize product gallery images in bulk. Wire the existing media engine to product metadata.

```bash
localpress products set-image 789 --attachment 123
localpress products optimize-gallery 789 --quality 80 --to webp
```

### 13c. `orders export`

Export orders as CSV/JSON for accounting and analytics.

```bash
localpress orders export --since "2026-01-01" --to ./orders.csv
```

### 13d. `inventory audit`

Find products with no images, missing descriptions, zero stock, broken variation images, missing SEO metadata.

```bash
localpress inventory audit --no-image --no-description --json
```

---

## Priority framework

When choosing what to build next, weight these factors:

1. **Leverages existing infrastructure** — REST adapter, WP-CLI, SQLite, MCP server, Ollama
2. **Serves the primary audience** — solo devs and small agencies managing WordPress sites
3. **Differentiates from competitors** — local-first, AI-powered, agent-composable
4. **Compounds with existing features** — e.g. content audit + media audit = full site health

### Suggested next milestones

| Milestone | Theme | Key features |
| --------- | ----- | ------------ |
| v1.17 | MCP polish | `search_by_url`, `bulk_metadata`, `health_check`, `cost_estimate` |
| v1.18 | Media++ | `--target-size`, `--watermark`, `resize --crop`, `audit --exif` |
| v2.0 | Content management | `posts` CRUD, `content audit`, `posts export/import` |
| v2.1 | SEO | `seo audit`, `seo bulk-meta`, `sitemap validate` |
| v2.2 | Multi-site | `sites run`, `sites compare`, `sites migrate` |
| v2.3 | Maintenance | `db export/import`, `cleanup`, `plugins list/audit` |
| v3.0 | Full platform | `sync`, `deploy`, `backup/restore`, `users`, WooCommerce |

---

## Design principles for expansion

- **CLI first, MCP second** — every feature ships as a CLI command, then gets a thin MCP tool wrapper for free
- **Local-first** — processing happens on the user's machine; the remote site is a sync target
- **Safe by default** — bulk operations dry-run; destructive ops snapshot for undo
- **Composable** — each command does one thing well; agents chain them into workflows
- **No new runtime deps without justification** — Bun + sharp + ONNX Runtime + Ollama is the stack; don't add Python/Ruby/Go dependencies
- **JSON contract is public API** — `--json` output shapes are stable; agents and scripts depend on them
