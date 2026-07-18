# Release Process

## Overview

Releases are automated via GitHub Actions. Pushing a `v*` tag triggers the `release.yml` workflow which builds binaries, creates a GitHub Release, and updates the Homebrew formula.

## Steps to Release

### 1. Bump version

```bash
# In package.json, update "version" field
# e.g. "1.6.0" → "1.7.0"
```

Follow semver:
- **Patch** (1.6.x): bug fixes, doc updates, test additions
- **Minor** (1.x.0): new commands, new flags, new capabilities, non-breaking changes
- **Major** (x.0.0): breaking changes to CLI flags, JSON output shapes, or config format

### 2. Update CHANGELOG.md

Move items from `[Unreleased]` into a new version section. Follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format:

```markdown
## [1.7.0] - 2026-05-08

### Added
- **Feature name**: description

### Changed
- **What changed**: description

### Fixed
- **Bug name**: description
```

Update the compare links at the bottom:
```markdown
[Unreleased]: https://github.com/gfargo/localpress/compare/v1.7.0...HEAD
[1.7.0]: https://github.com/gfargo/localpress/compare/v1.6.0...v1.7.0
```

### 3. Commit and tag

```bash
git add package.json CHANGELOG.md
git commit -m "chore: bump version to 1.7.0"
git tag v1.7.0
git push origin main
git push origin v1.7.0
```

### 4. Wait for the release workflow

The `release.yml` workflow will:
1. Run typecheck + unit tests
2. Build cross-platform binaries (`bun run build:all`)
3. Create a GitHub Release with auto-generated notes (`generate_release_notes: true`)
4. Compute SHA256 checksums for each binary
5. Update `Formula/localpress.rb` with new version and checksums
6. Push the updated formula to `gfargo/homebrew-localpress` tap

### 5. Polish the release notes (optional but recommended)

After the release is created, edit it with a hand-written description:

```bash
gh release edit v1.7.0 --notes-file tmp/release-notes.md
```

#### Release note format

Follow the tone of existing releases (see v1.6.0 as the template):

- **Opening paragraph** — 1-2 sentence theme summary
- **Sections with emoji headers** — `🖥️`, `🧠`, `🔐`, `📖` etc. for each major feature
- Each section: brief explanation + code example showing usage
- **"All Changes"** section — Added/Changed/Fixed bullets (mirrors CHANGELOG)
- **Stats** — files changed, insertions/deletions, new files
- **Install/Upgrade** — `brew upgrade localpress` + note about attached binaries
- Keep it scannable. Lead with what users care about, not implementation details.

## What the Workflow Handles Automatically

- Binary builds for: darwin-arm64, darwin-x64, linux-arm64, linux-x64, windows-x64
- GitHub Release creation with attached binaries
- SHA256 checksum computation
- Homebrew formula version + checksum update
- Push to `gfargo/homebrew-localpress` tap (requires `HOMEBREW_TAP_TOKEN` secret)

## Secrets Required

- `HOMEBREW_TAP_TOKEN`: GitHub PAT with `repo` scope on `gfargo/homebrew-localpress`

## Hotfix Process

For urgent fixes after a release:
1. Fix on main (or cherry-pick from a branch)
2. Bump patch version (e.g. 1.7.0 → 1.7.1)
3. Follow the same tag-and-push flow

## Wiki Updates

The `.wiki/` directory is a separate git repo (GitHub wiki). Push wiki changes directly:

```bash
git -C .wiki add .
git -C .wiki commit -m "docs: description"
git -C .wiki push
```

Wiki changes don't need a release — they're live immediately on push.
