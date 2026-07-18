# Background Removal

Backfilled spec documenting already-shipped functionality.

`localpress remove-bg` removes the background from one or more WordPress media
attachments using a locally-run AI segmentation model — no cloud API, no
credits, no image data leaving the machine. It exists because attribute-driven
media libraries (product photos, headshots, marketing assets) routinely need
background-free cutouts, and every existing off-the-shelf solution was either
a paid cloud API or `@imgly/background-removal-node`, which is AGPL-3.0 and
therefore incompatible with localpress's MIT license (see
`CLAUDE.md` → Locked architectural decisions). The command reimplements the
rembg-style pipeline directly on top of `onnxruntime-node` and a small
registry of Apache-2.0/MIT ONNX models, with an optional escape hatch to shell
out to a user-installed system `rembg` for its wider model zoo/GPU support.
Output is always a PNG (to carry the alpha channel) and, like other
image-mutating commands, is replaced in place when the backend supports it,
snapshotted for undo, and recorded in the local SQLite history.

## Requirement 1: Remove backgrounds from one or more attachments by ID

**User Story:** As a WordPress site operator, I want to strip the background
from one or more media attachments in a single command, so that I can produce
cutout-ready product/portrait images without uploading them to a third-party
service.

**Acceptance Criteria:**
- WHEN `localpress remove-bg <ids...>` is run with one or more numeric
  attachment IDs THE SYSTEM SHALL download each attachment's current image,
  run it through the background-removal pipeline, and upload/replace the
  result for each ID independently.
- WHEN no IDs are supplied and `--preview` is not set THE SYSTEM SHALL print
  an error ("Specify one or more attachment IDs...") and exit with code 2.
- WHEN processing multiple IDs THE SYSTEM SHALL continue to the next ID after
  a per-ID failure rather than aborting the whole batch, and SHALL report a
  failure count alongside successes.
- WHEN all requested IDs are processed THE SYSTEM SHALL print a summary line
  ("Done: N processed, M failed.") in human-readable mode, or a structured
  `{ processed, failures, results }` object under `--json`.
- IF any ID failed THEN THE SYSTEM SHALL exit with code 1 after processing the
  full batch.

## Requirement 2: Selectable ONNX segmentation models

**User Story:** As a user, I want to choose which local AI model performs the
segmentation, so that I can trade off speed, output quality, and download
size for my use case.

**Acceptance Criteria:**
- THE SYSTEM SHALL support exactly five built-in model choices via
  `--model <name>`: `u2net` (default, general purpose, ~176 MB,
  Apache-2.0), `u2netp` (lightweight/fast, ~4.7 MB, Apache-2.0), `silueta`
  (optimized u2net variant, ~44 MB, license recorded in the model registry as
  Apache-2.0 — see Design doc note on a README/registry discrepancy),
  `isnet-general-use` (better edge quality, ~176 MB, Apache-2.0), and
  `birefnet-lite` (state-of-the-art quality, ~224 MB, MIT).
- WHEN `--model` names a value outside that set THE SYSTEM SHALL print
  "Unknown model '<name>'. Available: ..." and exit with code 2 before doing
  any network or inference work.
- WHEN no `--model` is given THE SYSTEM SHALL use `u2net`.
- WHEN `localpress remove-bg --list-models` is run THE SYSTEM SHALL print
  each model's name, approximate size, license, and whether it is already
  cached locally, without processing any images, honoring `--json` for
  structured output.

## Requirement 3: On-demand model download and local caching

**User Story:** As a user, I want models to download automatically the first
time I use them and be reused afterward, so that I don't have to manage model
files by hand and don't re-download on every run.

**Acceptance Criteria:**
- WHEN a selected model's `.onnx` file is not present in the local models
  cache directory (`<config dir>/models/`) THE SYSTEM SHALL download it from
  its registered source URL (GitHub release asset for u2net/u2netp/
  silueta/isnet-general-use; a Hugging Face resolve URL for birefnet-lite)
  before running inference, emitting progress messages (source, license,
  percentage/MB downloaded).
- WHEN a selected model's file is already present in the cache THE SYSTEM
  SHALL skip the download and reuse the cached file.
