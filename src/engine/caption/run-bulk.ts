/**
 * Shared bulk runner for vision-AI commands (caption / title / describe).
 *
 * Handles the per-item plumbing every command needs:
 *   - resolving the effective Ollama model
 *   - pre-flight model-availability check
 *   - per-item: fetch attachment, download bytes, generate, write via adapter
 *   - per-item: time-machine snapshot before mutation
 *   - per-item: processing_history row + FK-safe upsertAttachment
 *   - graceful failure handling (catch FK errors, never abort the loop)
 *   - structured results for --json output
 *
 * Each command supplies a `kind` (alt / title / description / …) and a
 * `writeField` function describing which WP metadata field receives the
 * generated text.
 */

import type { WpBackend } from '../../adapters/types.ts';
import type { UpdateMetadata } from '../../adapters/types.ts';
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
} from '../history/index.ts';
import type { SiteDb } from '../state/db.ts';
import { generateCaptionWithFallback, isOllamaAvailable, listOllamaModels } from './ollama.ts';
import type { VisionKind } from './types.ts';

export interface BulkRunItemResult {
  id: number;
  filename: string;
  generated: string;
  previous?: string;
  skipped: boolean;
  durationMs: number;
}

export interface BulkRunResult {
  processed: number;
  skipped: number;
  failures: number;
  results: BulkRunItemResult[];
}

export interface BulkRunOptions {
  kind: VisionKind;
  operation: string;
  /** Which metadata field receives the generated text. */
  buildUpdate: (generated: string) => UpdateMetadata;
  /** Previous value of the target field (for snapshot + idempotent skip). */
  readPrevious: (item: Awaited<ReturnType<WpBackend['getMedia']>>) => string | undefined;
  /** Skip items that already have a value when --overwrite is not passed. */
  overwrite: boolean;
  /** Render-or-skip an item before any model work — return undefined to keep, string to log a skip reason. */
  preflightSkip?: (item: Awaited<ReturnType<WpBackend['getMedia']>>) => string | undefined;
}

/**
 * Pre-flight: confirm Ollama is reachable and the requested model is installed.
 * Returns null on success, an error message string on failure.
 */
export async function preflightOllama(
  effectiveModel: string,
  ollamaUrl: string,
): Promise<string | null> {
  if (!(await isOllamaAvailable(ollamaUrl))) {
    return `Ollama is not running at ${ollamaUrl}.\n\n  Start it:       ollama serve\n  Pull a model:   ollama pull ${effectiveModel}\n\n  Setup guide:    https://localpress.griffen.codes/docs/ollama-setup`;
  }

  try {
    const installed = await listOllamaModels(ollamaUrl);
    const installedNames = installed.map((m) => m.name);
    const hasMatch = installedNames.some(
      (n) =>
        n === effectiveModel ||
        n === `${effectiveModel}:latest` ||
        n.startsWith(`${effectiveModel}:`),
    );

    if (!hasMatch) {
      const visionModels = installedNames.filter((n) =>
        /moondream|llava|bakllava|llama.*vision|qwen.*vl|minicpm|phi.*vision/i.test(n),
      );

      const visionList =
        visionModels.length > 0
          ? `\n\n  Your locally-available vision models:\n    ${visionModels.join('\n    ')}`
          : '\n\n  No vision models installed locally.';

      const remediation =
        visionModels.length > 0
          ? `  Or use one you already have:\n    --model ${visionModels[0]}\n\n  Or set the project default:\n    localpress config set defaults.captionModel ${visionModels[0]}\n`
          : '  Recommended starter model:\n    ollama pull moondream\n';

      return `Ollama model '${effectiveModel}' is not available on ${ollamaUrl}.${visionList}\n\n  Pull the requested model:\n    ollama pull ${effectiveModel}\n\n${remediation}`;
    }
  } catch {
    // Pre-flight call itself failed — don't block the run on a flaky check.
  }
  return null;
}

/**
 * Run a vision-AI bulk operation against a list of attachment IDs.
 * The caller has already done CLI parsing, config resolution, model resolution,
 * and pre-flight checks. This function focuses on the per-item loop.
 */
