# Changelog

All notable changes to localpress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/gfargo/localpress/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gfargo/localpress/releases/tag/v0.1.0