- IF the download response is not OK (non-2xx) THEN THE SYSTEM SHALL raise an
  error identifying the model name and HTTP status, and SHALL NOT leave a
  usable file at the final path.
- WHEN a download completes THE SYSTEM SHALL write bytes to a temporary
  `<model>.onnx.partial` path first and only rename it to the final cached
  path after confirming the downloaded byte count matches the
  `Content-Length` header (when present); a size mismatch SHALL delete the
  partial file and raise an "incomplete download" error rather than caching a
  truncated model.

## Requirement 4: Segmentation pipeline correctness

**User Story:** As a user, I want the cutout to be correctly sized, oriented,
and alpha-composited regardless of the model's internal input resolution or
the source photo's EXIF orientation, so that I get a usable image without
manual fixups.

**Acceptance Criteria:**
- WHEN running inference THE SYSTEM SHALL resize the source image to the
  model family's expected input size (320×320 for u2net/u2netp/silueta,
  1024×1024 for isnet-general-use/birefnet-lite) and normalize pixels to
  NCHW float32 with ImageNet mean/std before feeding the ONNX Runtime
  session.
- WHEN the source image carries an EXIF orientation tag that rotates the
  image 90°/270° (orientation values 5–8) THE SYSTEM SHALL compute output
  width/height from the *oriented* (upright) dimensions, not the raw stored
  dimensions, so the resulting mask and cutout are not sideways.
- WHEN post-processing the model output for BiRefNet-family models THE
  SYSTEM SHALL apply a sigmoid activation and scale to [0,255]; for
  U2-Net/ISNet-family models THE SYSTEM SHALL min-max normalize the raw
  output range to [0,255].
- WHEN building the alpha mask THE SYSTEM SHALL zero out any mask pixel at or
  below the alpha threshold (default 10, 0–255 range) rather than leaving low
  partial-transparency noise in the background.
- WHEN compositing THE SYSTEM SHALL resize the mask back to the original
  (oriented) image dimensions and apply it as the alpha channel of the
  full-resolution source image, not the downscaled inference copy — so output
  resolution matches the source, not the model's input size.
- THE SYSTEM SHALL always output PNG bytes (to preserve the alpha channel),
  regardless of the source image's original format.

## Requirement 5: Optional flat background color and border trimming

**User Story:** As a user, I want to optionally fill the removed background
with a solid color, or trim away the now-transparent border, so that I can
produce ready-to-use assets without a second editing pass.

**Acceptance Criteria:**
- WHEN `--bg <color>` is supplied with a valid 3- or 6-digit hex color (with
  or without a leading `#`) THE SYSTEM SHALL flatten the transparent result
  onto that solid color instead of leaving it transparent.
- IF `--bg` is supplied with a value that is not a valid 3- or 6-digit hex
  string THEN THE SYSTEM SHALL raise an "Invalid hex color" error rather than
  silently producing a black or NaN-colored fill.
- WHEN `--trim` is supplied THE SYSTEM SHALL crop away fully-transparent
  border pixels from the final output.
- WHEN both `--bg` and `--trim` are supplied THE SYSTEM SHALL apply the
  background flatten before trimming (trim operates on the already-flattened
  image).

## Requirement 6: Optional system Python rembg backend

**User Story:** As a power user who already has Python `rembg` installed
(with its full model zoo and/or GPU acceleration), I want to reuse that
installation instead of the built-in ONNX pipeline, so that I can access
capabilities localpress doesn't bundle without localpress shipping Python.

**Acceptance Criteria:**
- WHEN `--rembg` is passed THE SYSTEM SHALL check that a `rembg` executable is
  on `PATH` (via `rembg --version`) before doing any work; IF it is not
  available THEN THE SYSTEM SHALL print an install hint
  (`pip install rembg[cli]`) and exit with code 2 without attempting the
  built-in pipeline as a fallback.
- WHEN `--rembg` is active THE SYSTEM SHALL skip the sharp-library
  preload/auto-install prompt that the built-in pipeline requires, since the
  system-rembg path does not use sharp.
- WHEN `--rembg` is active THE SYSTEM SHALL write the source image to a
  temporary file, invoke `rembg i [-m <model>] <in> <out>`, read back the
  output PNG, and delete both temporary files afterward (best-effort cleanup,
  even on failure).
