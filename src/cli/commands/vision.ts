/**
 * `localpress vision <ids>` — generate all AI metadata fields in one pass.
 *
 * Companion to the individual `caption` / `title` / `describe` / `tag` /
 * `classify` commands. Runs them all (or a chosen subset via `--fields`)
 * for each attachment and either prints the result for inspection or, with
 * `--apply`, writes everything back to WordPress.
 *
 * Default behavior is print-only — generating a wall of unsupervised AI
 * metadata against the live site is exactly the kind of bulk op that
 * needs a deliberate `--apply`. Single-attachment runs against the active
 * site without --apply still print the proposed fields for review.
 *
 * The cost is N Ollama calls per image (one per field), so this is
 * primarily a per-item workflow, not a bulk-the-whole-library workflow —
 * use the dedicated commands for that.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { UpdateMetadata } from '../../adapters/types.ts';
import {
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OLLAMA_URL,
  cleanTagsArray,
  generateCaption,
} from '../../engine/caption/ollama.ts';
import { preflightOllama } from '../../engine/caption/run-bulk.ts';
import type { VisionKind } from '../../engine/caption/types.ts';
import {
  captureSnapshot,
  closeHistorySession,
  openHistorySession,
  openSnapshotStore,
  resolveHistoryConfig,
} from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

type Field = 'alt' | 'title' | 'description' | 'tags' | 'classify';
const ALL_FIELDS: readonly Field[] = ['alt', 'title', 'description', 'tags', 'classify'] as const;

interface VisionItemResult {
  id: number;
  filename: string;
  alt?: string;
  title?: string;
  description?: string;
  tags?: string[];
  classify?: string;
  durationMs: number;
  applied: boolean;
}

export function registerVisionCommand(program: Command): void {
  program
    .command('vision <ids...>')
    .description(
      'Generate all AI metadata fields (alt, title, description, tags, classify) for one or more attachments in a single pass. Prints proposals by default; pass --apply to write to WordPress.',
    )
    .option(
      '--fields <list>',
      "comma-separated subset of fields (default: alt,title,description,tags,classify). Use 'none' to skip writes and only return classifications, etc.",
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
    .option('--language <lang>', 'generate text in this language')
    .option('--overwrite', 'replace existing field values (default: keep)')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      const ids = idStrs.map((s) => Number.parseInt(s, 10));
      if (ids.some(Number.isNaN)) {
        error('All arguments must be valid attachment IDs (integers).');
        process.exit(2);
      }

      const fields: Field[] = options.fields
        ? options.fields
            .split(',')
            .map((s: string) => s.trim().toLowerCase())
            .filter((f: string): f is Field => (ALL_FIELDS as readonly string[]).includes(f))
        : [...ALL_FIELDS];

      if (fields.length === 0) {
        error(`--fields must be a comma-separated subset of: ${ALL_FIELDS.join(', ')}`);
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const getAdapter = resolver.resolve('get');
      const metaAdapter = resolver.resolve('update-meta');

      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      const preflightError = await preflightOllama(effectiveModel, options.ollamaUrl);
      if (preflightError) {
        error(preflightError);
        process.exit(2);
      }

      const apply = Boolean(parentOpts.apply);
      if (!apply) {
        info(
          '  Print-only mode. Re-run with --apply to write the generated fields back to WordPress.',
        );
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const historyConfig = resolveHistoryConfig(config.history);
      const snapshotStore = openSnapshotStore(db, getConfigDir());
      const session =
        historyConfig.enabled && apply
          ? openHistorySession(snapshotStore, site.name, 'vision', {
              fields,
              model: effectiveModel,
            })
          : null;

      const results: VisionItemResult[] = [];
      let failures = 0;

      for (const id of ids) {
        const startTime = Date.now();
        try {
          info(`  Processing #${id}…`);
          const item = await getAdapter.getMedia(id);

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

          if (!item.mimeType.startsWith('image/')) {
            info('    ↳ not an image, skipping');
            continue;
          }

          const response = await fetch(item.url);
          if (!response.ok) throw new Error(`Failed to download: ${response.status}`);
          const buf = Buffer.from(await response.arrayBuffer());

          const out: VisionItemResult = {
            id,
            filename: item.filename,
            durationMs: 0,
            applied: false,
          };

          // Run each requested kind in sequence (could be parallel later).
          for (const f of fields) {
            const kind: VisionKind = f === 'classify' ? 'classify' : (f as VisionKind);
            const r = await generateCaption(buf, {
              kind,
              model: effectiveModel,
              ollamaUrl: options.ollamaUrl,
              language: options.language,
            });
            if (f === 'tags') {
              out.tags = cleanTagsArray(r.caption);
              info(`    ✓ tags:        [${out.tags.join(', ')}]`);
            } else if (f === 'alt') {
              out.alt = r.caption;
              info(`    ✓ alt:         ${truncate(r.caption)}`);
            } else if (f === 'title') {
              out.title = r.caption;
              info(`    ✓ title:       ${r.caption}`);
            } else if (f === 'description') {
              out.description = r.caption;
              info(`    ✓ description: ${truncate(r.caption)}`);
            } else if (f === 'classify') {
              out.classify = r.caption;
              info(`    ✓ classify:    ${r.caption}`);
            }
          }

          out.durationMs = Date.now() - startTime;

          if (apply) {
            if (session) {
              captureSnapshot(snapshotStore, {
                siteName: site.name,
                sessionId: session.id,
                attachmentId: item.id,
                operation: 'vision',
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

            const update: UpdateMetadata = {};
            if (out.alt !== undefined && (options.overwrite || !item.altText?.trim())) {
              update.altText = out.alt;
            }
            if (out.title !== undefined && (options.overwrite || isAutoTitle(item.title))) {
              update.title = out.title;
            }
            if (out.description !== undefined && (options.overwrite || !item.description?.trim())) {
              update.description = out.description;
            }
            // Tags are written as a caption block (matching the `tag` command).
            if (out.tags && out.tags.length > 0) {
              const existingCaption = item.caption ?? '';
              const block = `[tags: ${out.tags.join(', ')}]`;
              const TAG_RE = /\[tags:\s*([^\]]*)\]/i;
              const hadBlock = TAG_RE.test(existingCaption);
              if (!hadBlock || options.overwrite) {
                update.caption = hadBlock
                  ? existingCaption.replace(TAG_RE, block).trim()
                  : existingCaption
                    ? `${existingCaption.trim()} ${block}`
                    : block;
              }
            }

            if (Object.keys(update).length > 0) {
              await metaAdapter.updateMetadata(item.id, update);
              out.applied = true;
              info(`    ✓ wrote ${Object.keys(update).join(', ')} to WordPress`);

              // Cache classification in processing_history so optimize picks it up.
              if (out.classify) {
                try {
                  db.recordProcessing({
                    siteName: site.name,
                    wpId: item.id,
                    operation: 'classify',
                    paramsJson: JSON.stringify({
                      model: effectiveModel,
                      classification: out.classify,
                    }),
                    sourceHash: null,
                    resultHash: null,
                    bytesBefore: null,
                    bytesAfter: null,
                    resultWpId: null,
                    ranAt: Date.now(),
                    durationMs: 0,
                    status: 'success',
                    errorMessage: null,
                  });
                } catch {
                  // Best-effort.
                }
              }
            } else {
              info('    — nothing to write (all fields already populated; use --overwrite)');
            }
          }

          results.push(out);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          error(`    ✗ #${id}: ${message}`);
          failures++;
        }
      }

      if (session) {
        closeHistorySession(snapshotStore, session, {
          maxSizeBytes: historyConfig.maxSizeBytes,
        });
      }

      db.close();

      if (parentOpts.json) {
        printJson({
          applied: apply,
          fields,
          processed: results.length,
          failures,
          results,
        });
      } else if (results.length > 0 || failures > 0) {
        info(
          `\n  Done: ${results.length} processed, ${failures} failed${apply ? '' : ' (print-only — re-run with --apply to write)'}.`,
        );
      }

      if (failures > 0) process.exit(1);
    });
}

function truncate(s: string, max = 120): string {
  return s.length <= max ? s : `${s.slice(0, max).trim()}…`;
}

function isAutoTitle(t: string | undefined): boolean {
  if (!t) return true;
  const s = t.trim();
  if (s.length === 0) return true;
  return (
    /^screenshot[\s_-]/i.test(s) ||
    /^image[\s_-]?\d+/i.test(s) ||
    /^img[\s_-]?\d+/i.test(s) ||
    /^dsc[\s_-]?\d+/i.test(s) ||
    /^untitled/i.test(s) ||
    /^\d+$/.test(s) ||
    /^[a-f0-9]{8,}$/i.test(s)
  );
}
