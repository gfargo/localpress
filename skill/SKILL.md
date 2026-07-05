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

Do **not** invoke this skill for:

- Generic local image editing unrelated to WordPress
- Direct WordPress database queries (use the WP MCP for that)
- Managing WordPress posts, pages, or settings (use the WP MCP)

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

# Show backend capabilities
localpress doctor --json
```

#### `doctor --json` output

```json
{
  "site": "production",
  "url": "https://example.com",
  "connectionOk": true,
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

# Find where an attachment is used
localpress references 123 --json
```

#### `list --json` output

```json
[
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
]
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
    { "type": "broken-ref", "attachmentId": 303, "filename": "old-banner.jpg", "detail": "URL returns HTTP 404" }
  ],
  "summary": { "unoptimized": 45, "large": 12, "missingAlt": 23, "displaySize": 8, "duplicates": 3, "brokenRefs": 2, "orphan": 0, "missingFile": 0 }
}
```

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
localpress import ./backup.zip --preserve-metadata --json

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
    { "file": "hero.jpg", "attachmentId": 847, "filename": "hero.jpg", "sizeBytes": 142301, "optimized": true, "originalSize": 524288, "oldId": 123 }
  ],
  "idMappings": [
    { "oldId": 123, "newId": 847 }
  ]
}
```

When `idMappings` is non-empty (only populated with `--preserve-metadata` against a manifest), run `localpress references <oldId> --update-to <newId>` for each mapping to rewrite references from the old site to the new attachment IDs.

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

localpress uses stable exit codes:

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Generic error (per-item failures in bulk ops) |
| 2 | Invalid usage (bad arguments) |
| 3 | Config error (no active site, malformed config) |
| 4 | Network error (couldn't reach the WP site) |
| 5 | Auth error (Application Password rejected) |
| 6 | Capability unavailable (e.g. replace-in-place needs WP-CLI) |

In `--json` mode, errors go to stderr as structured JSON:

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
