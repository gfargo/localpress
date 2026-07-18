# Image Processing Engine — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Core engine (`src/engine/image/`)

- [x] Define engine-layer types: `ImageFormat`, `CompressionMode`, `OptimizeOptions`, `OptimizeResult`, `ImageInfo` (`src/engine/image/types.ts`) — Requirements 5, 6, 7
- [x] Implement `mimeToFormat()` and format guard lists (`ENCODABLE_FORMATS`, `ANIMATION_CAPABLE_FORMATS`) in `src/engine/image/optimize.ts` — Requirements 3
- [x] Implement `UnsupportedFormatError` and `AnimatedImageError` typed errors, raised before any encode is attempted — Requirement 3
- [x] Implement the sharp transform pipeline: auto-rotate (always), resize (`fit: inside`, `withoutEnlargement: true`), strip/keep metadata — Requirement 4
- [x] Implement per-format sharp encoding (jpeg/mozjpeg with white-background flatten, png level 9/effort 10, webp, avif, gif with animation passthrough) — Requirements 5, 7
- [x] Implement `binarySearchQuality()` (up to 8 iterations, 5% tolerance, quality-1 best-effort fallback) and wire it in behind `opts.targetSizeBytes` for lossy jpeg/webp/avif only — Requirement 6
- [x] Implement `optimizeImage()` as the single public entry point: probe metadata → guard checks → transform+encode (direct or via binary search) → before/after stats — Requirements 3, 5, 6
- [x] Implement `src/engine/image/mime.ts` shared `mimeToExtension`/`formatToMime` lookup tables — Requirement 3
- [x] Implement `src/engine/image/jsquash.ts`: dynamic per-format `@jsquash/*` imports, `jsquashEncode()`, OxiPNG post-pass for PNG with graceful fallback on failure, `isJsquashSupported()` — Requirement 7
- [x] Wire `--encoder jsquash` selection into `encodeImage()`'s raw-pixel extraction path (with byteOffset/byteLength-safe `Uint8ClampedArray` view) — Requirement 7
- [x] Implement `src/engine/image/sharp-loader.ts`: standard resolution → well-known global-path discovery → `SharpNotInstalledError`; `loadSharpWithPrompt()` with `--yes`/`--json`/`--quiet`-aware prompting and `installSharpGlobally()` — Requirement 7

## Preview engine (`src/engine/preview/`)

- [x] Implement `token-auth.ts` shared guard: `isValidHost` (Host-header vs. bound port), `extractToken` (header-first, query-param fallback), `isAuthorized` (timing-safe token compare) — Requirement 10
- [x] Implement `server.ts`'s `startPreviewServer()`: `Bun.serve()` on `127.0.0.1`, unauthenticated `GET /` page load, token-gated `/api/source`, `/api/result`, `/api/process`, `/api/apply`, `/api/cancel`, `/api/meta`, and `/ws` heartbeat upgrade — Requirement 10
- [x] Implement idle-timeout (default 10 min, reset on any authorized `/api/*` call) and WebSocket close-with-grace-period (2.5s) shutdown logic, distinguishing deliberate shutdown from a real tab-close — Requirement 10
- [x] Implement `ui-optimize.ts`'s `buildOptimizeHtml()`: format/encoder/quality/resize controls, profile dropdown (populated from `extraMeta.profiles`, pre-selected from `extraMeta.activeProfile`), single/result/compare (drag-slider) image views, stats panel, apply/cancel actions — Requirement 10
- [x] Implement `quick-view.ts` as a separate lightweight viewer sharing the same token-auth module (used by the interactive browser, not by optimize/convert/resize directly)

## CLI command wiring (`src/cli/commands/`)

