# Changelog

All notable changes to localpress will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.0] - 2026-05-03

### Added
- **Browser preview for `optimize` and `remove-bg`**: pass `--preview` to open a local web UI
  where you can adjust settings (quality, format, model, alpha threshold, background color),
  see before/after comparison with a draggable slider, and apply the result to WordPress with
  one click. The preview server uses `Bun.serve()` on localhost with auto-assigned port.
- **WebSocket heartbeat**: the preview server detects when the browser tab closes and shuts
  down cleanly, returning control to the CLI without hanging.
- **BiRefNet model** (`birefnet-lite`): state-of-the-art background removal model (MIT licensed,
  ~224 MB). Uses Swin Transformer backbone with sigmoid output activation. Downloaded from
  HuggingFace ONNX community on first use.
- **ISNet model** (`isnet-general-use`): better edge quality than U2-Net for background removal
  (~176 MB, Apache-2.0). Uses 1024×1024 input resolution vs U2-Net's 320×320.
- **Quick browser image viewer** (`[P]` in interactive list): opens the selected image in the
  system browser via a lightweight localhost server. Terminal-agnostic alternative to the
  iTerm2 inline preview. Auto-shuts down when the tab closes.
- **Preview keybindings in interactive list**: `[O]` opens the optimize settings overlay in
  preview mode (opens browser after confirming settings), `[R]` opens remove-bg with browser
  preview. Lowercase `[o]` and `[r]` remain the fast non-preview paths.
- **Interactive list position persistence**: the page and cursor position are saved to SQLite
  when you quit the interactive browser and restored on next launch. Schema v2 migration adds
  a `preferences` key-value table.
- **Per-model input sizes**: the remove-bg engine now uses model-specific input resolutions
  (320×320 for U2-Net family, 1024×1024 for ISNet and BiRefNet) instead of a hardcoded constant.

### Changed
- **Default remove-bg model in preview UI**: the browser preview defaults to `birefnet-lite`
  (best quality) with `isnet-general-use` as second option. CLI default remains `u2net` for
  backward compatibility.
- **Schema version**: bumped to v2 (migration adds `preferences` table).

## [1.5.0] - 2026-05-03

### Added
- **`list -i` expanded sidebar actions**: image items now show `[r]` remove-bg, `[c]` convert,
  `[s]` resize, and `[a]` caption alongside the existing `[o]` optimize and `[e]` edit actions.
  Non-image items show only the actions that apply to them.
- **`list -i` optimize settings overlay**: pressing `[o]` now opens a settings form before
  dispatching — choose quality (0–100), target format (`keep`/webp/avif/jpeg/png, cycled with
  `←→`), and keep-original toggle. Press `↵` with blank fields to use CLI defaults.
- **`list -i` convert quality step**: after picking a format with `[c]`, a second prompt lets
  you enter a quality value (0–100) before confirming. `Esc` goes back to format selection.
- **`list -i` open in WordPress (`[W]`)**: `Shift+W` opens the WP admin media editor for the
  selected item in the system browser without leaving the TUI.
- **`list -i` alt text visibility**: list rows show a yellow `⚠` indicator for any image
  missing alt text. The sidebar shows `⚠ no alt text` / `✓ alt: <text>`. The details overlay
  always shows the Alt text field for images with an actionable hint when missing.
- **`list -i` details overlay enriched**: now shows Caption, Description, and a `⚠ missing`
  hint for images without alt text suggesting `[a]` to generate.

### Fixed
- **`remove-bg` model download 401**: switched ONNX model URLs from HuggingFace
  (now auth-gated) to GitHub release assets (`github.com/danielgatis/rembg/releases/download/v0.0.0/`).
  Existing cached models are unaffected.
- **`remove-bg` FOREIGN KEY constraint**: failure records were written to
  `processing_history` before the corresponding `attachments` row existed (e.g. when a
  model download failed on first use). Fixed by moving `upsertAttachment` to immediately
  after `getMedia` succeeds, ahead of any potentially-failing work.

## [1.4.3] - 2026-05-03

### Fixed
- **CI integration tests**: replaced GitHub Actions `services:` block and manual
  `docker run` / `docker exec` steps with `docker compose -f test/integration/docker-compose.yml`.
  The old approach used `${{ job.services.db.network }}` which `act` cannot resolve locally,
  making local CI reproduction impossible. The new approach works identically in both
  `act push -j integration-test` and the real GitHub Actions runner.
