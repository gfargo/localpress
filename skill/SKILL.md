---
name: localpress
description: >
  Optimize, edit, and manage a WordPress media library using local CPU/GPU.
  Use when the user wants to compress images, remove backgrounds, convert
  formats, resize, audit, or round-trip edit images on a WordPress site
  without paying a cloud SaaS. Composes with whatever WordPress MCP server
  the user already has connected.
---

# localpress

A CLI tool that processes WordPress media on the user's local machine and syncs results back to a remote WP install via the REST API. No cloud processing, no recurring credits, no WP plugin required.

## When to invoke this skill

Trigger this skill when the user asks to:

- Optimize, compress, or convert images on their WordPress site
- Remove backgrounds from product photos or portraits
- Resize images in their media library
- Generate alt text for images using a local vision model
- Audit their media library (find oversized, unused, or missing-alt-text images)
- View processing stats and bytes saved across the media library
- Find where a specific image is used across posts and pages
- Open a WP image in a desktop editor, edit it, and sync back
- Bulk-process images across their WordPress media library
- Generate/write title, description, tags, or a classification for images via AI
- Delete media attachments, or create/update/delete posts and pages
- Run an accessibility (WCAG) pass over post/page content
- Undo a previous localpress operation (time machine)
- Watch a local directory and auto-sync new/changed images to WordPress
- Run the same localpress command across multiple configured sites

Do **not** invoke this skill for:

- Generic local image editing unrelated to WordPress
- Direct WordPress database queries (use the WP MCP for that)
- WordPress settings, plugins, themes, users, or comments (use the WP MCP) — `localpress posts` only covers posts/pages content

## Installation check

Before doing any work, verify localpress is installed and a site is configured:

```bash
localpress --version
localpress doctor --json
```

