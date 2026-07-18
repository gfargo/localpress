# Image Processing Engine — Design

## Architecture

This subsystem follows localpress's standard three-layer architecture (CLI command layer → engine layer → adapter layer), plus a fourth ephemeral layer for the preview UI:

```
┌──────────────────────────────────────────────────────────────────────┐
│ CLI command layer                                                     │
│ src/cli/commands/optimize.ts, convert.ts, resize.ts                   │
│   - flag parsing, dry-run gating, profile resolution                  │
│   - per-item orchestration loop (download → engine → upload/replace)  │
│   - SQLite bookkeeping (processing history, idempotency check)        │
│   - time-machine snapshot capture around each mutation                │
└───────────────────────────────┬────────────────────────────────────--┘
                                 │ calls
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Engine layer (framework-agnostic — bytes in, bytes + stats out)       │
│ src/engine/image/optimize.ts   — sharp pipeline, transforms, guards,  │
│                                   binary-search-by-size               │
│ src/engine/image/jsquash.ts    — WASM codec encode path               │
│ src/engine/image/sharp-loader.ts — lazy sharp discovery + auto-install│
│ src/engine/image/types.ts      — OptimizeOptions / OptimizeResult     │
│ src/engine/image/mime.ts       — format ⇄ MIME/extension lookups      │
│ src/engine/preview/*           — ephemeral Bun HTTP server + HTML UI  │
│ src/engine/history/*           — time-machine snapshot/session store  │
└───────────────────────────────┬────────────────────────────────────--┘
                                 │ calls
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Adapter layer                                                         │
│ src/adapters/resolver.ts — picks best adapter per capability          │
│ src/adapters/rest.ts     — always available; no replace-in-place      │
│ src/adapters/wp-cli.ts   — opt-in SSH; adds replace-in-place,         │
│                             regenerate-thumbnails                     │
└──────────────────────────────────────────────────────────────────────┘
```

The engine layer is intentionally WordPress-agnostic: `optimizeImage()` takes a `Buffer` and `OptimizeOptions`, returns a `Buffer` and stats. Nothing under `src/engine/image/` imports from `src/adapters/` or knows about attachment IDs, SQLite, or REST — that knowledge lives entirely in the CLI command layer, which is what lets `optimize`, `convert`, `resize`, and the preview server's `onProcess` callback all reuse the exact same `optimizeImage()` call with different option shapes.