- WHEN `--rembg-model <name>` is supplied alongside `--rembg` THE SYSTEM
  SHALL pass it through as rembg's `-m` model argument; this option has no
  effect without `--rembg`.
- IF the `rembg` subprocess exits non-zero or produces no output file THEN
  THE SYSTEM SHALL raise an error including the exit code and captured
  stderr/stdout.
- WHEN system rembg is used THE SYSTEM SHALL record the operation's duration
  as both "inference" and "total" time (the subprocess doesn't expose a
  separate inference-only timing) and SHALL label the result with the
  `rembg:<model-or-"default">` model identifier in output/history rather than
  an ONNX model name.

## Requirement 7: In-place replacement with fallback to new upload

**User Story:** As a user, I want the cutout to replace the original
attachment when possible, so that existing post/page references keep working,
while still getting a usable result when the backend can't do in-place
replacement.

**Acceptance Criteria:**
- WHEN `--keep-original` is NOT set and the active adapter supports the
  `replace-in-place` capability THE SYSTEM SHALL replace the original
  attachment's file bytes with the PNG cutout, keeping the same WordPress
  attachment ID.
- WHEN the source attachment's MIME type was not already `image/png` THE
  SYSTEM SHALL pass `newMimeType: 'image/png'`, `newExtension: '.png'`, and
  `regenerateThumbnails: true` to the replace call so WordPress serves the
  correct type and regenerates thumbnails; WHEN the source was already PNG
  THE SYSTEM SHALL still request thumbnail regeneration but not a
  format/extension change.
- WHEN a format-changing in-place replace triggers post-content reference
  rewriting AND rewrites succeed THE SYSTEM SHALL report the count of
  rewritten references; IF the rewrite step reports a warning (e.g. partial
  rewrite) THEN THE SYSTEM SHALL surface that warning to the user rather than
  silently succeeding.
- WHEN `--keep-original` IS set, OR the adapter does not support
  `replace-in-place`, OR `replace-in-place` throws
  `CapabilityUnavailableError` and `--strict` is not set THE SYSTEM SHALL fall
  back to uploading the cutout as a new attachment with filename
  `<original-basename>-nobg.png`, title `<original title> (background
  removed)`, and the original alt text carried over; the new attachment's ID
  is reported distinctly from the source ID.
- IF `replace-in-place` throws `CapabilityUnavailableError` and `--strict` IS
  set THEN THE SYSTEM SHALL propagate the error rather than silently falling
  back to a new upload.
- WHEN falling back to a new upload because in-place replacement was
  unavailable (not because the user asked to keep the original) THE SYSTEM
  SHALL warn the user that this happened rather than staying silent about the
  ID divergence.

## Requirement 8: History/undo integration

**User Story:** As a user, I want a `remove-bg` run to be undoable, so that a
bad model choice or threshold doesn't permanently destroy the original image
data.

**Acceptance Criteria:**
- WHEN history is enabled in config THE SYSTEM SHALL open one history session
  per `remove-bg` invocation (covering all IDs in that run) tagged with the
  operation parameters (model, `bg`, `trim`, `keepOriginal`).
- WHEN processing each attachment, before any write to WordPress or local
  state THE SYSTEM SHALL capture a pre-write snapshot of the original image
  bytes and its metadata (filename, MIME type, alt text, title, caption,
  description, dimensions, size) into that session, so `localpress undo` can
  restore it later.
- WHEN the batch finishes (success or partial failure) THE SYSTEM SHALL close
  the history session, applying the configured max snapshot size.
- WHEN history is disabled in config THE SYSTEM SHALL skip snapshot capture
  entirely and process attachments without it.

## Requirement 9: Local state / audit trail

**User Story:** As a user, I want every `remove-bg` run recorded locally, so
that `stats`, `history`, and dedup/idempotency logic can see what happened.

**Acceptance Criteria:**
- WHEN processing an attachment THE SYSTEM SHALL upsert an `attachments` row
  for it (source URL, hash, size, dimensions, MIME type) both before
  attempting the operation (to satisfy history's foreign-key requirement even
  if inference fails) and after a successful run (with the freshly computed
  source hash/size).