If `--version` fails, the user needs to install localpress. Point them to:
[https://github.com/gfargo/localpress](https://github.com/gfargo/localpress)

If `doctor` returns no configured sites, walk them through setup:

```bash
localpress init --url https://their-site.com --username admin --app-password "xxxx xxxx xxxx xxxx xxxx xxxx"
```

## Composing with the user's WP MCP server

If the user has a WordPress MCP server connected (`mcp-adapter`, `docdyhr/mcp-wordpress`, etc.), prefer using its tools to discover attachments, find post references, and verify changes. Use localpress only for the local-processing work.

**Typical agent workflow:**

1. Use the WP MCP to find recent attachments or a specific post's images
2. Use `localpress optimize <ids> --json` to compress them locally
3. Use the WP MCP to verify the changes landed and references are intact

If no WP MCP is connected, use `localpress list --json` and `localpress show <id> --json` directly.

## Commands reference

All commands accept `--json` for machine-readable output. **Always pass `--json` when running from an agent** — the human-readable output is not designed for parsing.

### Setup

```bash
# Connect a WordPress site (interactive)
localpress init

# Connect non-interactively
localpress init --url https://site.com --username admin --app-password "xxxx xxxx xxxx"

# List configured sites
localpress sites --json

# Switch active site
localpress sites use production

# Run a command across multiple sites
localpress sites run "list --unoptimized" --all-sites --json
localpress sites run "optimize --unoptimized --apply" --sites production,staging --json

# Show backend capabilities
localpress doctor --json
```

#### `sites run --json` output

```json
{
  "command": "list --unoptimized",
  "total": 2,
  "succeeded": 2,
  "failed": 0,
  "results": [
    { "site": "production", "exitCode": 0, "ok": true, "stdout": { "items": [], "total": 0, "totalPages": 1, "page": 1 }, "stderr": "" },
    { "site": "staging", "exitCode": 0, "ok": true, "stdout": { "items": [], "total": 0, "totalPages": 1, "page": 1 }, "stderr": "" }
  ]
}
```

`stdout` is the parsed JSON of the inner command when it emitted valid JSON, otherwise the raw string. Exit code is 0 only if every site succeeded.

#### `doctor --json` output

```json
{
  "site": "production",
  "url": "https://example.com",
  "connectionOk": true,
  "sharpAvailable": true,
  "adapters": { "rest": true, "wpCli": false, "mcp": false },
  "capabilities": [
    { "capability": "list", "preferredAdapter": "rest", "availableOn": ["rest"] },
    { "capability": "replace-in-place", "preferredAdapter": null, "availableOn": [] }
  ],
  "issues": [],
  "plugins": [
    { "slug": "enable-media-replace", "name": "Enable Media Replace", "active": true, "capability": "replace-in-place (REST fallback)", "version": "4.1.0" }
  ]
}
```

### Configuration

```bash
# Set global defaults
localpress config set defaults.quality 80 --json
localpress config set defaults.format webp --json

# Create a named optimization profile
localpress config set-profile hero --quality 75 --format webp --max-width 1920 --json

# List all profiles
localpress config list-profiles --json

# Get a specific profile
localpress config get-profile hero --json

# Print full config (passwords redacted)
localpress config list --json
```

#### `config list-profiles --json` output

```json
{
  "profiles": {
    "hero": { "quality": 75, "format": "webp", "maxWidth": 1920, "description": "Hero images" },
    "thumbnail": { "quality": 85, "maxWidth": 400, "stripMetadata": true }
  }
}
```

### Discovery

```bash
# List all media
localpress list --json

# List unoptimized images only
localpress list --unoptimized --json

# List large images (>1MB)
localpress list --larger-than 1048576 --json

# Sort by file size, largest first
localpress list --sort size --json

# Sort by name, alphabetically
localpress list --sort name --order asc --json

# Paginate
localpress list --page 2 --limit 25 --json

# Show details for a specific attachment
localpress show 123 --json

# Processing stats (no network call)
localpress stats --json

# Stats across all configured sites
localpress stats --all-sites --json

# Audit the library for issues
localpress audit --json

# Audit specific checks only
localpress audit --display-size --json
localpress audit --duplicates --json
localpress audit --broken-refs --json

# Vision-based checks (require Ollama; slow, ~10s/image; opt-in only, not
# part of the default "run everything" audit)
localpress audit --quality --json
localpress audit --ocr-text "Sale" --json

# Find where an attachment is used
localpress references 123 --json
```

#### `list --json` output

The top-level shape is an object with pagination metadata, **not** a bare array (`src/cli/commands/list.ts:437`):

```json
{
  "items": [
    {
      "id": 123,
      "title": "product-shot",
      "filename": "product-shot.jpg",
      "url": "https://example.com/wp-content/uploads/2026/01/product-shot.jpg",
      "mimeType": "image/jpeg",
      "width": 1920,
      "height": 1080,
      "sizeBytes": 524288,
      "altText": "Product photo",
      "uploadedAt": "2026-01-15T10:30:00"
    }
  ],
  "total": 150,
  "totalPages": 3,
  "page": 1
}
```

#### `audit --json` output

```json
{
  "site": "production",
  "totalItems": 150,
  "findings": [
    { "type": "unoptimized", "attachmentId": 123, "filename": "photo.jpg", "detail": "Not yet processed" },
    { "type": "large", "attachmentId": 456, "filename": "banner.png", "detail": "2.4 MB (threshold: 1.0 MB)" },
    { "type": "missing-alt", "attachmentId": 789, "filename": "hero.jpg", "detail": "No alt text set" },
    { "type": "display-size", "attachmentId": 101, "filename": "bg.jpg", "detail": "Source is 4000×3000 but largest registered size is 1024×768 (large) — 15.3× oversized" },
    { "type": "duplicate", "attachmentId": 202, "filename": "logo.png", "detail": "Perceptually similar to attachment(s) #203, #204", "duplicateOf": [203, 204] },
    { "type": "broken-ref", "attachmentId": 303, "filename": "old-banner.jpg", "detail": "URL returns HTTP 404" },
    { "type": "quality", "attachmentId": 404, "filename": "blurry.jpg", "detail": "motion blur on subject" },
    { "type": "ocr-match", "attachmentId": 505, "filename": "banner.jpg", "detail": "title bar reads \"Sale\"" }
  ],
  "summary": { "unoptimized": 45, "large": 12, "missingAlt": 23, "displaySize": 8, "duplicates": 3, "brokenRefs": 2, "orphan": 0, "missingFile": 0, "quality": 1, "ocrMatch": 1 }
}
```

`--quality` and `--ocr-text <term>` are opt-in only (each is a per-image Ollama vision call, ~10s/image) — they are never included in the default "run everything" audit.

#### `stats --json` output

```json
{
  "site": "production",
  "filesProcessed": 142,
  "operationsSucceeded": 139,
  "operationsFailed": 3,
  "bytesBefore": 524288000,
  "bytesAfter": 131072000,
  "bytesSaved": 393216000,
  "percentReduction": 75.0,
  "lastRunAt": "2026-05-03T14:22:00.000Z",
  "breakdown": [
    { "operation": "optimize", "count": 120, "bytesSaved": 350000000, "avgDurationMs": 450 },
    { "operation": "convert", "count": 12, "bytesSaved": 40000000, "avgDurationMs": 310 },
    { "operation": "resize", "count": 7, "bytesSaved": 3216000, "avgDurationMs": 200 }
  ]
}
```

#### `references --json` output

```json
{
  "attachmentId": 123,
  "scope": "fast",
  "references": [
    { "type": "featured-image", "postId": 45, "postTitle": "Summer Sale", "postType": "post" },
    { "type": "gutenberg-block", "postId": 67, "postTitle": "Product Catalog", "postType": "page", "occurrences": 3 }
  ]
}
```

### Processing

```bash
# Optimize specific attachments
localpress optimize 123 124 125 --json

# Bulk optimize (dry-run by default)
localpress optimize --unoptimized --json
# Execute for real:
localpress optimize --unoptimized --apply --json

# Use a named optimization profile
localpress optimize --unoptimized --profile hero --apply --json

# Use jSquash WASM codecs for better PNG compression (OxiPNG)
localpress optimize 123 --encoder jsquash --json

# Convert to WebP
localpress convert 123 124 --to webp --json

# Convert to AVIF with custom quality
localpress convert 123 --to avif --quality 50 --json

# Resize to max 1200px wide
localpress resize 123 124 --max-width 1200 --json

# Remove background (downloads AI model on first use)
localpress remove-bg 123 --json

# Remove background with white fill instead of transparency
localpress remove-bg 123 --bg "#ffffff" --json

# Use best model (BiRefNet, state-of-the-art, ~224MB, MIT)
localpress remove-bg 123 --model birefnet-lite --json

# Use ISNet for better edge quality than U2-Net (~176MB)
localpress remove-bg 123 --model isnet-general-use --json

# Use lightweight model for faster processing
localpress remove-bg 123 --model u2netp --json

# Use system Python rembg instead of built-in ONNX (if installed)
localpress remove-bg 123 --rembg --json

# Use a specific rembg model (e.g. isnet-general-use)
localpress remove-bg 123 --rembg --rembg-model isnet-general-use --json
```

#### `optimize --json` output

```json
{
  "processed": 3,
  "failures": 0,
  "totalSavedBytes": 1048576,
  "results": [
    {
      "id": 123,
      "filename": "photo.jpg",
      "bytesBefore": 524288,
      "bytesAfter": 131072,
      "savedBytes": 393216,
      "savedRatio": 0.75,
      "resultWpId": 123,
      "durationMs": 450,
      "appliedSteps": ["auto-rotate", "strip-metadata", "jpeg(q=80, mozjpeg)"]
    }
  ]
}
```

#### Dry-run output (bulk operations)

```json
{
  "dryRun": true,
  "count": 45,
  "items": [
    { "id": 123, "filename": "photo.jpg", "sizeBytes": 524288 }
  ]
}
```

```bash
# Generate alt text for specific attachments (requires Ollama running locally)
localpress caption 123 124 --json

# Bulk-caption all images with no alt text (dry-run by default)
localpress caption --missing-alt --json

# Caption all images in the library (dry-run by default)
localpress caption --all --json

# Execute the bulk caption run
localpress caption --missing-alt --apply --json

# Generate alt text in a specific language
localpress caption 123 --language Spanish --json
localpress caption --missing-alt --language French --apply --json

# Use a specific model
localpress caption 123 --model llava --json

# Overwrite existing alt text
localpress caption 123 --overwrite --json

# List available vision models installed in Ollama
localpress caption --list-models --json
```

#### `caption --json` output

```json
{
  "processed": 3,
  "failures": 0,
  "results": [
    {
      "id": 123,
      "filename": "product-shot.jpg",
      "altText": "A red ceramic mug on a white background with steam rising from the top",
      "model": "moondream",
      "durationMs": 1200,
      "skipped": false
    }
  ]
}
```

> **Requires Ollama** — install at [https://ollama.com](https://ollama.com) then `ollama pull moondream`. The `caption` command talks to `http://localhost:11434` by default.

### AI metadata generation (title, describe, classify, tag, vision, metadata, rename)

`caption` (alt text) has five companions that follow the same pattern — Ollama vision model, dry-run-by-default bulk mode, idempotent-skip, `--overwrite`, time-machine snapshot before every write — plus two direct-write commands (`metadata`, `rename`) that don't call a vision model at all (except `rename --smart`).

```bash
# title: 3-7 word noun phrase written to the WP post title
localpress title 123 124 --json
localpress title --missing-title --apply --json   # only auto-generated-looking titles (Screenshot-…, IMG_…)
localpress title --all --apply --json

# describe: 2-3 sentence description written to the WP description field
localpress describe 123 --json
localpress describe --missing-description --apply --json

# classify: detect image type (screenshot | photo | illustration | diagram) — read-only, no WP write
localpress classify 123 124 --json

# tag: 3-6 short labels written to the caption field as a `[tags: …]` block
localpress tag 123 --json
localpress tag --missing-tags --apply --json
localpress tag 123 --overwrite --json

# vision: generate all AI fields (alt, title, description, tags, classify) in one pass
# Print-only by default — pass --apply to write to WordPress.
localpress vision 123 --json
localpress vision 123 124 --fields alt,tags --apply --json

# metadata: directly set fields (no AI) — at least one flag required
localpress metadata 123 --alt-text "Screenshot of the dashboard" --title "Dashboard overview" --json

# rename: rename the WP slug/permalink (NOT the underlying filename)
localpress rename 123 --smart --json           # AI-generated name, slugified
localpress rename 123 --to "summer-sale-hero" --json
```

#### `title` / `describe` `--json` output

```json
{
  "dryRun": false,
  "processed": 1,
  "skipped": 0,
  "failures": 0,
  "results": [
    { "id": 123, "filename": "IMG_4821.jpg", "title": "Terminal command output", "skipped": false }
  ]
}
```

#### `classify --json` output

```json
{ "classified": 2, "failures": 0, "results": [{ "id": 123, "filename": "photo.jpg", "classification": "photo", "durationMs": 900 }] }
```

`classification` is one of `screenshot`, `photo`, `illustration`, `diagram`, `unknown`. The result is cached locally so `optimize` can pick smarter format defaults (screenshots → PNG, photos → WebP).

#### `tag --json` output

```json
{
  "dryRun": false,
  "processed": 1,
  "skipped": 0,
  "failures": 0,
  "results": [{ "id": 123, "filename": "hero.jpg", "tags": ["mug", "ceramic", "red", "steam"], "skipped": false, "durationMs": 1100 }]
}
```

#### `vision --json` output

```json
{
  "applied": true,
  "fields": ["alt", "title", "description", "tags", "classify"],
  "processed": 1,
  "failures": 0,
  "results": [
    {
      "id": 123,
      "filename": "hero.jpg",
      "alt": "A red ceramic mug on a white background",
      "title": "Ceramic mug product shot",
      "description": "A close-up product photo of a red ceramic mug against a plain white background.",
      "tags": ["mug", "ceramic", "red"],
      "classify": "photo",
      "durationMs": 4200,
      "applied": true
    }
  ]
}
```

#### `metadata --json` output

```json
{
  "updated": 1,
  "skipped": 0,
  "failures": 0,
  "results": [
    {
      "id": 123,
      "filename": "hero.jpg",
      "updated": true,
      "skipped": false,
      "changes": { "altText": "Screenshot of the dashboard", "title": "Dashboard overview" },
      "previous": { "altText": "", "title": "hero" }
    }
  ]
}
```

#### `rename --json` output

```json
{
  "dryRun": false,
  "renamed": 1,
  "skipped": 0,
  "failures": 0,
  "results": [{ "id": 123, "filename": "IMG_4821.jpg", "from": "img-4821", "to": "summer-sale-hero", "source": "explicit", "skipped": false }]
}
```

`rename` updates the WordPress slug (`post_name` / permalink) only — it does not rename the underlying file on disk.

### Content management (posts, delete, a11y)

```bash
# List posts/pages (works on custom post types too, e.g. --type portfolio)
localpress posts list --json
localpress posts list --type page --status draft --json

# Show full details for a post/page
localpress posts show 45 --json

# Create a post (draft by default)
localpress posts create --title "Summer Sale" --content "<p>...</p>" --status publish --json

# Update a post (dry-run supported via global --dry-run)
localpress posts update 45 --title "Summer Sale 2026" --featured-image 123 --json

# Trash or permanently delete a post/page
localpress posts delete 45 --json
localpress posts delete 45 --force --json

# Delete attachment(s) — moves to trash unless --force; captures an undo snapshot first
localpress delete 123 124 --json
localpress delete 123 --force --json

# Accessibility audit of published posts/pages content (heading hierarchy, generic
# link text, missing inline-image alt, empty links)
localpress a11y --json
localpress a11y --type page --status publish --json
localpress a11y --id 45 --json
```

#### `posts list --json` output

```json
{
  "items": [
    { "id": 45, "title": "Summer Sale", "status": "publish", "type": "post", "date": "2026-06-01T10:00:00", "modified": "2026-06-02T09:00:00", "slug": "summer-sale", "link": "https://example.com/summer-sale/", "author": 1, "featuredMedia": 123 }
  ],
  "total": 12,
  "totalPages": 1,
  "page": 1
}
```

#### `posts show --json` output

Same item shape as `posts list`, plus `content` (string), `categories` (number[]), `tags` (number[]).

#### `posts create` / `posts update --json` output

```json
{ "action": "created", "post": { "id": 46, "title": "New Post", "status": "draft", "type": "post", "date": "…", "modified": "…", "slug": "new-post", "link": "…", "author": 1, "featuredMedia": 0 } }
```

`posts update` uses `"action": "updated"`. Passing global `--dry-run` returns `{ "dryRun": true, "action": "update", "id": 45, "fields": { ... } }` instead and makes no request.

#### `posts delete --json` output

```json
{ "action": "trashed", "id": 45 }
```

`action` is `"deleted"` when `--force` is passed. Global `--dry-run` returns `{ "dryRun": true, "action": "trash"|"delete", "id": 45 }` instead.

#### `delete --json` output

```json
{
  "deleted": 1,
  "failures": 0,
  "force": false,
  "results": [{ "id": 123, "filename": "old-banner.jpg", "status": "deleted", "force": false }]
}
```

Global `--dry-run` returns `{ "dryRun": true, "force": false, "ids": [123, 124] }` and deletes nothing.

#### `a11y --json` output

```json
{
  "site": "production",
  "postsChecked": 40,
  "findings": [
    { "type": "generic-link-text", "postId": 45, "postTitle": "Summer Sale", "detail": "Link text \"click here\" is not descriptive of its destination", "element": "<a href=\"/shop\">click here</a>" },
    { "type": "missing-img-alt", "postId": 67, "postTitle": "Gallery", "detail": "Image in content has no alt attribute", "element": "<img src=\"...\">" }
  ],
  "summary": { "headingSkip": 0, "multipleH1": 1, "genericLinkText": 3, "missingImgAlt": 2, "emptyLink": 0 }
}
```

### Round-trip editing

```bash
# Open in default editor, watch for saves, sync back
localpress edit 123

# Open in a specific app
localpress edit 123 --with "GIMP"
localpress edit 123 --with "Photoshop"

# Open without watching (manual upload later)
localpress edit 123 --no-watch
```

The `edit` command downloads the attachment, opens it in the editor, and watches for file saves. Each save is automatically uploaded back to WordPress. The user presses Enter to stop watching.

### Migration (export / import)

```bash
# Export all media as a ZIP with metadata manifest
localpress export --all --to ./backup.zip --json

# Export unoptimized images to a directory
localpress export --unoptimized --to ./to-process/ --json

# Export specific attachments
localpress export 123 456 --to ./selected.zip --json

# Export with filters
localpress export --all --type image/jpeg --since 2026-01-01 --json

# Import a directory with optimization
localpress import ./product-photos/ --optimize --to webp --json

# Import a previous export, preserving metadata
localpress import ./backup.zip --preserve-ids --json

# Import with resize constraints
localpress import ./raw-photos/ --optimize --max-width 1920 --json

# Dry run
localpress import ./photos/ --dry-run --json
```

#### `export --json` output

```json
{
  "action": "exported",
  "destination": "./backup.zip",
  "format": "zip",
  "exported": 42,
  "failures": 0,
  "totalBytes": 12582912,
  "items": [
    { "id": 123, "filename": "hero.jpg", "relativePath": "2026/01/hero.jpg", "sizeBytes": 245760 }
  ]
}
```

#### `import --json` output

```json
{
  "action": "imported",
  "site": "production",
  "imported": 42,
  "failures": 1,
  "totalUploadedBytes": 12582912,
  "totalOriginalBytes": 25165824,
  "items": [
    { "file": "hero.jpg", "attachmentId": 847, "filename": "hero.jpg", "sizeBytes": 142301, "optimized": true, "originalSize": 524288 }
  ]
}
```

### Maintenance (regenerate, watch, watch-status, update, completions)

```bash
# Regenerate WordPress thumbnails (requires WP-CLI over SSH)
localpress regenerate 123 124 --json
localpress regenerate --all --apply --json

# Watch a local directory and auto-push new/changed images to WordPress
# (long-running; NDJSON events on stdout, one JSON object per line, until Ctrl+C)
localpress watch ./product-photos --optimize --to webp --json

# Check what's been watched historically for the active site (no live-process detection yet)
localpress watch-status --json

# Check for / install a newer localpress release
localpress update --check --json
localpress update --yes --json

# Generate shell completion scripts (not JSON — writes the script itself to stdout)
localpress completions bash >> ~/.bashrc
```

#### `regenerate --json` output

```json
{ "succeeded": 2, "failed": 0, "total": 2, "results": [{ "id": 123, "status": "success" }, { "id": 124, "status": "success" }] }
```

Bulk `--all` without `--apply` returns `{ "dryRun": true, "count": N, "ids": [...] }` instead and regenerates nothing.

#### `watch` output — a stream of NDJSON events, not one terminal JSON blob

Each event is printed as its own line as it happens:

```json
{"event":"uploaded","file":"hero.jpg","attachmentId":847,"sizeBytes":142301}
{"event":"replaced","file":"hero.jpg","attachmentId":847,"sizeBytes":98213}
{"event":"uploaded-as-new","file":"hero.jpg","attachmentId":850,"previousId":847,"sizeBytes":98213}
{"event":"file-removed","file":"hero.jpg","attachmentId":847,"note":"WordPress attachment not deleted (pass --delete to enable)"}
{"event":"deleted","file":"hero.jpg","attachmentId":847}
{"event":"error","file":"hero.jpg","error":"Failed to download: 404"}
```

An agent driving `watch` should read stdout line-by-line and treat the process as long-running (it only exits on Ctrl+C / SIGTERM).

#### `watch-status --json` output

```json
{
  "site": "production",
  "running": false,
  "runningDetectionImplemented": false,
  "directories": [{ "watchDir": "/Users/me/product-photos", "fileCount": 42, "lastActivityAt": 1748870400000 }]
}
```

`running` is always `false` today — live-process detection isn't implemented yet (`runningDetectionImplemented: false` flags this explicitly). The report reflects historical file→attachment mappings only.

#### `update --json` output

```json
{
  "currentVersion": "1.15.2",
  "latestVersion": "1.16.0",
  "updateAvailable": true,
  "downloadUrl": "https://github.com/gfargo/localpress/releases/download/v1.16.0/localpress-darwin-arm64.tar.gz",
  "releaseUrl": "https://github.com/gfargo/localpress/releases/tag/v1.16.0",
  "assetName": "localpress-darwin-arm64.tar.gz",
  "assetSize": 41943040
}
```

`--check` exits `1` if an update is available (after printing the JSON), `0` otherwise. On a Homebrew install, the response additionally includes `"method": "homebrew", "command": "brew upgrade localpress"` and no download is attempted.

### Low-level

```bash
# Download attachments to current directory
localpress pull 123 124 --json

# Download to a specific directory
localpress pull 123 --to ./downloads --json

# Upload a local file as a new attachment
localpress push ./optimized.webp --json

# Upload as a replacement for an existing attachment
localpress push ./optimized.webp --replace 123 --json
```

### Time machine (history, undo)

Every mutating command (optimize, convert, resize, remove-bg, caption, title, describe, tag, vision, metadata, rename, delete) captures a snapshot before it writes, so changes can be reverted with `undo`. Purely local — no network calls to read history.

```bash
# List recent sessions
localpress history --json

# Filter to snapshots for one attachment / operation / session
localpress history --attachment 123 --json
localpress history --operation optimize --json
localpress history --session a1b2c3d4 --json

# Show a single session or snapshot in detail
localpress history show a1b2c3d4 --json
localpress history show 42 --json

# Apply the retention policy (drop oldest snapshots past a size/age/count limit)
localpress history prune --older-than 30 --json
localpress history clear --yes --json

# Undo: restores the last session by default; dry-run unless --apply
localpress undo --json
localpress undo --apply --json
localpress undo a1b2c3d4 --apply --json      # a specific session (8-char prefix)
localpress undo --snapshot 42 --json          # one snapshot — executes immediately
localpress undo --attachment 123 --json       # most recent un-restored snapshot for #123 — executes immediately
```

#### `history --json` output (default: list sessions)

```json
{
  "site": "production",
  "sessions": [{ "id": "a1b2c3d4e5f6...", "command": "optimize", "startedAt": 1748870400000, "itemCount": 3, "paramsJson": "{\"quality\":80}" }],
  "stats": { "sessionCount": 12, "snapshotCount": 45, "totalBytes": 52428800, "maxSizeBytes": 2147483648 }
}
```

#### `history --attachment <id>` / `--operation <op>` / `--session <id> --json` output (snapshot list)

```json
{
  "site": "production",
  "snapshots": [
    { "id": 42, "sessionId": "a1b2c3d4e5f6...", "wpId": 123, "operation": "optimize", "kind": "binary", "blobSize": 524288, "createdAt": 1748870400000, "restoredAt": null }
  ]
}
```

#### `undo --json` output

Dry-run (default for session-targeted undo):

```json
{ "dryRun": true, "count": 3, "snapshots": [{ "id": 42, "attachmentId": 123, "operation": "optimize", "kind": "binary", "filename": "hero.jpg" }] }
```

Executed (`--apply`, or always for `--snapshot`/`--attachment` targeting):

```json
{ "restored": 3, "failures": 0, "results": [{ "snapshotId": 42, "attachmentId": 123, "operation": "optimize", "kind": "binary", "status": "restored" }] }
```

If replace-in-place is unavailable when restoring a binary snapshot, `undo` falls back to uploading the original bytes as a new attachment (same fallback behavior as `optimize`/`edit`) and warns that the attachment ID changed.

### MCP server

```bash
# Run localpress as an MCP (Model Context Protocol) server over stdio.
# Intended to be spawned by an MCP host (Claude Desktop, Cursor, Claude Code) —
# not for direct human/agent invocation from a shell. There is no --json mode:
# it speaks JSON-RPC over stdin/stdout for as long as the host keeps it running.
localpress mcp
```

The MCP server exposes the same functionality as the CLI (20 tools + 3 resources as of v1.14, one MCP tool per CLI command family) by shelling out to the CLI's own `--json` output internally. If the user already has localpress configured as an MCP server in their host, prefer calling its tools directly over shelling out to the `localpress` binary yourself — see .wiki/MCP-Setup.md in the repo for host configuration.

## Global flags

| Flag | Effect |
| --- | --- |
| `--site <name>` | Override the active site for this command |
| `--json` | Machine-readable NDJSON output (always use from agents) |
| `--quiet` | Errors only; suppress info messages |
| `--dry-run` | Show what would happen without executing |
| `--apply` | Execute bulk operations (overrides default dry-run) |
| `--strict` | Fail loudly when capability fallbacks would activate |
| `--concurrency <n>` | Parallel workers for bulk ops |
| `--yes` | Skip confirmation prompts |

## Error handling

localpress defines stable exit codes (`src/types.ts`):

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic error (per-item failures in bulk ops) |
| 2 | Invalid usage (bad arguments) |
| 3 | Config error (no active site, malformed config) |
| 4 | Network error (couldn't reach the WP site) |
| 5 | Auth error (Application Password rejected) |
| 6 | Capability unavailable (e.g. replace-in-place needs WP-CLI) |

Most per-command failure paths honor this table and call `error()` (below) before exiting with the matching code.

**Two exceptions exist today (tracked in [#128](https://github.com/gfargo/localpress/issues/128), open as of this writing) where the contract is NOT honored, even with `--json`:**

1. An uncaught/unexpected error that bubbles past a command's own handling hits the top-level catch in `src/cli/index.ts` — it always prints plain text (`error: <message>`) to stderr and exits `1`, regardless of `--json`.
2. Commander's own parse errors (unknown command, missing required argument) use commander's built-in behavior — plain text to stderr, exit `1` — not the documented `InvalidUsage` (2).

An agent parsing exit codes should treat `1` as "generic failure, message is plain text OR JSON" rather than assuming JSON is always available, until #128 lands.

In `--json` mode, errors and warnings emitted via the per-command `error()`/`warn()` helpers (`src/cli/utils/output.ts`) go to **stderr** as structured JSON — stdout carries only the data payload:

```json
{"level":"error","message":"WordPress REST API error: 401 Unauthorized"}
```

On exit code 6, the message explains which capability is missing and what the user can do about it.

## Key behaviors to know

**Safe by default for bulk ops.** `optimize --all` and `optimize --unoptimized` run as dry-runs by default. The agent must pass `--apply` to execute. Explicit IDs (`optimize 123 124`) execute immediately.

**Idempotent processing.** Re-running `optimize` on an already-processed attachment is a no-op if the source hasn't changed (hash comparison). Safe to run repeatedly.

**Replace-in-place fallback.** When replacing an attachment, localpress tries WP-CLI first (if SSH is configured), then falls back to uploading as a new attachment. The `--strict` flag makes it fail instead of falling back. The fallback output includes a references report showing where the old attachment is used.

**Background removal models.** The `remove-bg` command downloads an AI model on first use. Available models: `birefnet-lite` (~224MB, MIT, state-of-the-art), `isnet-general-use` (~176MB, great edge quality), `u2net` (~176MB, general purpose, default), `silueta` (~44MB, balanced), `u2netp` (~4.7MB, fast). Use `--list-models` to check what's cached. Pass `--preview` to open a browser UI for adjusting model, alpha threshold, and background color before applying. Alternatively, use `--rembg` to shell out to system Python rembg if installed.

**Encoder backends.** The `optimize` command uses sharp by default. Pass `--encoder jsquash` to use Squoosh-derived WASM codecs instead — particularly useful for PNG files where OxiPNG produces significantly smaller output than sharp's built-in PNG encoder.

**Named profiles.** Use `localpress config set-profile <name> --quality 75 --format webp --max-width 1920` to create reusable optimization presets. Then pass `--profile <name>` to `optimize` to apply them. Profile values are defaults — explicit CLI flags override them.

**Browser preview.** Both `optimize` and `remove-bg` support `--preview` to open a local browser UI for adjusting settings visually before committing. The preview server runs on localhost, auto-opens the browser, and shuts down when the tab closes or the user applies/cancels. Note: `--preview` requires exactly one attachment ID (not bulk mode). If profiles are configured, a dropdown in the preview sidebar lets the user pre-fill settings from a profile.
