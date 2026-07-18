# Background Removal — Tasks

Backfilled record of already-completed implementation work, not a forward plan.

## Model registry and caching

- [x] Define the `ModelName` union and static registry (URL, cached
      filename, approximate size, license) for `u2net`, `u2netp`, `silueta`,
      `isnet-general-use`, `birefnet-lite` in `src/engine/rembg/models.ts`
      (Requirement 2)
- [x] Implement `getModelsDir()` / `getModelPath()` under the localpress
      config directory (Requirement 3)
- [x] Implement `isModelCached()` (Requirement 3)
- [x] Implement `ensureModel()`: streaming download with progress callbacks,
      `.partial`-file staging, `Content-Length` size verification before
      rename-into-place, and cleanup of a truncated partial on mismatch
      (Requirement 3)
- [x] Implement `listAvailableModels()` / `getModelInfo()` for `--list-models`
      and model validation (Requirement 2)

## Segmentation engine

- [x] Implement `removeBackground()` in `src/engine/rembg/remove-bg.ts`:
      per-model input-size lookup, sharp-based preprocessing (resize, EXIF
      `.rotate()` normalization, raw RGB extraction), ImageNet mean/std
      normalization into NCHW float32 (Requirement 4)
- [x] Lazy-import `onnxruntime-node` and `sharp` inside the function body
      (not module top-level) so the rest of the CLI stays fast/available
      without native ONNX binaries present (Requirement 4; CLAUDE.md
      "Lazy loading" convention)
- [x] Add `src/engine/rembg/onnx-types.ts` hand-written types so the dynamic
      `onnxruntime-node` import stays type-safe without the package being
      resolvable at typecheck time
- [x] Implement mask postprocessing: sigmoid activation for BiRefNet-family
      output, min-max normalization for U2-Net/ISNet-family output, and
      alpha-threshold zeroing (default 10) (Requirement 4)
- [x] Implement `getOrientedDimensions()` to correctly size the mask/output
      against the EXIF-upright image for orientations 5–8 (Requirement 4)
- [x] Composite the resized mask as the alpha channel of the full-resolution
      original image (not the downscaled inference copy) and encode PNG
      output (Requirement 4)
- [x] Implement `parseHexColor()` (3/6-digit hex, throws on invalid input)
      and wire optional `--bg` flatten + `--trim` border-cropping into the
      output pipeline, applied in that order (Requirement 5)

## System rembg integration

- [x] Implement `isSystemRembgAvailable()` / `getSystemRembgVersion()` via
      `rembg --version` (Requirement 6)
- [x] Implement `removeBackgroundWithSystemRembg()`: temp-file round trip
      through `rembg i [-m <model>] <in> <out>`, `finally`-block cleanup of
      both temp files (Requirement 6)

## CLI command wiring

- [x] Register `remove-bg [ids...]` in
      `src/cli/commands/remove-bg.ts` with `--model`, `--bg`, `--trim`,
      `--keep-original`, `--list-models`, `--rembg`, `--rembg-model`,
      `--preview`, `--preview-port` (Requirements 1, 2, 5, 6, 10)
- [x] Implement `--list-models` short-circuit (prints/`printJson`s registry +
      cached status, no image processing) (Requirement 2)
- [x] Implement `--model` validation against the registry before any
      network/inference work, exit code 2 on unknown model (Requirement 2)
- [x] Implement sharp preload-with-auto-install-prompt, skipped when
      `--rembg` is set (Requirement 6)
- [x] Implement the `--rembg` availability precheck with install-hint error
      and exit code 2 (Requirement 6)
- [x] Implement the per-ID batch loop: fetch metadata → upsert placeholder
      attachment row → download → hash → run built-in or system pipeline →
      snapshot (if history enabled) → replace-in-place with
      upload-as-`-nobg.png`-fallback → final attachment upsert +
      `processing_history` record (Requirements 1, 7, 8, 9)
- [x] Implement continue-on-per-ID-failure with best-effort failure recording
      that can't itself abort the batch, and non-zero exit when any ID failed
      (Requirement 1, 9)
- [x] Implement `--json` vs human-readable summary output (Requirement 1)
- [x] Implement `--preview` single-ID validation (exit 2 for 0 or >1 IDs)
      and orchestration: download once, start preview server, wire
      `onProcess`/`onApply` callbacks to the same engine + replace/upload
      logic used by the batch path (Requirements 7, 10)

## Preview UI

- [x] Build `src/engine/preview/ui-remove-bg.ts`: self-contained HTML/CSS/JS
      page — model dropdown (all 5 models), alpha-threshold slider,
      trim checkbox, background-color picker + hex text field, Original /
      Result / Compare view toggle with a draggable before/after slider,
      stats panel (inference/total time, before/after size), Generate
      Preview / Apply & Upload / Cancel actions, WebSocket heartbeat
      (Requirement 10)
- [x] Reuse the shared `src/engine/preview/server.ts` Bun HTTP server
      (`/api/source`, `/api/process`, `/api/apply`, `/api/cancel`,
      `/api/meta`, token + same-host gating, idle timeout, tab-close grace
      period) for the remove-bg preview mode (Requirement 10)

## History / state integration

- [x] Open one history session per `remove-bg` invocation (when history is
      enabled), tagged with the run's parameters, and close it after the
      batch completes (Requirement 8)
- [x] Capture a pre-write snapshot (original bytes + metadata) per attachment
      before any destructive write (Requirement 8)
- [x] Record `processing_history` rows with operation `remove-bg`,
      parameters, before/after hashes and sizes, result WordPress ID (when a
      new upload occurred), duration, and status for both success and
      failure cases (Requirement 9)

## MCP tool wiring

- [x] Register the `remove_bg` MCP tool in `src/cli/mcp/tools.ts` with
      `ids`, `model` (5-value enum), `bg`, `rembg`, `rembgModel`, `apply`,
      plus the common site/concurrency arguments (Requirement 11)
- [x] Map the tool's arguments onto the `remove-bg` CLI argv inside the
      tool's handler in `src/cli/mcp/tools.ts` (via the shared `runCli()`
      helper, which spawns the CLI binary and captures its `--json` output
      through `src/cli/mcp/invoke.ts`) (Requirement 11)

## Tests

- [x] `test/unit/remove-bg-orientation.test.ts` — `getOrientedDimensions()`
      across all 8 EXIF orientation values (Requirement 4)
- [x] `test/unit/parse-hex-color.test.ts` — `parseHexColor()` valid/shorthand/
      invalid cases (Requirement 5)
- [x] `test/unit/dry-run-wiring.test.ts` — confirms `remove-bg` is correctly
      excluded from the shared bulk dry-run gate (explicit-ID-only command)
      (Requirement 1)
- [x] `test/unit/mcp.test.ts` — confirms the `remove_bg` MCP tool is
      registered and present in the exposed tool surface (Requirement 11)
- [x] `test/tarball/smoke.test.ts` — confirms the `onnxruntime-node` native
      binary is packaged into the built tarball for the current
      platform/arch (Requirement 4 — packaging prerequisite)

## Docs

- [x] Document `remove-bg`, its 5 models, `--preview`, and `--rembg` in
      `README.md` ("Background removal models" section + quick-start
      example)
- [x] Document the AGPL-3.0-vs-MIT rationale for building on
      `onnxruntime-node` instead of `@imgly/background-removal-node` in
      `CLAUDE.md`'s Locked architectural decisions table
