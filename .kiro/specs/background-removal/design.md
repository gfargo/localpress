# Background Removal — Design

## Architecture

Background removal follows localpress's standard three-layer shape (see
`CLAUDE.md` repo map and `README.md`'s architecture diagram):

```
CLI command layer   src/cli/commands/remove-bg.ts
                     src/cli/mcp/tools.ts + invoke.ts  (MCP tool → CLI argv bridge)
        │
        ▼
Engine layer         src/engine/rembg/{models,remove-bg,system-rembg,onnx-types}.ts
                     src/engine/preview/{server,ui-remove-bg}.ts
                     src/engine/image/sharp-loader.ts (lazy sharp access)
                     src/engine/history/index.ts (snapshot/session capture)
                     src/engine/state/db.ts (SiteDb — SQLite attachments/history)
        │
        ▼
Adapter layer        src/adapters/resolver.ts (AdapterResolver)
                     src/adapters/{rest,wp-cli}.ts (get / upload / replace-in-place)
```

The command file owns argument parsing, output formatting (`info`/`warn`/
`error`/`printJson`), history-session lifecycle, and orchestration across
attachments. It never talks to WordPress directly — it goes through
`AdapterResolver.resolve()`/`tryResolve()` for `get`, `upload`, and
`replace-in-place` capabilities, so the same command works whether the site
is REST-only or has WP-CLI-over-SSH available (WP-CLI additionally makes
`replace-in-place` possible; REST-only sites fall back to a new upload, per
Requirement 7).

The actual pixel-level work (segmentation inference, mask compositing, PNG
encoding) lives entirely in `src/engine/rembg/remove-bg.ts` and is
adapter/WordPress-agnostic — it takes and returns plain `Buffer`s, which is
what makes it reusable by both the direct-batch path and the interactive
preview path in `src/cli/commands/remove-bg.ts`.

## Key files / modules

| Path | Responsibility |
|---|---|
| `src/cli/commands/remove-bg.ts` | Command registration (`localpress remove-bg [ids...]`), flag parsing, `--list-models`, `--preview` orchestration, the main per-ID processing loop, in-place-replace-with-fallback logic, SQLite bookkeeping, history session open/close, exit codes. |
| `src/engine/rembg/models.ts` | Static registry of the 5 supported models (URL, cached filename, approximate size, license); download-with-resume-safe-caching (`ensureModel`); `--list-models` data source (`listAvailableModels`, `isModelCached`). |
| `src/engine/rembg/remove-bg.ts` | The ONNX inference pipeline: preprocess → `onnxruntime-node` session → postprocess mask → alpha-composite → optional flatten/trim → PNG encode. Exports `removeBackground()`, plus the pure helpers `getOrientedDimensions()` and `parseHexColor()` (both unit-tested directly). |
| `src/engine/rembg/system-rembg.ts` | Optional shell-out path to a user-installed Python `rembg` CLI (`isSystemRembgAvailable`, `removeBackgroundWithSystemRembg`) using temp files and `child_process.spawn`. |
| `src/engine/rembg/onnx-types.ts` | Minimal hand-written TypeScript types for `onnxruntime-node`'s public surface, so the codebase can typecheck without the native package installed (it's dynamically imported at runtime — see "Lazy loading" below). |
| `src/engine/preview/server.ts` | Generic local Bun HTTP server used by both `remove-bg --preview` and `optimize --preview`: serves the UI HTML, `/api/source`, `/api/process`, `/api/apply`, `/api/cancel`, `/api/meta`, plus a WebSocket heartbeat and token/host-gating for every route but the initial page load. |
| `src/engine/preview/ui-remove-bg.ts` | The self-contained HTML/CSS/JS for the remove-bg preview page (model selector, alpha-threshold slider, trim checkbox, background-color picker, before/after compare slider, Apply/Cancel actions). No build step, no external assets. |
| `src/cli/mcp/tools.ts` | Declares the `remove_bg` MCP tool schema and maps its arguments onto the same CLI argv the terminal command would receive. |
| `src/engine/state/db.ts` / `schema.ts` | `SiteDb` — attachment upsert, `processing_history` rows, snapshot storage backing `history`/`undo`. |

## Data flow

### Batch path (`localpress remove-bg 123 456 --model isnet-general-use`)

1. Command validates `--model` against the static registry; on `--rembg`,
   checks `rembg --version` is runnable.
