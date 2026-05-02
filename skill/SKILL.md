---
name: localpress
description: Optimize, edit, and manage a WordPress media library using local CPU/GPU. Use when the user wants to compress images, remove backgrounds, convert formats, or audit a WordPress media library without paying a cloud SaaS. Composes with whatever WordPress MCP server the user already has connected — the agent uses its WP MCP for WordPress operations and shells out to the localpress CLI for the local-processing work.
---

# localpress

A CLI tool that processes WordPress media on the user's local machine and syncs results back to a remote WP install via the REST API.

> ⚠️ **Skill is a v1.0 deliverable.** This file is the structural outline; the full skill is fleshed out in v1.0 of the project. Do not distribute this file as-is — it's incomplete.

## When to invoke this skill

Trigger this skill when:

- The user asks to optimize, compress, or convert images on their WordPress site
- The user asks to remove backgrounds from product photos
- The user asks to audit their media library (find oversized, unused, or missing-alt-text images)
- The user asks to bulk-replace images on their WP site
- The user asks "where is this image used?" — references workflow

Do **not** invoke this skill for:

- Generic image editing on the user's local machine (use a different tool — localpress is WordPress-specific)
- Running queries against the user's WordPress database directly (use the WP MCP for that)

## Installation check

Before doing any work, verify localpress is installed and a site is configured:

```bash
localpress --version
localpress doctor --json
```

If `--version` fails, point the user to https://github.com/gfargo/localpress for install instructions. If `doctor` returns no configured sites, walk them through `localpress init`.

## Composing with the user's WP MCP server

If the user has a WordPress MCP server connected (`mcp-adapter`, `docdyhr/mcp-wordpress`, etc.), prefer using its tools to discover attachments, find post references, and verify changes. Use localpress only for the local-processing work.

A typical workflow:

1. Use the WP MCP to find recent attachments or a specific post's images
2. Use `localpress optimize <ids> --json` to compress them locally
3. Use the WP MCP to verify the changes landed and references are intact

If no WP MCP is connected, use `localpress list --json` and `localpress show <id> --json` directly.

## Common commands

> All commands accept `--json` for machine-readable output. Always pass `--json` when running from an agent — the human-readable output isn't designed for parsing.

### Optimize specific attachments

```bash
localpress optimize 123 124 125 --json
```

Output: a stream of JSON records, one per attachment, with before/after sizes, savings, and any references that need attention if a fallback was triggered.

### Bulk optimize unprocessed images

```bash
# Dry run (default for bulk ops):
localpress optimize --unoptimized --json

# Apply for real:
localpress optimize --unoptimized --apply --json
```

### Audit the library

```bash
localpress audit --json
```

Returns categorized findings: oversized images, unattached media, missing alt text, etc.

### Find references to an attachment

```bash
localpress references 1234 --json
```

Returns every place the attachment is referenced — useful before deletion or replacement workflows.

## Reading localpress output

> **TBD in v1.0:** the JSON schemas for each command's `--json` output. The agent should be able to consume these without ambiguity. This section will document each command's output shape with examples and field-by-field semantics.

## Error handling

localpress uses these stable exit codes:

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic error |
| 2 | Invalid usage |
| 3 | Config error (no active site, malformed config) |
| 4 | Network error (couldn't reach the WP site) |
| 5 | Auth error (App Password rejected) |
| 6 | Capability unavailable (e.g. replace-in-place needs WP-CLI but it's not configured) |
| 99 | Command not yet implemented |

In `--json` mode, error details go to stderr as structured records. On exit code 6, the error message includes which capability is missing and what the user can do (configure SSH, install Enable Media Replace, etc.).
