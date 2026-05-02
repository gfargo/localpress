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
- Audit their media library (find oversized, unused, or missing-alt-text images)
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
  "adapters": { "rest": true, "wpCli": false, "mcp": false },
  "capabilities": [
    { "capability": "list", "preferredAdapter": "rest", "availableOn": ["rest"] },
    { "capability": "replace-in-place", "preferredAdapter": null, "availableOn": [] }
  ]
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

# Show details for a specific attachment
localpress show 123 --json

# Audit the library for issues
localpress audit --json

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
    { "type": "missing-alt", "attachmentId": 789, "filename": "hero.jpg", "detail": "No alt text set" }
  ],
  "summary": { "unoptimized": 45, "large": 12, "missingAlt": 23 }
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

# Use lightweight model for faster processing
localpress remove-bg 123 --model u2netp --json
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

**Background removal models.** The `remove-bg` command downloads an AI model on first use. Available models: `u2net` (~176MB, best quality), `u2netp` (~4.7MB, fast), `silueta` (~44MB, balanced). Use `--list-models` to check what's cached.