2. Preloads sharp (unless `--rembg`, which doesn't need it).
3. Opens/ensures the site's SQLite DB and, if history is enabled, opens one
   history session for the whole invocation.
4. For each ID, sequentially:
   a. `getAdapter.getMedia(id)` → WordPress attachment metadata + `url`.
   b. Upserts a placeholder `attachments` row up front (before any download)
      so a later `recordProcessing` call always satisfies its foreign key,
      even if the download or inference throws.
   c. `fetch(item.url)` → raw source bytes → SHA-256 hash.
   d. Either:
      - Built-in path: `removeBackground(sourceBytes, { model, trim, backgroundColor, onProgress })`
        → `ensureModel()` downloads/caches the `.onnx` file if needed → sharp
        preprocesses to the model's input size → `onnxruntime-node` runs
        inference → mask postprocess (sigmoid for BiRefNet, min-max for
        U2-Net/ISNet) → mask resized to oriented original dimensions →
        applied as alpha channel to the full-resolution source → optional
        `.flatten()` for `--bg` → optional `.trim()` → PNG-encode.
      - System path: `removeBackgroundWithSystemRembg(sourceBytes, { model: rembgModel })`
        writes a temp PNG, shells out to `rembg i`, reads back the temp
        output PNG.
   e. If history is enabled, captures a pre-write snapshot (original bytes +
      metadata) into the session before any write happens.
   f. Attempts `replaceAdapter.replaceInPlace(id, resultBytes, ...)` (unless
      `--keep-original`); on `CapabilityUnavailableError` (and not
      `--strict`) falls back to `uploadAdapter.upload(...)` as a new
      `-nobg.png` attachment.
   g. Upserts the final `attachments` row (real hash/size) and inserts a
      `processing_history` row (`status: 'success'` or `'failure'`).
5. After the loop, closes the history session (if any), closes the DB,
   prints/`printJson`s the summary, and exits 1 if any ID failed.

### Preview path (`localpress remove-bg 123 --preview`)

1. Requires exactly one ID. Downloads the source image once.
2. `startPreviewServer()` boots a `Bun.serve()` instance bound to
   `127.0.0.1`, serves `ui-remove-bg.ts`'s HTML at `/`, and opens the default
   browser with the session token in the URL fragment (so it's never sent to
   the server on the initial unauthenticated page load).
3. Browser calls `POST /api/process` with `{ model, alphaThreshold, trim,
   backgroundColor }`; the server's `onProcess` callback calls the exact same
   `removeBackground()` engine function used by the batch path against the
   already-downloaded `sourceBytes`, and returns bytes + timing stats. This
   is why the preview and CLI paths can never silently diverge on pixel
   output — they share one function.
4. User can toggle Original / Result / Compare (draggable slider) views, and
   re-run `/api/process` repeatedly with different parameters.
5. `POST /api/apply` invokes the command's `onApply` callback, which performs
   the identical replace-in-place → upload-fallback → SQLite bookkeeping
   sequence as the batch path (Requirement 7 logic is not duplicated as a
   separate code path — see the shared block description below), then
   resolves the server's `done` promise and shuts it down after a short
   delay so the HTTP response reaches the browser first.
6. `POST /api/cancel`, an idle timeout, or a browser-tab close outside the
   2.5s reconnect grace window all resolve `{ applied: false }` and shut the
   server down without writing anything.

Note: the preview's `onApply` in `remove-bg.ts` is a second, separately
written implementation of the replace-in-place/upload-fallback/SQLite-record
sequence, not a call into a shared helper function — it duplicates the same
logic as the batch loop's tail (lines ~175–268 vs ~419–520 in
`src/cli/commands/remove-bg.ts`). They are consistent today but are two call
sites to keep in sync if that logic changes.

## Key design decisions

**Why not `@imgly/background-removal-node` (the "obvious" choice)?**
`CLAUDE.md`'s Locked architectural decisions table states this explicitly:
*"`@imgly/background-removal-node` is AGPL-3.0 — incompatible with MIT."*
localpress is MIT-licensed (agency-friendly, matches the rembg/Squoosh/sharp
ecosystem it already depends on). AGPL-3.0 is a strong copyleft license that
would force any project bundling it — or arguably any project bundling
*localpress* — to be distributed under compatible copyleft terms. Since
localpress is a CLI tool other people embed, script, and redistribute
(Homebrew tap, GitHub Releases, MCP integration into third-party agent
hosts), taking on an AGPL dependency for a single feature would contaminate
the licensing story for the whole project. This was a hard constraint, not a
preference — see "Things that are tempting but wrong" in `CLAUDE.md`: *"Don't
bundle `@imgly/background-removal-node`. AGPL-3.0."*

