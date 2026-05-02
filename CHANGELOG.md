# Changelog

All notable changes to localpress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project scaffold: TypeScript + Bun, MIT license, Biome for lint/format.
- Directory structure and CLI command stubs for v0.1 commands (`init`, `sites`,
  `doctor`, `list`, `show`, `audit`, `optimize`, `pull`, `push`, `references`).
- `WpBackend` adapter interface with `RestAdapter` and `WpCliAdapter` skeleton classes.
- SQLite schema for per-site attachment state and processing history.
- Test scaffolding via Bun's built-in test runner.
- GitHub Actions CI workflow stub.
- Skill markdown outline for AI-agent integration.

[Unreleased]: https://github.com/gfargo/localpress/compare/HEAD
