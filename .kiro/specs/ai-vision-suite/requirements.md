# AI Vision Suite

Backfilled spec documenting already-shipped functionality.

This subsystem covers the six localpress CLI commands that generate WordPress
attachment metadata using a locally-running Ollama multimodal ("vision")
model: `caption` (alt text), `title`, `describe` (long description), `tag`
(short label list), `classify` (image-type detection), and `vision` (all of
the above in one pass). All six share the same underlying plumbing —
`src/engine/caption/ollama.ts` for the Ollama HTTP call and response
cleanup, and `src/engine/caption/run-bulk.ts` for the shared per-item bulk
loop used by `caption`, `title`, and `describe`. No cloud vision API is
used anywhere in this subsystem; this is a locked architectural decision
(see `CLAUDE.md`, "Locked architectural decisions" — "AI captioning /
vision"). The suite exists so a photographer, blogger, or agency running
localpress can bulk-fill accessibility and SEO metadata for a WordPress
media library without paying for a cloud vision API, without sending
images off-device, and without requiring a WordPress plugin.

## Requirement 1: Generate alt text with `caption`

**User Story:** As a site owner improving accessibility, I want to
generate WCAG-appropriate alt text for images that lack it, so that screen
reader users and search engines get meaningful descriptions without me
writing every one by hand.

**Acceptance Criteria:**
- WHEN `localpress caption <ids...>` is run with explicit attachment IDs THE SYSTEM SHALL download each attachment, send it to the configured Ollama model, and write the returned text to the attachment's `alt_text` field via the resolved adapter's `update-meta` capability.
- WHEN an attachment's `alt_text` is already non-empty AND `--overwrite` is not passed THE SYSTEM SHALL skip that attachment and report it as skipped rather than regenerating its alt text.
- WHEN `--missing-alt` is passed with no explicit IDs THE SYSTEM SHALL page through every image attachment via `listMediaPage`, filter to only those with an empty or missing `alt_text`, and process that set.
- WHEN `--all` is passed with no explicit IDs THE SYSTEM SHALL page through and process every image attachment regardless of existing alt text (subject to the same skip-if-set rule unless `--overwrite` is also passed).
- IF neither explicit IDs, `--missing-alt`, nor `--all` is supplied THEN THE SYSTEM SHALL print a usage error and exit with a non-zero exit code without contacting Ollama or WordPress.
- WHEN a bulk mode (`--missing-alt` or `--all`) is used without `--apply` THE SYSTEM SHALL run in dry-run mode: it still calls Ollama and prints the generated captions but does not call `updateMetadata` and does not create a time-machine snapshot.
- WHEN explicit attachment IDs are passed (no bulk flag) THE SYSTEM SHALL execute immediately (write to WordPress) without requiring `--apply`, honoring an explicit `--dry-run` if the user passes it.
- WHEN an attachment's MIME type does not start with `image/` THE SYSTEM SHALL skip it with a warning rather than attempting to caption it.
- WHEN captioning succeeds and the run is not a dry run THE SYSTEM SHALL capture a metadata-only time-machine snapshot of the previous alt text, title, caption, and description before writing the new value, so the change can be reversed with `localpress undo`.
- WHEN a per-item download, Ollama call, or WordPress write fails THE SYSTEM SHALL record the failure, continue processing the remaining IDs, and exit with a non-zero code if any failures occurred, without aborting the whole batch.

## Requirement 2: Local-only Ollama backend, no cloud dependency

**User Story:** As a privacy-conscious user, I want all AI vision
processing to happen on my own machine against a local Ollama server, so
that my images and site content never leave my hardware and I incur no
per-call cloud costs.

**Acceptance Criteria:**
- WHEN any vision command runs THE SYSTEM SHALL send image data only to the Ollama HTTP API (`/api/generate`, default `http://localhost:11434`, overridable via `--ollama-url`) and SHALL NOT call any cloud vision/LLM API.
- WHEN Ollama is not reachable at the resolved URL THE SYSTEM SHALL fail fast before doing any per-item work, printing setup instructions (`ollama serve`, `ollama pull <model>`, a setup-guide link) and exiting with exit code 2.
- WHEN the resolved model is reachable via `isOllamaAvailable` but not actually installed locally (checked via `/api/tags` against `listOllamaModels`) THE SYSTEM SHALL fail the pre-flight check before processing any attachment, listing any vision models that ARE installed locally as a remediation suggestion, and exit with exit code 2 — this avoids a 300-item bulk run failing identically on every single item.
- IF the pre-flight installed-model check itself throws (e.g. a transient network blip after the initial availability probe) THEN THE SYSTEM SHALL log a warning and continue into the per-item loop rather than blocking the run, letting individual item failures surface normally.
- WHEN resolving which model to use THE SYSTEM SHALL apply this precedence: `--model` flag, then `config.defaults.captionModel`, then the built-in default `moondream`.

## Requirement 3: Bulk-fill only missing fields

**User Story:** As someone maintaining a large media library, I want to
target only the attachments that are missing a given field, so that I
don't waste time/compute regenerating fields that are already populated
and don't accidentally clobber hand-written content.

**Acceptance Criteria:**
- WHEN `caption --missing-alt` is used THE SYSTEM SHALL select only attachments whose `alt_text` is empty/whitespace after trimming.
- WHEN `title --missing-title` is used THE SYSTEM SHALL select attachments whose title is empty OR matches a machine-generated pattern (`Screenshot-…`, `Image123`, `IMG_123`, `DSC_123`, `Untitled…`, a bare number, or an 8+ char hex string) — such titles are treated as equivalent to "no title set."
- WHEN `describe --missing-description` is used THE SYSTEM SHALL select attachments whose `description` field is empty/whitespace.
- WHEN `tag --missing-tags` is used THE SYSTEM SHALL select attachments whose `caption` field does not already contain a `[tags: …]` block (matched via regex `\[tags:\s*([^\]]*)\]`).
- WHEN a targeted field already has a value and `--overwrite` is NOT passed THE SYSTEM SHALL skip the item, log the reason, and still include it in the results list marked as skipped (not as a failure).
- WHEN `--overwrite` is passed THE SYSTEM SHALL regenerate and replace the field regardless of its current value.
- WHEN `tag` finds an existing `[tags: …]` block and `--overwrite` is passed THE SYSTEM SHALL replace only that block in place, preserving any surrounding user-written caption text; if no block exists, THE SYSTEM SHALL append the new block to existing caption text (or use it standalone if the caption was empty).

## Requirement 4: Generate short titles with `title`

**User Story:** As a site owner with machine-generated attachment titles
("Screenshot-2026-05-06-at-5.20.18-PM"), I want AI-generated human-readable
titles, so that my media library and permalinks are more meaningful without
manual renaming.

**Acceptance Criteria:**
- WHEN `localpress title <ids...>` runs THE SYSTEM SHALL request a 3-7 word noun-phrase title from Ollama and write it to the attachment's WP `title` field via `updateMetadata`.
- WHEN the generated title is post-processed THE SYSTEM SHALL strip surrounding quotes, take only the first line, strip a leading `Title:`/`Caption:`/`Alt-text:` label, strip trailing punctuation, and hard-truncate at 80 characters on a word boundary.
- WHEN `--language <lang>` is passed THE SYSTEM SHALL instruct the model to write the title in that language.
- WHEN neither explicit IDs, `--missing-title`, nor `--all` is passed THE SYSTEM SHALL print a usage error and exit non-zero.

## Requirement 5: Generate longer descriptions with `describe`

**User Story:** As a site owner building image galleries, I want a longer
2-3 sentence AI-generated description per image, so that attachment pages
and gallery captions have useful, SEO-relevant text without manual writing.

**Acceptance Criteria:**
- WHEN `localpress describe <ids...>` runs THE SYSTEM SHALL request a factual 2-3 sentence description and write it to the attachment's WP `description` field via `updateMetadata`.
- WHEN describing in bulk (`--all` / `--missing-description`) without `--apply` THE SYSTEM SHALL run as a dry run (Ollama is still called and results printed, but nothing is written to WordPress).
- WHEN `--language <lang>` is passed THE SYSTEM SHALL generate the description in that language.

## Requirement 6: Classify image type with `classify`

**User Story:** As a user running bulk `optimize`, I want images to be
automatically classified by type (screenshot vs. photo vs. illustration vs.
diagram), so that `optimize` can pick smarter default output formats (e.g.
PNG for screenshots, WebP for photos) without me specifying `--format` per
image.

**Acceptance Criteria:**
- WHEN `localpress classify <ids...>` runs THE SYSTEM SHALL ask Ollama to classify each image into exactly one of `screenshot`, `photo`, `illustration`, or `diagram`.
- WHEN parsing the model's response THE SYSTEM SHALL pick whichever known label is mentioned earliest in the model's reply (checking the first line first, then the full text), rather than doing a naive substring search — this avoids a hedge like "this is a photograph, not a screenshot" from matching the wrong (negated) label.
- IF no known label is found in the response THEN THE SYSTEM SHALL fall back to the first word of the response, lowercased and stripped of non-letters, or `unknown` if that is also empty.
- WHEN classification succeeds THE SYSTEM SHALL cache the result in the local SQLite `processing_history` table (operation `classify`, `paramsJson` containing the model and classification) so it can be looked up later without re-running Ollama.
- WHEN `classify` runs THE SYSTEM SHALL NOT write anything to WordPress by default — it is a local, read-and-cache-only operation with no `--apply`/dry-run distinction, and IDs are always required explicitly (no `--all`/`--missing-*` bulk mode).
- WHEN `optimize` runs without an explicit `--format`/`--to` override THE SYSTEM SHALL be able to read a cached classification via `getCachedClassification()` to bias its format default (screenshots/diagrams toward PNG, photos/illustrations toward WebP), when a prior `classify` run exists for that attachment on that site.

## Requirement 7: Generate tags with `tag`

**User Story:** As a user without custom taxonomies registered for
attachments, I want AI-generated descriptive tags stored somewhere durable
and universally available over the REST API, so that I get lightweight
categorization without requiring a WordPress plugin or custom post-type
registration.

**Acceptance Criteria:**
- WHEN `localpress tag <ids...>` runs THE SYSTEM SHALL request 3-6 short, lowercase, comma-separated tags from Ollama.
- WHEN cleaning the raw tag response THE SYSTEM SHALL lowercase it, split on commas and newlines, strip list markers and punctuation from each token, drop empty or over-30-character tokens, deduplicate, and keep at most 6 tags.
- IF the cleaned tag list is empty THEN THE SYSTEM SHALL treat this as an error ("Vision model returned no usable tags") rather than writing an empty tag block.
- WHEN writing tags THE SYSTEM SHALL store them as a `[tags: tag1, tag2, …]` block inside the attachment's WP `caption` field (not a WordPress taxonomy), because the caption field is available on the `attachment` post type via REST on any WordPress install without extra registration.
- WHEN an attachment's caption already contains user-written text alongside an existing `[tags: …]` block, and the block is being replaced (`--overwrite`), THE SYSTEM SHALL replace only the bracketed block via regex substitution, leaving the rest of the caption text untouched.

## Requirement 8: Composed single-pass generation with `vision`

**User Story:** As an agent or user doing a one-off deep-dive on a specific
attachment, I want to generate all AI metadata fields (alt, title,
description, tags, classify) in one command, so that I don't have to invoke
five separate commands and re-download the same image five times... — and
so I can review everything as a single proposal before deciding to write
anything.

**Acceptance Criteria:**
- WHEN `localpress vision <ids...>` runs without `--apply` THE SYSTEM SHALL print the generated value for each requested field for each attachment but SHALL NOT call `updateMetadata` and SHALL NOT open a time-machine session — this is the command's default (print-only) mode, distinct from the bulk-command dry-run convention.
- WHEN `--apply` is passed THE SYSTEM SHALL write only the fields that either have no existing value or where `--overwrite` was passed, and SHALL open a time-machine session before the first mutating write.
- WHEN `--fields <list>` is passed as a comma-separated subset of `alt,title,description,tags,classify` THE SYSTEM SHALL generate only those fields; when omitted, all five are generated.
- IF `--fields` contains an unrecognized value THEN THE SYSTEM SHALL print an error listing the valid field names and exit with code 2 without contacting Ollama.
- WHEN `--fields` resolves to an empty list (e.g. `--fields ""`) THE SYSTEM SHALL print an error and exit with code 2.
- WHEN `vision` applies a `classify` result THE SYSTEM SHALL also cache it into `processing_history` exactly like the standalone `classify` command, so `optimize` benefits from `vision --apply` runs too.
- WHEN an attachment is not an image (MIME type doesn't start with `image/`) THE SYSTEM SHALL skip it with a log message and continue to the next ID.
- WHEN `vision` is applied and every targeted field already has a value and `--overwrite` was not passed THE SYSTEM SHALL make no WordPress write for that item and report "nothing to write."

## Requirement 9: List locally available vision models

**User Story:** As a user setting up localpress, I want to see which
Ollama vision-capable models I already have pulled locally, so that I can
pick one via `--model` or `config set defaults.captionModel` without
guessing or re-downloading a model I already have.

**Acceptance Criteria:**
- WHEN `localpress caption --list-models` is run THE SYSTEM SHALL query Ollama's `/api/tags` endpoint and filter the result to model names matching known vision-model name patterns (`moondream`, `llava`, `bakllava`, `llama*vision`, `qwen*vl`, `minicpm`, `phi*vision`).
- IF no model name matches the vision-model pattern THEN THE SYSTEM SHALL fall back to listing all locally installed models (some vision-capable models may not match the heuristic).
- WHEN `--list-models` is combined with `--json` THE SYSTEM SHALL print the model list (name + size in bytes) as JSON instead of a formatted table.
- IF Ollama is not reachable when `--list-models` is passed THEN THE SYSTEM SHALL print the same "Ollama is not running" error/remediation text used elsewhere and exit with code 2.
- IF no models are installed at all THEN THE SYSTEM SHALL print a hint to run `ollama pull moondream` rather than an empty table.

## Requirement 10: Multilingual output via `--language`

**User Story:** As a user managing a non-English WordPress site, I want
generated alt text, titles, and descriptions written directly in my site's
language, so that I don't have to run every result through a separate
translation step.

**Acceptance Criteria:**
- WHEN `--language <lang>` is passed to `caption`, `title`, `describe`, or `vision` THE SYSTEM SHALL append a "Write in `<lang>`." instruction to the per-kind prompt sent to Ollama.
- WHEN no `--language` is passed THE SYSTEM SHALL use the default English-language prompt for that field kind.
- `classify` and `tag` do NOT accept a `--language` option, since their outputs are fixed closed-vocabulary labels (classify) or short lowercase tokens (tag) not intended for translation.

## Requirement 11: Automatic fallback model on garbage output

**User Story:** As a user running a small/fast vision model (e.g.
`moondream`) for speed, I want localpress to automatically retry with a
stronger fallback model when the primary model produces unusable output, so
that I get bulk-run speed most of the time without silently writing garbage
alt text on the images where the small model struggles.

**Acceptance Criteria:**
- WHEN `caption`/`title`/`describe` (via `generateCaptionWithFallback`) receives a result from the primary model THE SYSTEM SHALL evaluate it with a garbage-output heuristic before accepting it.
- WHEN the heuristic flags the output as garbage (under 10 characters after trimming; matches a bare coordinate/float array pattern like `[0.3, 0.13, 0.64, 0.26]`; or is mostly numeric/punctuation with fewer than 5 non-numeric characters) AND a `--fallback-model` (or `config.defaults.captionFallbackModel` for `caption`) is configured THE SYSTEM SHALL retry the same image against the fallback model.
- IF no fallback model is configured THEN THE SYSTEM SHALL return the primary model's result as-is even if it looks like garbage — the heuristic only gates the fallback retry, it never blocks or errors the primary result.
- IF the fallback model's result also looks like garbage THEN THE SYSTEM SHALL return whichever of the two results is longer (treated as marginally more likely to be useful) rather than erroring.
- WHEN a fallback retry occurs and succeeds cleanly THE SYSTEM SHALL report a combined `durationMs` covering both the primary and fallback calls.
- `classify` and `tag` (via `generateCaption` directly, not `generateCaptionWithFallback`) do NOT participate in the fallback-model mechanism.

## Requirement 12: Image pre-processing before reaching Ollama

**User Story:** As a user captioning large photos or 4K/Retina screenshots,
I want localpress to handle format/size compatibility with Ollama
automatically, so that captioning doesn't silently fail or return empty
responses on inputs the vision model can't handle well.

**Acceptance Criteria:**
- WHEN an image is sent to Ollama THE SYSTEM SHALL first downscale it (via sharp) so its longest edge is at most 1024px, if it exceeds that, using `fit: inside` with `withoutEnlargement: true`.
- WHEN an image's format is not PNG or JPEG (e.g. WebP, AVIF, GIF) THE SYSTEM SHALL re-encode it to PNG before sending it to Ollama, since Ollama vision models cannot read WebP/AVIF directly.
- IF sharp is not installed/available or the pre-processing step throws THEN THE SYSTEM SHALL fall back to sending the original unmodified image bytes rather than failing the caption request outright.
- WHEN calling Ollama's `/api/generate` THE SYSTEM SHALL cap the model's output with `num_predict: 200` and enforce a 120-second request timeout, raising a clear "Ollama did not respond" error on timeout rather than hanging indefinitely.
- WHEN Ollama returns an empty or whitespace-only response THE SYSTEM SHALL raise an error suggesting a different `--model`, rather than writing an empty string to WordPress.

## Requirement 13: Response cleanup per field kind

**User Story:** As a user relying on unsupervised bulk AI writes, I want
the raw, often verbose model output cleaned into a field-appropriate shape
before it's written to WordPress, so that alt text doesn't come out as "The
image shows a red mug on a desk. Here is a detailed analysis: ..." and
titles/tags/classifications aren't polluted with extra prose.

**Acceptance Criteria:**
- WHEN cleaning `alt` or `description` output THE SYSTEM SHALL strip surrounding quotes, keep only the first paragraph, cut everything from the first bulleted list onward, strip known meta-phrase intros ("The image shows…", "Here is a description of…", "I see…", etc.), and truncate at a word boundary past 240 characters.
- WHEN cleaning `title` output THE SYSTEM SHALL keep only the first line, strip a leading label, strip trailing punctuation, and truncate at a word boundary past 80 characters.
- WHEN cleaning `classify` output THE SYSTEM SHALL apply the earliest-label-match logic described in Requirement 6.
- WHEN cleaning `tags` output THE SYSTEM SHALL apply the tokenize/clean/dedupe/cap-at-6 logic described in Requirement 7.