**Why `onnxruntime-node` + a hand-picked model set instead?**
`onnxruntime-node` itself is MIT-licensed and is "just" a generic ONNX
inference runtime — it carries no opinion about which model you run through
it, so it doesn't inherit any model's license. The code comment at the top of
`src/engine/rembg/remove-bg.ts` is explicit about the intent: *"This is
essentially what rembg does under the hood, reimplemented in TypeScript with
onnxruntime-node to avoid the AGPL-3.0 @imgly dependency."* In other words,
localpress reimplements rembg's approach (U2-Net-family salient object
detection) directly rather than depending on rembg's own Python package,
while sourcing pre-trained `.onnx` weights whose licenses were checked
individually: u2net/u2netp/silueta/isnet-general-use are Apache-2.0 (sourced
from `danielgatis/rembg`'s GitHub release assets, which require no auth),
and birefnet-lite is MIT (from the `onnx-community/BiRefNet_lite-ONNX`
Hugging Face repo) — chosen specifically because it's described in
`models.ts` as "state-of-the-art quality" while still being compatible with
localpress's own MIT license. Every model is Apache-2.0 or MIT — no AGPL/GPL
anywhere in the dependency or model-weight chain.

*Note on a source-of-truth discrepancy found while writing this doc:*
`README.md`'s "Background removal models" table lists `silueta`'s license as
**MIT**, but the actual model registry in `src/engine/rembg/models.ts` records
it as **Apache-2.0**. This spec follows the code (`models.ts`) as the
authoritative source per this task's instructions, but the README should
probably be corrected (or the registry re-verified against upstream) since
they currently disagree.

**Why an escape hatch to system Python `rembg` at all, if the built-in
pipeline already avoids the AGPL dependency?** `rembg` (the Python package,
`danielgatis/rembg`) is itself MIT-licensed and offers a much larger model
zoo plus GPU acceleration that would be expensive to reimplement and keep in
sync. `--rembg` lets a user who has *already* installed it opt into that
without localpress bundling Python or a GPU-capable ONNX build. This is
purely additive/opt-in — `isSystemRembgAvailable()` is checked before use and
the command fails fast with an install hint rather than silently falling
back.

**Lazy loading.** Per `CLAUDE.md`'s conventions table: *"sharp,
onnxruntime-node, and jsquash codecs are all lazy-loaded via dynamic
`import()` so the CLI boots fast even if native binaries are missing."*
`remove-bg.ts` (the engine file) dynamically imports both
`../image/sharp-loader.ts` (`loadSharp()`) and `onnxruntime-node` inside
`removeBackground()`, not at module top-level. This means `localpress
remove-bg --list-models` and the rest of the CLI's command tree never pay the
cost of loading ONNX Runtime's native binary, and a machine without a
working ONNX build can still run every other localpress command — the error
only surfaces when `remove-bg` is actually invoked without `--rembg`.
`onnx-types.ts` exists solely to keep this dynamic import type-safe without
requiring `onnxruntime-node` to be resolvable at `tsc --noEmit` time.

**EXIF-orientation correctness.** `getOrientedDimensions()` is factored out
as a small pure function specifically so the width/height-swap logic for
EXIF orientations 5–8 (image data stored rotated 90°/270°, with the
orientation tag telling viewers how to display it upright) could be unit
tested without needing a real ONNX model or onnxruntime-node installed (see
Testing below). Getting this wrong produced sideways cutouts for
EXIF-oriented photos (iPhone portrait JPEGs being the common case) — the
code comment above the function calls this out directly.

**Output is always PNG.** Background removal produces a variable alpha
channel; JPEG/WebP-without-alpha can't represent that, so the pipeline always
encodes PNG regardless of the source format, and the in-place-replace call
site explicitly requests a MIME/extension change plus thumbnail
regeneration when the source wasn't already PNG (Requirement 7).

**Partial-download safety.** `ensureModel()` downloads to a `.partial`
sibling path and only `renameSync`s it into the final cached location after
confirming byte counts match `Content-Length` (when the server provides one).
This avoids `isModelCached()` (a simple `existsSync` check) ever treating a
truncated download — from a killed process or network drop — as a valid,
reusable cached model.

**Preview server security posture.** The preview HTTP server binds only to
`127.0.0.1` and gates every route except the initial page load behind both a
per-session random token (kept in the URL fragment, which browsers never
transmit to servers) and a same-host check (defense against DNS rebinding).
Failing either check returns an identical generic 404, so a network attacker
probing the port can't distinguish a bad token from a bad path. This is
shared preview-server infrastructure (`src/engine/preview/server.ts`, also
used by `optimize --preview`), not something specific to remove-bg, but it's
load-bearing for the remove-bg preview flow since it's what makes the
Apply-to-WordPress action safe to expose over HTTP.

## Error handling / edge cases actually implemented

- **Unknown `--model` value** → validated against the static registry before
  any network/inference work; exits 2.
- **Invalid `--bg` hex color** → `parseHexColor()` throws a descriptive error
  synchronously (regex-validated 3/6-digit hex) rather than producing
  `NaN`-derived colors.
- **Model download failure (non-OK HTTP response)** → throws with model name
  + status; no partial file is left at the canonical path.
- **Model download size mismatch** → partial file is deleted and an
  "incomplete... please retry" error is thrown; nothing is cached.
- **`--rembg` without `rembg` installed** → fails fast with an install hint,
  exit 2, *before* touching sharp or the image at all.
- **`--rembg` subprocess failure or missing output file** → surfaces exit
  code + captured stderr/stdout; temp files are cleaned up in a `finally`
  block regardless of success/failure.
- **`replace-in-place` unavailable** → caught as `CapabilityUnavailableError`;
  falls back to a new upload unless `--strict` is set, in which case it
  re-throws. A user-visible warning is printed when the fallback happens
  involuntarily (i.e., not because `--keep-original` was requested).
- **Per-ID failure inside a multi-ID batch** → caught, logged, counted, and
  the loop continues; a best-effort (`try`/swallow) `processing_history`
  failure row is still recorded, itself guarded so bookkeeping errors can't
  abort the remaining batch.
- **`--preview` with 0 or >1 IDs** → rejected with exit 2 before any server
  starts.
- **Preview idle timeout / tab-close** → resolves `{ applied: false }` and
  tears the server down cleanly; a short (2.5s) grace period distinguishes a
  page reload from an actual abandoned session.
- **EXIF-oriented source images** → handled via `getOrientedDimensions()` so
  mask/output dimensions match the upright image, not the raw stored
  dimensions.

## Testing approach

- `test/unit/remove-bg-orientation.test.ts` — unit tests `getOrientedDimensions()`
  across all 8 EXIF orientation values (1–4 no-swap, 5–8 swap), exercising
  exactly the bug class described above. The test file's own header notes
  that `removeBackground()` itself isn't exercised here because it needs a
  real onnxruntime-node + downloaded model — this suite deliberately isolates
  the pure dimension math instead.
- `test/unit/parse-hex-color.test.ts` — unit tests `parseHexColor()`: 6-digit
  parsing, 3-digit shorthand expansion, and throwing on invalid input
  (`'nope'`, `'#12345'`).
- `test/unit/dry-run-wiring.test.ts` — asserts `remove-bg` is one of the
  commands intentionally *excluded* from the shared `resolveDryRun` bulk-op
  gating (it's an explicit-ID-only command with no `--all` mode, so it
  executes immediately like `optimize 123` does for explicit IDs).
- `test/unit/mcp.test.ts` — asserts the MCP server registers a `remove_bg`
  tool (present in both the full tool-name list and a narrower
  processing-tools subset check) as part of its general tool-surface
  coverage.
- `test/tarball/smoke.test.ts` — end-to-end smoke test against the *built*
  binary: verifies the `onnxruntime-node` native binary for the current
  platform/arch is actually present in the compiled tarball (a packaging
  regression check, not a pixel-correctness check).
- No test in the repo exercises `removeBackground()`'s full inference path
  end-to-end (i.e., no integration test runs real ONNX inference against a
  downloaded model) — this is consistent with the project's stated pattern of
  isolating pure/pre-processing logic in unit tests for anything that
  requires a large binary model file or native runtime to fully execute.
  `test/integration/wp-rest.test.ts` (Dockerized WordPress) was not found to
  contain remove-bg-specific cases based on this review.