- **`setup-wp.sh` consolidated all WP setup**: pretty-permalinks, Apache `SetEnvIf`
  auth passthrough, must-use plugin for Application Passwords on HTTP, and
  `chown -R www-data:www-data wp-content` so the REST API upload test can write
  to directories that WP-CLI created as root.

## [1.4.2] - 2026-05-03

### Added
- **`list --interactive` live search**: press `/` to open a search bar and filter the current
  page's media list by filename or title in real time — no extra API calls. Typing narrows the
  list immediately; the bar shows a match count (`12 matches`). Navigation keys (`↑↓`/`jk`)
  work while the search bar is open. `Enter` exits typing mode but keeps the filter active so
  you can navigate the results. `Esc` clears the filter and restores the full list (or, if no
  filter is active, quits). Pressing `q` when a filter is active also just clears the filter.
  Loading a new page always clears the search. Keybinding hint `[/] search` added to the footer.
  Resolves [#14](https://github.com/gfargo/localpress/issues/14).

## [1.4.1] - 2026-05-03

### Fixed
- **`list --interactive` inline image preview**: removed auto-fetch on selection change — the
  previous behaviour fetched the full image on every cursor move, causing visible lag and
  cancelling in-flight requests. Preview is now **on-demand only**: press `[p]` to fetch and
  display. Subsequent presses on the same item reuse the cached download; selecting a new item
  clears the cache so `[p]` always shows the correct image.
- **`list --interactive` layout disruption from iTerm2 inline images**: the sidebar previously
  embedded the inline image escape sequence in a `<Box height={10}>` flex child. The iTerm2
  protocol rows propagated through the Yoga layout, creating a large vertical gap in the list
  panel. Images are now rendered only in a dedicated **preview overlay mode** (a completely
  separate Ink render tree with no list flex siblings), which eliminates the height-push
  entirely.

### Changed
- **`list --interactive` preview UX**: image preview is now a full-screen overlay triggered by
  `[p]`. The overlay shows the image scaled to the full terminal width/height, with a metadata
  strip and `[p] / [Esc]` to return to the list. The sidebar retains all metadata (filename,
  MIME type, dimensions, URL, optimized status) but no longer contains the inline image.
- Footer and sidebar keybinding hints show `[p] preview image` only on terminals that support
  the iTerm2 inline image protocol (iTerm2, Warp, WezTerm, Kitty).

## [1.4.0] - 2026-05-03

### Added
- **`caption` command**: AI alt-text generation for images using a locally-running
  [Ollama](https://ollama.com) vision model — no cloud API, no credits, no data
  leaving your machine. Supports bulk mode (`--missing-alt`), dry-run, model
  selection (`--model llava`), custom prompts, and `--list-models` to see what's
  installed. Recommended model: `moondream` (~1.7 GB). See the new
  [Ollama Setup guide](https://localpress.griffen.codes/docs/ollama-setup).
- **`stats` command**: cumulative processing stats pulled entirely from local
  SQLite — zero network calls. Shows files touched, operations succeeded/failed,
  total bytes saved (with % reduction), last-run date, and a per-operation
  breakdown table. `--all-sites` aggregates across every configured site.
- **`list --sort` and `--order` flags**: sort the media library by `date`
  (default), `name`, `size`, or `id`; order `asc` or `desc`. Sort info is shown
  in the plain-text header and preserved in the "next page" hint.

### Fixed
- **Integration test CI**: fixed WordPress Application Password auth in Docker —
  `wp core install` was using the container-internal port (`80`) as the site URL
  instead of the host-mapped port (`8880`), causing every REST API request to be
  redirected to a port not exposed on the host. Also added pretty-permalink setup
  (`wp rewrite flush --hard`) and an Apache `SetEnvIf Authorization` directive so
  `PHP_AUTH_USER` / `HTTP_AUTHORIZATION` reach PHP correctly.

## [1.3.1] - 2026-05-02

### Fixed
- **`list --interactive` typecheck errors**: restored missing `MediaItem` import
  removed when the exit-to-preview flow was deleted; boxed `pendingAction` in an
  object container so TypeScript does not narrow it to `never` across the
  `await waitUntilExit()` boundary.

### Changed
- **`list --interactive` sidebar thumbnail**: inline image preview now loads
  directly in the sidebar via the iTerm2 inline-image protocol — no TUI exit
  required. Supported terminals: iTerm2, Warp, WezTerm, Kitty.
- **`list --interactive` page-nav hints**: navigation bar now shows
  `← [b] prev page` / `[n] next page →` with dimming at boundaries, making
  paging discoverable at a glance.
- **`list --interactive` page-load spinner**: list panel replaces stale items
  with a centered braille spinner during page fetches; nav bar also animates.
- Removed `[v] preview` keybinding — preview is now always-on in the sidebar.

## [1.3.0] - 2026-05-02

### Added
- **`list --interactive` / `list -i`**: Ink-based TUI for browsing the media
  library without leaving the terminal. Arrow keys / `j`/`k` navigate items;
  `n`/`b` load the next/previous page; `o` emits an optimize command, `e`
  an edit command, `↵` a show command, `v` a preview command — then exits.
  On terminals ≥ 110 columns a sidebar renders the selected item's filename,
  MIME type, dimensions, URL, and localpress processing status.
- **`list --page <n>`**: explicit page selection for plain and JSON modes.
  WP REST API pagination is fully exposed — `--limit` sets `per_page` (max
  100), `--page` sets `page`.
- **`list` total-count display**: plain output now shows
  `Showing 1–50 of 355 item(s) (page 1/8)` and prints a
  `Next page: localpress list --page 2` hint when more pages exist. JSON
  output gains `total`, `totalPages`, and `page` fields.
- **`list -v` image preview**: when the terminal supports iTerm2 inline
  images (iTerm2, Warp, WezTerm, Kitty), pressing `v` in interactive mode
  fetches the selected image and renders it inline via the iTerm2 protocol.
  Falls back to printing the image URL on unsupported terminals.
- **`PagedResult<T>` type** and **`listMediaPage()`** method on the
  `WpBackend` interface. `RestAdapter` reads `X-WP-Total` and
  `X-WP-TotalPages` response headers; `WpCliAdapter` delegates to
  `listMedia()` and returns `totalPages: 1`.
- **WP-CLI SSH Setup wiki guide** at `.wiki/WP-CLI-SSH-Setup.md` — covers
  prerequisites, the SSH config block, common hosting setups (VPS, Kinsta /
  WP Engine, cPanel), and troubleshooting.

### Changed
- `init` SSH tip now links directly to the wiki guide:
  `localpress.griffen.codes/docs/wp-cli-ssh-setup`.
- `list --limit` is now capped at 100 (WP REST API maximum) and defaults
  to 50; previously the default was also 50 but the cap was not enforced.

## [1.2.0] - 2026-05-02

### Added
- **`audit --display-size`**: flags images significantly larger than their largest
  registered WordPress thumbnail size (≥2× pixel area). Compares source dimensions
  against `media_details.sizes` from the REST API. Surfaces the most common waste
  in real media libraries — a 4000px image used only as a 400px thumbnail.
- **`audit --duplicates`**: perceptual duplicate detection using dHash (difference
  hash) computed via sharp. Downloads each image, resizes to 9×8 grayscale, and
  compares 64-bit hashes with Hamming distance ≤ 5. Groups near-identical images
  for deduplication.
- **`audit --broken-refs`**: HEAD-checks every attachment URL concurrently (10 at
  a time) and flags any that return HTTP 404/410 or are unreachable.
- **`doctor --plugins`**: probes the WP REST API plugins endpoint to detect
  relevant installed plugins — Enable Media Replace (capability unlock), Jetpack
  (CDN awareness), Smush/ShortPixel/EWWW (conflict warnings).
- **`doctor --fix`**: runs a live REST API connection test and surfaces actionable
  remediation steps for auth failures, unreachable sites, and missing SSH config.
- **`config` command** with subcommands:
  - `config get <key>` / `config set <key> <value>` for `active-site`,
    `defaults.quality`, `defaults.format`, `defaults.concurrency`.
  - `config list` — prints full config with app passwords redacted.
  - `config set-profile <name>` — create/update named optimization profiles with
    `--quality`, `--format`, `--max-width`, `--max-height`, `--encoder`,
    `--strip-metadata`, `--description`.
  - `config get-profile`, `config list-profiles`, `config remove-profile`.
- **`OptimizationProfile` type** in `src/types.ts` — reusable processing presets
  stored in config and applied via `localpress optimize --profile <name>`.
- **`Config.profiles`** and **`Config.defaults`** fields for global defaults and
  named profiles.
- **Homebrew formula** at `Formula/localpress.rb` — platform-specific binary
  downloads for macOS (arm64/x64) and Linux (arm64/x64).
- **Release workflow** at `.github/workflows/release.yml` — builds binaries,
  computes SHA256 checksums, creates GitHub Release, and pushes updated formula
  to the `gfargo/homebrew-localpress` tap repository.
- **Homebrew tap repository** at `gfargo/homebrew-localpress` — enables
  `brew install gfargo/localpress/localpress`.

### Removed
- `undici` dependency — Bun's built-in `fetch` handles all HTTP; undici was
  unused dead weight.

### Changed
- CLI now registers 15 commands (added `config`).
- `doctor` now tests REST API connectivity on every invocation and reports
  `✓/✗ REST API connection` status.
- `audit` JSON output now includes `displaySize`, `duplicates`, and `brokenRefs`
  counts in the summary object.

## [1.1.0] - 2026-05-02

### Added
- **Ink-based interactive init wizard**: full React terminal UI with step-by-step
  prompts, colored output, masked password display, connection test spinner, and
  capability report. Replaces the readline-based prompts from v0.1. Falls back
  gracefully to non-interactive mode if Ink rendering fails.
- **jSquash WASM codec integration** (`--encoder jsquash`): alternative encoding
  path using Squoosh-derived WASM codecs for the final encoding step.
  - **OxiPNG** for significantly better lossless PNG compression than sharp's
    built-in PNG encoder.
  - MozJPEG, WebP, and AVIF encoding with full parameter control.
  - Consistent cross-platform output (WASM, no native binary differences).
  - Sharp still handles all transforms (resize, rotate, metadata strip);
    jSquash handles the final encoding when `--encoder jsquash` is passed.
- `OptimizeOptions.encoder` field in the engine types for programmatic use.

## [1.0.0] - 2026-05-02

### Added
- **Full skill for AI agent integration** (`skill/SKILL.md`): complete command
  reference with JSON output schemas, composition guide for WP MCP servers,
  global flags reference, error handling guide, and key behavior documentation.
  Ready for distribution via skill marketplaces.
- **`--rembg` flag** on `remove-bg` command: shells out to system Python rembg
  for users who have it installed (`pip install rembg[cli]`). Gives access to
  rembg's full model zoo and GPU acceleration without bundling Python.
- **`--rembg-model` flag**: pass any rembg model name (e.g. `isnet-general-use`,
  `birefnet-general`) when using the system rembg path.

### Changed
- Version bumped to 1.0.0 — all planned features from the v1 implementation
  plan are complete.

## [0.4.0] - 2026-05-02

### Added
- **`edit` command** — the round-trip editing workflow. Downloads an attachment
  to a temp directory, opens it in the user's default editor (or `--with <app>`),
  watches for saves via chokidar, and uploads changes back to WordPress
  automatically. The workflow no incumbent offers.
  - Cross-platform editor detection: macOS (`open`), Linux (`xdg-open`),
    Windows (`start`), or explicit `--with Photoshop` / `--with gimp`.
  - File watcher with debouncing and `awaitWriteFinish` to handle editors
    that do atomic writes (temp file → rename).
  - `--no-watch` to open without watching (manual upload via `push`).
  - `--keep-file` to preserve the temp file after editing.
  - `--to <dir>` to download to a specific directory.
  - Each save is recorded as an 'edit' operation in SQLite.
  - Standard replace-in-place fallback chain for uploads.

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

[Unreleased]: https://github.com/gfargo/localpress/compare/v1.3.1...HEAD
[1.3.1]: https://github.com/gfargo/localpress/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/gfargo/localpress/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/gfargo/localpress/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/gfargo/localpress/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/gfargo/localpress/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/gfargo/localpress/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gfargo/localpress/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gfargo/localpress/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gfargo/localpress/releases/tag/v0.1.0