export async function runBulkVision(args: {
  ids: number[];
  isDryRun: boolean;
  effectiveModel: string;
  fallbackModel?: string;
  ollamaUrl: string;
  language?: string;
  getAdapter: WpBackend;
  metaAdapter: WpBackend;
  db: SiteDb;
  siteName: string;
  siteUrl: string;
  configDir: string;
  historyEnabled: boolean;
  historyMaxSizeBytes: number;
  options: BulkRunOptions;
  /** Progress hooks; per-command logging happens in the caller. */
  onItemStart: (item: Awaited<ReturnType<WpBackend['getMedia']>>) => void;
  onItemSuccess: (
    item: Awaited<ReturnType<WpBackend['getMedia']>>,
    generated: string,
    durationMs: number,
  ) => void;
  onItemSkip: (item: Awaited<ReturnType<WpBackend['getMedia']>>, reason: string) => void;
  onItemError: (id: number, message: string) => void;
}): Promise<BulkRunResult> {
  const store = openSnapshotStore(args.db, args.configDir);
  const session =
    args.historyEnabled && !args.isDryRun
      ? openHistorySession(store, args.siteName, args.options.operation, {
          model: args.effectiveModel,
          language: args.language,
          kind: args.options.kind,
        })
      : null;

  const results: BulkRunItemResult[] = [];
  let failures = 0;

  for (const id of args.ids) {
    const startTime = Date.now();
    try {
      const item = await args.getAdapter.getMedia(id);

      // Always upsert first — keeps the FK for recordProcessing happy in the
      // catch path. (Pattern from caption/remove-bg.)
      args.db.upsertAttachment({
        siteName: args.siteName,
        wpId: item.id,
        sourceUrl: item.url,
        sourceHash: null,
        sizeBytes: item.sizeBytes ?? null,
        width: item.width ?? null,
        height: item.height ?? null,
        mimeType: item.mimeType,
        lastSeenAt: Date.now(),
      });

      // Allow caller-specific skip checks (e.g. "not an image").
      const skipReason = args.options.preflightSkip?.(item);
      if (skipReason) {
        args.onItemSkip(item, skipReason);
        continue;
      }

      // Idempotent skip: target field already has a value and --overwrite not set.
      const previous = args.options.readPrevious(item);
      if (previous?.trim() && !args.options.overwrite) {
        args.onItemSkip(item, 'already has a value (pass --overwrite to replace)');
        results.push({
          id,
          filename: item.filename,
          generated: previous,
          previous,
          skipped: true,
          durationMs: 0,
        });
        continue;
      }

      args.onItemStart(item);

      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`Failed to download image: ${response.status}`);
      const imageBuffer = Buffer.from(await response.arrayBuffer());

      const result = await generateCaptionWithFallback(imageBuffer, {
        kind: args.options.kind,
        model: args.effectiveModel,
        fallbackModel: args.fallbackModel,
        ollamaUrl: args.ollamaUrl,
        language: args.language,
      });

      if (!args.isDryRun) {
        // Capture metadata-only snapshot before mutation.
        if (session) {
          captureSnapshot(store, {
            siteName: args.siteName,
            sessionId: session.id,
            attachmentId: item.id,
            operation: args.options.operation,
            sourceBytes: null,
            beforeMeta: {
              filename: item.filename,
              mimeType: item.mimeType,
              altText: item.altText,
              title: item.title,
              caption: item.caption,
              description: item.description,
            },
          });
        }

        await args.metaAdapter.updateMetadata(item.id, args.options.buildUpdate(result.caption));

        try {
          args.db.recordProcessing({
            siteName: args.siteName,
            wpId: item.id,
            operation: args.options.operation,
            paramsJson: JSON.stringify({
              model: args.effectiveModel,
              kind: args.options.kind,
            }),
            sourceHash: null,
            resultHash: null,
            bytesBefore: null,
            bytesAfter: null,
            resultWpId: null,
            ranAt: Date.now(),
            durationMs: result.durationMs,
            status: 'success',
            errorMessage: null,
          });
        } catch {
          // Best-effort breadcrumb.
        }
      }

      args.onItemSuccess(item, result.caption, result.durationMs);

      results.push({
        id,
        filename: item.filename,
        generated: result.caption,
        previous,
        skipped: false,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.onItemError(id, message);
      failures++;

      try {
        args.db.recordProcessing({
          siteName: args.siteName,
          wpId: id,
          operation: args.options.operation,
          paramsJson: JSON.stringify({ model: args.effectiveModel, kind: args.options.kind }),
          sourceHash: null,
          resultHash: null,
          bytesBefore: null,
          bytesAfter: null,
          resultWpId: null,
          ranAt: Date.now(),
          durationMs: Date.now() - startTime,
          status: 'failure',
          errorMessage: message,
        });
      } catch {
        // Lose the breadcrumb rather than abort the loop.
      }
    }
  }

  if (session) {
    closeHistorySession(store, session, { maxSizeBytes: args.historyMaxSizeBytes });
  }

  const processed = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;

  return { processed, skipped, failures, results };
}
