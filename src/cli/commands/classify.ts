/**
 * `localpress classify <ids>` — detect image type via Ollama vision.
 *
 * Returns one of: screenshot | photo | illustration | diagram. Writes
 * nothing to WordPress by default — use `--json` to capture the result
 * for downstream use, or `--apply-tag` to write the classification as a
 * comma-separated entry in the WP description field (lightweight tagging
 * without requiring taxonomies to be registered for attachments).
 *
 * `optimize` reads this classification (when present in the local DB) to
 * pick smarter format defaults: screenshots default to PNG, photos to WebP.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  generateCaption,
} from '../../engine/caption/ollama.ts';
import { preflightOllama } from '../../engine/caption/run-bulk.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export type ImageClass = 'screenshot' | 'photo' | 'illustration' | 'diagram' | 'unknown';

interface ClassifyResult {
  id: number;
  filename: string;
  classification: ImageClass;
  durationMs: number;
}

export function registerClassifyCommand(program: Command): void {
  program
    .command('classify <ids...>')
    .description(
      'Detect image type (screenshot | photo | illustration | diagram) via Ollama vision. Caches the result locally so `optimize` can pick smarter format defaults.',
    )
    .option(
      '--model <name>',
      `Ollama vision model. Resolution: --model > config.defaults.captionModel > ${DEFAULT_OLLAMA_MODEL}`,
    )
    .option(
      '--ollama-url <url>',
      `Ollama base URL (default: ${DEFAULT_OLLAMA_URL})`,
      DEFAULT_OLLAMA_URL,
    )
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();
      const ids = idStrs.map((s) => Number.parseInt(s, 10));
      if (ids.some(Number.isNaN)) {
        error('All arguments must be valid attachment IDs (integers).');
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');

      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      const preflightError = await preflightOllama(effectiveModel, options.ollamaUrl);
      if (preflightError) {
        error(preflightError);
        process.exit(2);
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const results: ClassifyResult[] = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          const item = await getAdapter.getMedia(id);
          info(`  Classifying #${id} (${item.filename})…`);

          db.upsertAttachment({
            siteName: site.name,
            wpId: item.id,
            sourceUrl: item.url,
            sourceHash: null,
            sizeBytes: item.sizeBytes ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
            mimeType: item.mimeType,
            lastSeenAt: Date.now(),
          });

          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const buf = Buffer.from(await response.arrayBuffer());

          const result = await generateCaption(buf, {
            kind: 'classify',
            model: effectiveModel,
            ollamaUrl: options.ollamaUrl,
          });

          const classification = result.caption as ImageClass;
          const durationMs = Date.now() - startTime;

          // Cache the classification in processing_history so optimize can pick
          // it up later. Storing as a JSON params blob keeps the schema small.
          try {
            db.recordProcessing({
              siteName: site.name,
              wpId: item.id,
              operation: 'classify',
              paramsJson: JSON.stringify({
                model: effectiveModel,
                classification,
              }),
              sourceHash: null,
              resultHash: null,
              bytesBefore: null,
              bytesAfter: null,
              resultWpId: null,
              ranAt: Date.now(),
              durationMs,
              status: 'success',
              errorMessage: null,
            });
          } catch {
            // Best-effort breadcrumb.
          }

          info(`    ✓ ${classification} (${durationMs}ms)`);
          results.push({ id, filename: item.filename, classification, durationMs });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;
        }
      }

      db.close();

      if (parentOpts.json) {
        printJson({ classified: results.length, failures, results });
      } else if (results.length > 0 || failures > 0) {
        info(`\n  Done: ${results.length} classified, ${failures} failed.`);
      }

      if (failures > 0) process.exit(1);
    });
}

/**
 * Look up a cached classification for an attachment, if `classify` has been
 * run on it. Returns undefined if no cache hit. Used by `optimize` to pick
 * a smarter default format.
 */
export function getCachedClassification(
  db: SiteDb,
  siteName: string,
  wpId: number,
): ImageClass | undefined {
  const row = db.getLastProcessing(siteName, wpId, 'classify');
  if (!row || row.status !== 'success' || !row.paramsJson) return undefined;
  try {
    const parsed = JSON.parse(row.paramsJson) as { classification?: ImageClass };
    return parsed.classification;
  } catch {
    return undefined;
  }
}