- WHEN an attachment is processed successfully THE SYSTEM SHALL record a
  `processing_history` row with operation `remove-bg`, the JSON-serialized
  parameters actually used, before/after SHA-256 hashes, before/after byte
  sizes, the resulting WordPress ID (only set when it differs from the
  source ID, i.e. a new upload happened), duration, and `status: 'success'`.
- WHEN an attachment fails to process THE SYSTEM SHALL best-effort record a
  `processing_history` row with `status: 'failure'` and the error message,
  and SHALL NOT let a failure in this bookkeeping step abort processing of
  the remaining IDs in the batch.

## Requirement 10: Browser-based interactive preview

**User Story:** As a user, I want to try different models/thresholds/colors
on a single image in a browser before committing to WordPress, so that I can
tune the result visually instead of guessing flags and re-running the CLI.

**Acceptance Criteria:**
- WHEN `--preview` is passed with exactly one attachment ID THE SYSTEM SHALL
  download that attachment once, start a local Bun HTTP preview server bound
  to `127.0.0.1` (auto-assigned port unless `--preview-port` is given), and
  open the user's default browser to it.
- IF `--preview` is passed with zero or more than one ID THEN THE SYSTEM
  SHALL print an error ("--preview requires exactly one attachment ID...")
  and exit with code 2 without starting a server.
- WHEN the preview page loads THE SYSTEM SHALL let the user choose the
  model (all 5 built-in ONNX models, defaulting to `birefnet-lite` in the UI
  selector), the alpha threshold (0–255 slider, default 10), whether to trim
  transparent borders, and whether to flatten onto a solid background color
  (color picker + hex text field).
- WHEN the user clicks "Generate Preview" THE SYSTEM SHALL run the built-in
  ONNX pipeline (not system rembg — the preview path does not expose
  `--rembg`) with the chosen parameters against the already-downloaded source
  bytes, and return inference/total timing plus before/after byte sizes for
  display, switching the view to a draggable before/after compare slider.
- WHEN the user clicks "Apply & Upload to WordPress" THE SYSTEM SHALL commit
  the last-generated result using the same in-place-replace-with-fallback
  logic as the non-preview path (Requirement 7), record it in SQLite as a
  `remove-bg` operation, and report the resulting WordPress attachment ID
  back to the browser before shutting the preview server down.
- WHEN the user clicks "Cancel", or closes the browser tab and does not
  reconnect within the grace period, or the server's idle timeout elapses
  without activity THE SYSTEM SHALL shut down the preview server without
  applying anything, and the CLI process SHALL report "Preview cancelled."
  and exit normally.
- THE SYSTEM SHALL gate every preview API route except the initial HTML page
  behind a per-session token (carried in the URL fragment, never sent to the
  server on the initial page load) and a same-host check, returning a
  generic 404 for any request that fails either check.

## Requirement 11: MCP tool parity

**User Story:** As an MCP-speaking agent host, I want a `remove_bg` tool with
the same capabilities as the CLI command, so that agents can drive background
removal without shelling out.

**Acceptance Criteria:**
- THE SYSTEM SHALL expose a `remove_bg` MCP tool accepting `ids` (array of
  positive integers), `model` (enum of the 5 built-in model names), `bg`
  (hex color string), `rembg` (boolean), `rembgModel` (string), `apply`
  (boolean), and the common `site`/`concurrency` arguments.
- WHEN the MCP tool is invoked THE SYSTEM SHALL translate its arguments into
  the equivalent `localpress remove-bg <ids...> [--model] [--bg] [--rembg]
  [--rembg-model] [--apply]` CLI invocation and return its structured result.
  Note: `remove-bg` is an explicit-ID-only command with no bulk `--all`/
  `--unoptimized` mode, so (per `test/unit/dry-run-wiring.test.ts`) it is
  excluded from the shared `resolveDryRun` gating and always executes
  immediately — the passed-through `--apply` flag has no observable effect
  on this particular command.
- THE SYSTEM SHALL NOT expose `--preview`/`--preview-port`/`--list-models`
  through the MCP tool — those remain CLI-only, interactive-terminal-oriented
  flags.