- [x] `optimize.ts`: register command with `--all`, `--unoptimized`, `--larger-than`, `--to`, `--mode`, `--quality`, `--target-size` (with `parseTargetSize` unit parsing for `b`/`kb`/`mb`/`gb`), `--no-replace-in-place`, `--keep-original`, `--encoder`, `--max-width`/`--max-height`, `--strip-metadata`/`--no-strip-metadata`, `--preview`, `--preview-port`, `--regenerate-thumbnails`, `--profile`, `--force` — Requirements 1, 2, 3, 4, 5, 6, 7, 11
- [x] `optimize.ts`: explicit-ID vs. bulk resolution, `OPTIMIZABLE_MIME_TYPES` bulk whitelist filter, `--unoptimized` SQLite cross-reference against `processing_history` — Requirements 1, 2
- [x] `optimize.ts`: dry-run gate for bulk modes (`isBulk && !parentOpts.apply`), 20-item capped preview listing, `--json` dry-run payload — Requirement 2
- [x] `optimize.ts`: `--mode` validation (`lossy`/`lossless` only) and `--target-size`/`--quality` mutual-exclusivity validation (post-dry-run-check, execute path only) — Requirements 5, 6
- [x] `optimize.ts`: named-profile resolution with explicit-flag-wins-over-profile precedence — Requirement 11
- [x] `optimize.ts`: smart format default via cached `classify` result (`getCachedClassification`) — screenshot/diagram → PNG, photo/illustration → WebP, explicit `--to`/profile always wins — Requirement 3
- [x] `optimize.ts`: `shouldSkipOptimize()` idempotency function (result-hash comparison for in-place writes, source-hash comparison for upload-as-new fallback, `--force` bypass, params-changed bypass, failure-never-skips) — Requirement 9
- [x] `optimize.ts`: pre-write time-machine snapshot capture, replace-in-place with `CapabilityUnavailableError`/`--strict` fallback handling, new-attachment upload fallback, `--regenerate-thumbnails` passthrough — Requirements 8, 12
- [x] `optimize.ts`: "would grow / no real conversion" skip-and-record-as-`skipped` logic so `--unoptimized` doesn't reselect it, while still allowing a differently-parameterized re-run — Requirement 9
- [x] `optimize.ts`: `--preview` single-ID validation, source download, `startPreviewServer()` wiring with `onProcess`/`onApply` closures, profile metadata passthrough, fresh-metadata refetch after apply — Requirement 10
- [x] `optimize.ts`: per-item and summary result reporting (text and `--json`), non-zero exit on any failure, animated/unsupported-format skip-not-fail handling — Requirement 13
- [x] `convert.ts`: register command with required `--to` (validated against `webp`/`avif`/`jpeg`/`png`), `--quality`, `--keep-original`; download → hash → snapshot → `optimizeImage({ toFormat })` → replace-in-place-or-upload (with format-change MIME/extension passthrough) → SQLite record — Requirements 3, 8, 9 (partial — no idempotency skip), 12, 13
- [x] `resize.ts`: register command requiring at least one of `--max-width`/`--max-height`, plus `--quality`, `--keep-original`; same download/snapshot/replace-or-upload/record flow, plus `regenerate-thumbnails` attempt after in-place replace — Requirements 4, 8, 12, 13
- [x] Consistent animated-image/unsupported-format skip handling (warn + continue, not counted as failure) replicated across `optimize.ts`, `convert.ts`, `resize.ts` — Requirement 13

## MCP tool wiring (`src/cli/mcp/tools.ts`)

- [x] Register `optimize` MCP tool: typed schema (ids/unoptimized/all/quality/to/maxWidth/maxHeight/encoder/profile/stripMetadata/apply/concurrency), argv translation preserving CLI dry-run-by-default semantics, batched-invocation path for ID counts over the batch-chunk threshold — Requirement 14
- [x] Register `convert` MCP tool: typed schema (ids/to/quality/apply/concurrency), argv translation — Requirement 14
- [x] Register `resize` MCP tool: typed schema (ids/maxWidth/maxHeight/apply/concurrency), argv translation — Requirement 14

## Tests

- [x] `test/unit/optimize-idempotency.test.ts` — full `shouldSkipOptimize()` coverage including the localpress#97 regression scenarios — Requirement 9
- [x] `test/unit/optimize-target-size.test.ts` — binary-search convergence for jpeg/webp, quality-1 fallback, PNG no-op, normal-encode `finalQuality` — Requirement 6
- [x] `test/unit/image-guards.test.ts` — SVG rejection, MIME whitelist, animated-source preservation/rejection, JPEG transparency flattening, EXIF orientation baking — Requirements 3, 5
- [x] `test/unit/preview-auth.test.ts` — `isValidHost`/`extractToken`/`isAuthorized` unit coverage — Requirement 10
- [x] `test/unit/preview-server.test.ts` — real `startPreviewServer()` instance driven via `fetch()`, confirms token/Host gating on `/api/apply` — Requirement 10
- [x] `test/unit/preview-apply-extension.test.ts` — `mimeToExtension` mapping and preview apply-fallback filename derivation regression coverage — Requirement 10

## Notes: gaps found while backfilling (not part of the completed-work checklist above)

This section intentionally breaks from the all-`[x]` convention above because these are absences, not completed tasks — flagged here per the instruction to say plainly what couldn't be verified rather than guess:

- No dedicated CLI-level unit tests for `convert.ts` or `resize.ts` were found (only the shared `optimizeImage()` engine and idempotency logic are directly tested; command-layer flag validation and replace-in-place wiring for these two commands has no direct test file under `test/unit/`).
- No end-to-end integration or tarball-smoke coverage was confirmed for `optimize`/`convert`/`resize` actually running against WordPress (Dockerized or otherwise) — see design.md's Testing section for the specific gap between `test/tarball/smoke.test.ts`'s docstring claim ("verify optimize, convert, resize, and remove-bg all produce valid output") and what the test bodies actually exercise.
- `convert.ts`/`resize.ts` locally redefine `formatToMime`/`mimeToExtension` instead of importing the shared implementations from `src/engine/image/mime.ts` (functionally identical today; flagged as latent duplication, not a behavior bug).
- `optimize.ts`'s dry-run gate is implemented ad hoc (`isBulk && !parentOpts.apply`) rather than via the shared `resolveDryRun` helper CLAUDE.md describes as the convention for newer commands — behavior is correct today but inconsistent with the documented pattern.

## Docs

- [x] README.md documents `optimize`/`convert`/`resize` usage examples, the sharp/jSquash dual-encoder note, replace-in-place default + `--strict` fallback behavior, and idempotency — see "What it does" and "Key behaviors" sections.
- [x] CLAUDE.md documents this area under "Processing" in the command list and "Image processing" in the "What's implemented" section, plus the locked architectural decisions this design.md cites.
- [x] `skill/SKILL.md` referenced by CLAUDE.md as carrying the full command reference/JSON schemas for agent consumption (not independently re-verified line-by-line by this backfill).
