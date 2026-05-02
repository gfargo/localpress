# Changelog

All notable changes to localpress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-05-02

### Added
- **AI background removal** (`remove-bg` command): local inference using
  ONNX Runtime + U2-Net models. No cloud API, no AGPL dependencies.
  - Three model options: `u2net` (~176MB, best quality), `u2netp` (~4.7MB,
    lightweight), `silueta` (~44MB, balanced).
  - Models auto-download from HuggingFace on first use and cache locally.
  - All models Apache-2.0 licensed.
  - `--bg <color>` for solid background instead of transparency.
  - `--trim` to remove transparent borders.
  - `--list-models` to show available models and cache status.
  - `--keep-original` to upload as new attachment.
  - Standard replace-in-place fallback chain.
- **ONNX type declarations** for type-safe inference without requiring
  onnxruntime-node at typecheck time.
- **Model manager** with download progress reporting and local caching
  at `$XDG_CONFIG_HOME/localpress/models/`.

### Dependencies
- Added `onnxruntime-node` ^1.22.0 (MIT license).

## [0.2.0] - 2026-05-02

### Added
- **WP-CLI adapter**: full `WpBackend` implementation over SSH, enabling
  true in-place file replacement, thumbnail regeneration, orphan pruning,
  and full content scanning.
- **SSH execution helper**: shells out to system `ssh`/`scp` binaries,
  works with existing SSH agent and key management.
- **`convert` command**: convert attachments between formats (webp, avif,
  jpeg, png) with quality control and replace-in-place fallback.
- **`resize` command**: resize attachments with `--max-width`/`--max-height`,
  preserving aspect ratio. Regenerates WP thumbnails via WP-CLI when available.
- **Full audit checks**:
  - `--orphans`: filesystem scan via WP-CLI to find files with no DB record.
  - `--missing-alt`: now works reliably for all items.
  - Structured grouped output for all finding types.
- **Full reference scanning** (`--scope full`): content URL matching and
  post meta scanning via WP-CLI, in addition to the existing fast scan.
- **Reference rewriting** (`--update-to`): rewrites `_thumbnail_id` meta,
  content URLs via `wp search-replace`, and Gutenberg block IDs. Supports
  `--dry-run` for safe preview.

### Changed
- CLI now registers 12 commands (added `convert` and `resize`).
- Audit command restructured with proper finding type taxonomy.
- References command no longer gates `--update-to` behind a "not yet available" error.

## [0.1.0] - 2026-05-02

### Added
- **SQLite state layer**: per-site database with attachment tracking, processing
  history, and migration support via `bun:sqlite`.
- **Config loading/persistence**: XDG-compliant config at
  `~/.config/localpress/config.json` with 0600 permissions on POSIX.
- **REST adapter**: full WordPress REST API integration with Application Password
  auth, media CRUD, and fast reference scanning (featured images + Gutenberg blocks).
- **Image optimization engine**: framework-agnostic module using sharp with
  mozjpeg, png, webp, and avif encoding. Lazy-loaded for fast CLI boot.
- **All 10 v0.1 CLI commands**:
  - `init` — interactive setup wizard with readline prompts and masked password input.
  - `sites` — list, add, use, remove configured WordPress sites.
  - `doctor` — backend availability and capability matrix.
  - `list` — filterable media listing with `--unoptimized` SQLite cross-reference.
  - `show` — single attachment detail with processing history.
  - `audit` — find unoptimized, large, and missing-alt-text images.
  - `optimize` — compress and convert media with idempotency (hash-based),
    dry-run safety for bulk ops, and replace-in-place fallback chain.
  - `pull` — download attachments to local directory.
  - `push` — upload local files with replace-in-place fallback.
  - `references` — fast scan for featured images and Gutenberg block references.
- **Integration test infrastructure**: Docker Compose setup with WordPress 6.7 +
  MySQL 8.0, WP-CLI setup script, and 10 integration tests.
- **CI workflow**: separate unit and integration test jobs, binary builds on tag.
- 36 unit tests, 11 integration tests (skip when Docker WP not available).

### Changed
- Removed `notImplemented()` scaffold helper — all commands now have real implementations.

[Unreleased]: https://github.com/gfargo/localpress/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/gfargo/localpress/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gfargo/localpress/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gfargo/localpress/releases/tag/v0.1.0