## Key files / modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/optimize.ts` | `optimize` command: ID/bulk resolution, `--preview` wiring, idempotency check (`shouldSkipOptimize`), profile resolution, smart-format-default lookup via cached `classify` results, replace-in-place-with-fallback, SQLite recording. Exports `OPTIMIZABLE_MIME_TYPES`/`isOptimizableMime` (bulk whitelist) and `mimeToExtension` (re-exported from the engine). |
| `src/cli/commands/convert.ts` | `convert` command: validates `--to` against `webp`/`avif`/`jpeg`/`png`, same download → engine → replace-or-upload → record flow as optimize, scoped to a single format-conversion parameter set (no bulk modes, no preview, no encoder choice). |
| `src/cli/commands/resize.ts` | `resize` command: requires at least one of `--max-width`/`--max-height`, same flow, additionally attempts `regenerate-thumbnails` after a successful replace-in-place. |
| `src/engine/image/optimize.ts` | The actual image pipeline: probes source metadata via sharp, guards against unencodable/animated-mismatched targets, applies transforms (auto-rotate → resize → strip/keep metadata), encodes via sharp or jSquash, and (when `targetSizeBytes` is set) binary-searches quality. Exports `optimizeImage`, `mimeToFormat`, `UnsupportedFormatError`, `AnimatedImageError`. |
| `src/engine/image/jsquash.ts` | Encodes raw RGBA pixel data via `@jsquash/jpeg`/`png`/`webp`/`avif`, with an OxiPNG post-pass for PNG. All codec imports are dynamic. |
| `src/engine/image/sharp-loader.ts` | Finds sharp via standard resolution or well-known global install paths; `loadSharpWithPrompt()` offers interactive/`--yes`-driven auto-install when missing. Caches the loaded module for the process lifetime. |
| `src/engine/image/types.ts` | `ImageFormat`, `CompressionMode`, `OptimizeOptions`, `OptimizeResult`, `ImageInfo` — the engine's public contract. |
| `src/engine/image/mime.ts` | Shared `mimeToExtension` / `formatToMime` lookup tables. (Note: `convert.ts` and `resize.ts` currently define their own local copies of these instead of importing from this module — functionally identical today, but a latent duplication; see "Things that are tempting but wrong" is not the right place for this, it's just worth a maintainer's eye.) |
| `src/engine/preview/server.ts` | Ephemeral `Bun.serve()` HTTP+WebSocket server (`startPreviewServer`) shared by `optimize --preview` and `remove-bg --preview`. Serves the UI, source image, and JSON `process`/`apply`/`cancel`/`meta` endpoints; token + Host-header gated. |
| `src/engine/preview/ui-optimize.ts` | Self-contained HTML/CSS/JS string (`buildOptimizeHtml`) for the optimize preview: format/encoder/quality/resize controls, profile dropdown, before/after/compare image views, apply/cancel actions. No build step — served as a literal template string. |
| `src/engine/preview/token-auth.ts` | Shared `isValidHost` / `extractToken` / `isAuthorized` guards used by both `server.ts` and `quick-view.ts` to block DNS-rebinding and unauthenticated access to state-changing routes. |
| `src/engine/preview/quick-view.ts` | Separate, simpler "just show me this image" browser viewer used by the interactive media browser's `[P]` keybinding — not part of the optimize/convert/resize write path, but shares the same server pattern and auth module. |
| `src/adapters/types.ts` | Defines the `replace-in-place` capability and `ReplaceOptions` (regenerateThumbnails, newMimeType, newExtension) that `optimize`/`convert`/`resize` all pass through. |
| `src/adapters/resolver.ts` | `AdapterResolver.resolve()`/`tryResolve()` — picks WP-CLI when available for `replace-in-place`/`regenerate-thumbnails` (REST doesn't implement them at all — `RestAdapter.replaceInPlace` always throws `CapabilityUnavailableError`), REST for read-heavy ops. |

## Data flow

### `optimize <ids...>` / `optimize --unoptimized --apply` (non-preview)

1. CLI resolves the active site, adapter set, and (if `--profile`) a named profile's defaults.
2. Sharp is lazily loaded (with auto-install prompt if missing) before any items are touched.
3. Target items are resolved: explicit IDs are fetched directly; bulk mode paginates `listMedia`, applies `--larger-than`, cross-references the local SQLite `processing_history` table to drop already-optimized items (`--unoptimized`), and filters to `OPTIMIZABLE_MIME_TYPES`.
4. If bulk and `--apply` was not passed, the command prints a dry-run summary and returns without opening the DB or engine.
5. Otherwise, for each item: download source bytes → SHA-256 hash → resolve per-item options (explicit CLI flags > profile > smart classify-based default > built-in default) → `shouldSkipOptimize()` idempotency check against the last recorded `processing_history` row for that attachment+operation → `optimizeImage()` → SHA-256 hash the result.
6. If the result isn't smaller (and no real format conversion was requested), the item is recorded as `skipped` and left alone.
7. Otherwise a pre-write snapshot is captured into the time-machine store, then the result is written back: `replaceInPlace()` via the resolver's best `replace-in-place`-capable adapter, falling back to `upload()` as a new attachment on `CapabilityUnavailableError` (unless `--strict`).
8. The outcome (bytes before/after, saved ratio, applied steps, final quality, resultWpId, rewritten-reference count) is recorded into SQLite and appended to the results array; failures are recorded too (status `failure`) but don't stop the loop.
9. After the loop, the history session is closed/pruned, and a summary (text or `--json`) is printed; a non-zero exit code is used if any item failed.

### `optimize <id> --preview`

Same sharp-preload and single-item fetch, but instead of the loop above:

1. The source image is downloaded once into memory.
2. `startPreviewServer()` boots a local HTTP+WS server and opens the browser at `http://127.0.0.1:<port>#<token>`.
3. Every "Generate Preview" click in the browser POSTs params to `/api/process`, which invokes the *same* `optimizeImage()` used by the bulk path — no WordPress I/O happens here, so users can iterate freely.
4. "Apply & Upload" POSTs to `/api/apply`, which runs the *same* replace-in-place-with-fallback + SQLite-recording logic as the bulk path's per-item write step (duplicated inline in the `onApply` closure rather than factored into a shared helper — see "Known duplication" below), then fetches fresh metadata from WordPress for the success screen.
5. The command returns once the server resolves (`applied: true/false`), driven by apply, cancel, tab-close (with a 2.5s reconnect grace period for page reloads), or a 10-minute idle timeout.

### `convert` / `resize`

Structurally identical to optimize's per-item loop (download → hash → snapshot → `optimizeImage()` → replace-in-place-or-upload → record), but with a narrower option surface (no bulk modes, no `--preview`, no `--encoder`, no idempotency skip check — every invocation re-runs) and command-specific validation (`convert` validates `--to` against a fixed enum; `resize` requires at least one dimension flag).

## Key design decisions

These map to entries in `CLAUDE.md`'s "Locked architectural decisions" table:

- **sharp + jSquash WASM codecs, sharp as default.** sharp (libvips) handles all transforms (resize/rotate/metadata) and is the default encoder for every format. `--encoder jsquash` swaps only the final encode step to the `@jsquash/*` WASM codecs (still using sharp to decode and transform first), chosen for OxiPNG-quality PNG compression and consistent cross-platform WASM output without native binaries. Only `optimize` exposes `--encoder`; `convert`/`resize` always use sharp.
- **Everything native/WASM is lazy-loaded.** `sharp-loader.ts`'s `loadSharp()` is called on first use, not at module import time, and jSquash's `@jsquash/*` packages are dynamically `import()`-ed per-format inside `jsquash.ts`. This keeps `localpress --help` and non-image commands fast even on a machine without sharp installed, per the "Lazy loading" convention in `CLAUDE.md`.
- **Replace-in-place is the default, with an explicit escape hatch.** REST cannot replace attachment file bytes (WordPress's REST API has no such endpoint), so `RestAdapter.replaceInPlace()` always throws `CapabilityUnavailableError`. The CLI layer catches that specific error and falls back to uploading a new attachment (warning the user), unless the global `--strict` flag is set, in which case the error propagates. `--keep-original` (and `optimize`'s `--no-replace-in-place`) bypass replace-in-place entirely by user choice. This mirrors the "Replace in place" row in `CLAUDE.md`'s locked-decisions table.
- **Idempotency via SHA-256, not a "did we run this before" boolean.** `shouldSkipOptimize()` (in `optimize.ts`, unit-tested directly) compares the *live* downloaded hash against the previously recorded hash appropriate to how the prior run wrote its output — result hash for in-place replacement, source hash for the upload-as-new fallback — rather than a single fixed field, because the two write paths leave different bytes at the original URL. This was a real regression (`localpress#97`, referenced in code comments and `CHANGELOG.md`) and is the single most heavily-tested piece of this subsystem.
- **Guards against destructive re-encoding.** The engine explicitly refuses to (a) encode into a format it doesn't support (`UnsupportedFormatError`, e.g. never silently rasterize SVG bytes into PNG-labeled output) and (b) flatten an animated source into a single-frame target format (`AnimatedImageError`). Both are modeled as typed errors so callers can distinguish "this needs a warn-and-skip" from a real failure.
- **Bulk safety follows the shared dry-run convention.** `--all`/`--unoptimized` default to dry-run; explicit IDs execute immediately. This is the same pattern used elsewhere in the codebase (`CLAUDE.md`'s "Bulk safety" row), though note `optimize`/`convert`/`resize` implement the dry-run gate ad hoc (`isBulk && !parentOpts.apply`) rather than through the shared `resolveDryRun` helper that newer commands (`delete`, `posts update`, `metadata`, `references --update-to`) use — worth flagging as a slight inconsistency for anyone extending this area.
- **Preview is a real ephemeral local web server, not a mock.** `Bun.serve()` on `127.0.0.1` with an auto-assigned port, a per-session token delivered only via the URL fragment (never sent to the server or logged), and a `Host`-header check to block DNS-rebinding attacks from other tabs/pages reaching the state-changing endpoints. This is shared infrastructure (`token-auth.ts`) between the optimize preview and the remove-bg preview (and the unrelated quick-view image viewer).

## Error handling / edge cases

- **SVG / unencodable source formats** → `UnsupportedFormatError`, skipped with a warning (both at the bulk-filter level via `OPTIMIZABLE_MIME_TYPES`, and defensively inside the engine itself).
- **Animated GIF/WebP into a non-animation-capable target** → `AnimatedImageError`, skipped with a warning.
- **PNG-with-transparency → JPEG** → transparency is flattened onto a white background rather than rendering as black (JPEG has no alpha channel).
- **EXIF orientation** → always baked into pixel data via `.rotate()` regardless of whether `--strip-metadata`/`--no-strip-metadata` is set, so a sideways photo never comes out sideways even when metadata is otherwise preserved.
- **Result larger than source with no real conversion requested** → the write is skipped (not uploaded), and the skip is recorded with `status: 'skipped'` so `--unoptimized` won't reselect it forever, but a differently-parameterized future run (e.g. adding `--to avif`) still reprocesses it.
- **`--target-size` unreachable** → falls back to quality 1 and warns; for PNG/GIF (no quality knob) a different warning notes `--target-size` isn't supported for that output format.
- **Replace-in-place unavailable** → falls back to new-attachment upload with a warning, unless `--strict`.
- **Sharp not installed** → detected up front (before any downloads) via `loadSharpWithPrompt()`, with an interactive y/N prompt, `--yes` auto-accept, or immediate failure under `--json`/`--quiet`.
- **`--target-size` + `--quality` together** → rejected with a usage error, but only on the execute path — a bulk dry run with both flags set will show the dry-run listing without catching the conflict, since that validation runs after the dry-run early return in `optimize.ts`. This is a real gap in the current code, not a design intent.
- **Preview server abandoned** → 10-minute idle timeout (any `/api/*` call resets it) and a 2.5s WebSocket-close grace period (to tolerate a page reload) before treating a closed tab as "cancelled."
- **Preview apply-fallback filename/extension** → derived from the actual result MIME type (not a hardcoded `.webp`), falling back to the source item's MIME type, then to `.jpg` if neither is recognized (regression-tested — see Testing below).

## Testing approach

Unit tests (`bun test test/unit/`):

- `test/unit/optimize-idempotency.test.ts` — exhaustively covers `shouldSkipOptimize()`: no-prior-run, in-place match/mismatch, post-undo re-optimization, changed-params forcing a re-run, `--force` override, prior-failure never skipping, and the separate upload-as-new-fallback matching logic.
- `test/unit/optimize-target-size.test.ts` — exercises the real binary search against sharp-encoded fixtures for jpeg/webp, confirms the "prefer higher quality when target is generous" behavior, the quality=1 best-effort fallback when the target is unreachable, and that PNG ignores `targetSizeBytes` entirely (`finalQuality` stays `undefined`).
- `test/unit/image-guards.test.ts` — SVG → `UnsupportedFormatError`; `OPTIMIZABLE_MIME_TYPES`/`isOptimizableMime` whitelist correctness; animated GIF preserved through same-format and GIF→WebP conversion (skipped when the local libvips build lacks animation support); animated GIF → JPEG raises `AnimatedImageError`; transparent PNG → JPEG flattens to white; EXIF orientation 6 is baked into pixels even with metadata kept.
- `test/unit/preview-auth.test.ts` — unit-level coverage of `isValidHost`/`extractToken`/`isAuthorized` (DNS-rebinding rejection, header-vs-query-param token precedence).
- `test/unit/preview-server.test.ts` — integration-style test that boots a real `startPreviewServer()` instance (with `node:child_process` mocked so no real browser opens) and hits it with `fetch()` to confirm `/api/apply` and friends are unreachable without a valid token/Host.
- `test/unit/preview-apply-extension.test.ts` — regression test for the preview's apply-fallback filename derivation (`mimeToExtension` mapping and the format-aware `-optimized<ext>` naming), guarding against a past bug where AVIF bytes were uploaded under a hardcoded `.webp` name.

No dedicated `convert`/`resize` unit test files were found (no `test/**/*convert*` or `test/**/*resize*` matches) — their coverage is implicit via the shared `optimizeImage()` engine tests above; the CLI command files themselves (flag validation, replace-in-place fallback wiring, SQLite recording) have no direct unit tests. This is a real gap worth flagging rather than assuming otherwise.

**Verified, not assumed:** `test/integration/wp-rest.test.ts`'s one `optimize`-related match ("SQLite state tracking works end-to-end") calls `db.recordProcessing({ operation: 'optimize', ... })` directly against `SiteDb` — it exercises the state-tracking layer `optimize` relies on, but does **not** invoke the `optimize`/`convert`/`resize` CLI commands themselves against the Dockerized WordPress instance.

**Verified, not assumed:** `test/tarball/smoke.test.ts`'s file header claims to "verify optimize, convert, resize, and remove-bg all produce valid output," but the actual test bodies only: (1) assert `--help` output contains the strings "optimize"/"convert", (2) confirm sharp loads and can encode a JPEG *directly* (not through the `optimize` command), and (3) confirm the sharp/onnxruntime native binaries for the current platform are bundled correctly in the tarball. None of the three CLI commands in this spec are actually invoked end-to-end (e.g. `localpress optimize <id> --apply` against a running WordPress) anywhere in the test suite as inspected. This is a genuine coverage gap, not a documentation nitpick — a reviewer relying on the docstring's claim would be misled.
