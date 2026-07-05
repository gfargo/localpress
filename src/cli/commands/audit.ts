/**
 * `localpress audit` — find optimization opportunities across the library.
 *
 * REST checks:
 *   - --unoptimized: images not yet processed by localpress
 *   - --large: images larger than --threshold
 *   - --missing-alt: images without alt text
 *   - --display-size: images significantly larger than their largest registered WP size
 *   - --duplicates: perceptual duplicates (pHash via sharp)
 *   - --broken-refs: attachment URLs referenced in content that 404
 *
 * WP-CLI checks:
 *   - --orphans: uploads-dir files with no DB record
 *   - --unattached: full reference scan for truly unattached media
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { MediaItem } from '../../adapters/types.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

const DEFAULT_THRESHOLD = 1024 * 1024; // 1 MB
/** Flag an image as oversized if it's this many times larger than its largest WP size. */
const DISPLAY_SIZE_RATIO = 2.0;

interface AuditFinding {
  type:
    | 'unoptimized'
    | 'large'
    | 'unattached'
    | 'missing-alt'
    | 'orphan'
    | 'missing-file'
    | 'display-size'
    | 'duplicate'
    | 'broken-ref'
    | 'quality'
    | 'ocr-match';
  attachmentId: number;
  filename: string;
  detail: string;
  /** For display-size: the largest registered WP size dimensions. */
  largestSize?: { width: number; height: number; name: string };
  /** For duplicates: the other attachment IDs in the group. */
  duplicateOf?: number[];
  /** For broken-refs: the post IDs where the broken URL was found. */
  referencedIn?: number[];
}

export function registerAuditCommand(program: Command): void {
  program
    .command('audit')
    .description('Find optimization opportunities across the media library')
    .option('--unoptimized', 'flag images that have never been processed')
    .option('--large', 'flag images larger than --threshold (default 1MB)')
    .option('--threshold <bytes>', 'size threshold for --large in bytes (default 1048576)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--unattached', 'flag attachments not associated with any post')
    .option('--missing-alt', 'flag images without alt text')
    .option('--orphans', 'flag uploads-dir files with no DB record (requires WP-CLI)')
    .option(
      '--display-size',
      'flag images significantly larger than their largest registered WP thumbnail size',
    )
    .option('--duplicates', 'flag perceptually identical or near-identical images (requires sharp)')
    .option('--broken-refs', 'flag attachment URLs referenced in post content that return 404')
    .option(
      '--quality',
      'flag blurry / low-contrast / poorly-composed images via Ollama vision (slow; ~10s per image)',
    )
    .option(
      '--ocr-text <term>',
      'flag images that visually contain the supplied text (case-insensitive, via Ollama vision; slow)',
    )
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const adapter = resolver.resolve('list');

      // If no specific check is requested, run all REST-based checks.
      const runAll =
        !options.unoptimized &&
        !options.large &&
        !options.unattached &&
        !options.missingAlt &&
        !options.orphans &&
        !options.displaySize &&
        !options.duplicates &&
        !options.brokenRefs &&
        !options.quality &&
        !options.ocrText;
      // Note: --quality and --ocrText are NOT included in runAll behavior —
      // they require Ollama and are slow (~10s/image). They must be opted into
      // explicitly.

      const findings: AuditFinding[] = [];
      const threshold = options.threshold ?? DEFAULT_THRESHOLD;

      // -- Orphan scan (WP-CLI only) ------------------------------------------
      if (options.orphans) {
        const pruneAdapter = resolver.tryResolve('prune-orphans');
        if (!pruneAdapter) {
          error('--orphans requires WP-CLI over SSH. Configure SSH access for this site.');
          process.exit(6);
        }

        info('Scanning for orphan files via WP-CLI...');
        try {
          const pruneResult = await pruneAdapter.pruneOrphans();
          for (const f of pruneResult.orphanFiles) {
            findings.push({
              type: 'orphan',
              attachmentId: 0,
              filename: f,
              detail: 'File on disk with no matching attachment in the database',
            });
          }
          for (const id of pruneResult.missingFiles) {
            findings.push({
              type: 'missing-file',
              attachmentId: id,
              filename: '(missing)',
              detail: 'Attachment registered in DB but file is missing from disk',
            });
          }
          if (pruneResult.reclaimableBytes > 0) {
            info(
              `  Found ${pruneResult.orphanFiles.length} orphan file(s), ${formatBytes(pruneResult.reclaimableBytes)} reclaimable.`,
            );
          }
        } catch (err) {
          warn(`Orphan scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // -- Fetch all media items -----------------------------------------------
      const scanStartedAt = Date.now();
      let allItems: MediaItem[] = [];
      let page = 1;
      while (true) {
        try {
          const batch = await adapter.listMedia({ perPage: 100, page });
          if (batch.length === 0) break;
          allItems = allItems.concat(batch);
          if (batch.length < 100) break;
          page++;
        } catch (err) {
          error(err instanceof Error ? err.message : String(err));
          process.exit(4);
          return;
        }
      }

      if (allItems.length === 0 && findings.length === 0) {
        info('No media items found in the library.');
        return;
      }

      // Sync the DB's attachment cache to what this full fetch just saw, then
      // prune rows for attachments that no longer exist remotely — otherwise
      // `stats`' getLibraryOverview() keeps counting deleted attachments forever.
      // Also load processed IDs for the --unoptimized check.
      let processedIds = new Set<number>();
      let prunedCount = 0;
      try {
        const db = SiteDb.init(getSiteDbPath(site.name));
        db.ensureSite(site.name, site.url);
        for (const item of allItems) {
          db.upsertAttachment({
            siteName: site.name,
            wpId: item.id,
            sourceUrl: item.url,
            sourceHash: null,
            sizeBytes: item.sizeBytes ?? null,
            width: item.width ?? null,
            height: item.height ?? null,
            mimeType: item.mimeType,
            lastSeenAt: scanStartedAt,
          });
        }
        prunedCount = db.pruneStaleAttachments(site.name, scanStartedAt);
        if (runAll || options.unoptimized) {
          processedIds = db.listProcessedWpIds(site.name);
        }
        db.close();
      } catch (err) {
        warn(
          `Failed to sync attachment records: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (prunedCount > 0) {
        info(`Pruned ${prunedCount} attachment record(s) no longer present remotely.`);
      }

      for (const item of allItems) {
        // --unoptimized
        if ((runAll || options.unoptimized) && !processedIds.has(item.id)) {
          findings.push({
            type: 'unoptimized',
            attachmentId: item.id,
            filename: item.filename,
            detail: 'Not yet processed by localpress',
          });
        }

        // --large
        if ((runAll || options.large) && item.sizeBytes && item.sizeBytes >= threshold) {
          findings.push({
            type: 'large',
            attachmentId: item.id,
            filename: item.filename,
            detail: `${formatBytes(item.sizeBytes)} (threshold: ${formatBytes(threshold)})`,
          });
        }

        // --missing-alt
        if ((runAll || options.missingAlt) && (!item.altText || item.altText.trim() === '')) {
          findings.push({
            type: 'missing-alt',
            attachmentId: item.id,
            filename: item.filename,
            detail: 'No alt text set',
          });
        }

        // --display-size: compare source dimensions against largest registered WP size
        if ((runAll || options.displaySize) && item.width && item.height && item.sizes) {
          const largestSize = findLargestRegisteredSize(item.sizes);
          if (largestSize) {
            const sourcePixels = item.width * item.height;
            const displayPixels = largestSize.width * largestSize.height;
            if (displayPixels > 0 && sourcePixels / displayPixels >= DISPLAY_SIZE_RATIO) {
              const ratio = (sourcePixels / displayPixels).toFixed(1);
              findings.push({
                type: 'display-size',
                attachmentId: item.id,
                filename: item.filename,
                detail:
                  `Source is ${item.width}×${item.height} but largest registered size is ` +
                  `${largestSize.width}×${largestSize.height} (${largestSize.name}) — ` +
                  `${ratio}× oversized`,
                largestSize: {
                  width: largestSize.width,
                  height: largestSize.height,
                  name: largestSize.name,
                },
              });
            }
          }
        }
      }

      // -- Duplicate detection (pHash via sharp) --------------------------------
      if (options.duplicates || runAll) {
        const dupeFindings = await detectDuplicates(allItems);
        findings.push(...dupeFindings);
      }

      // -- Broken reference detection ------------------------------------------
      if (options.brokenRefs) {
        info('Checking for broken attachment references in post content...');
        const brokenFindings = await detectBrokenRefs(allItems, site.url);
        findings.push(...brokenFindings);
      }

      // -- Vision: quality check (slow, per-item Ollama call) ------------------
      if (options.quality) {
        const images = allItems.filter((m) => m.mimeType.startsWith('image/'));
        info(`Vision quality check on ${images.length} image(s) — slow (~10s/image)...`);
        const effectiveModel: string = config.defaults?.captionModel ?? 'moondream';
        const qualityFindings = await detectQualityIssues(images, effectiveModel);
        findings.push(...qualityFindings);
      }

      // -- Vision: OCR text search (slow, per-item Ollama call) ----------------
      if (options.ocrText) {
        const images = allItems.filter((m) => m.mimeType.startsWith('image/'));
        info(`Vision OCR search for "${options.ocrText}" on ${images.length} image(s) — slow...`);
        const effectiveModel: string = config.defaults?.captionModel ?? 'moondream';
        const ocrFindings = await detectOcrMatches(images, options.ocrText, effectiveModel);
        findings.push(...ocrFindings);
      }

      // -- Output --------------------------------------------------------------
      if (parentOpts.json) {
        printJson({
          site: site.name,
          totalItems: allItems.length,
          prunedAttachments: prunedCount,
          findings,
          summary: {
            unoptimized: findings.filter((f) => f.type === 'unoptimized').length,
            large: findings.filter((f) => f.type === 'large').length,
            missingAlt: findings.filter((f) => f.type === 'missing-alt').length,
            displaySize: findings.filter((f) => f.type === 'display-size').length,
            duplicates: findings.filter((f) => f.type === 'duplicate').length,
            brokenRefs: findings.filter((f) => f.type === 'broken-ref').length,
            orphan: findings.filter((f) => f.type === 'orphan').length,
            missingFile: findings.filter((f) => f.type === 'missing-file').length,
            quality: findings.filter((f) => f.type === 'quality').length,
            ocrMatch: findings.filter((f) => f.type === 'ocr-match').length,
          },
        });
      } else {
        info(`Audited ${allItems.length} item(s) on '${site.name}':\n`);

        const groups: Record<string, { label: string; items: AuditFinding[] }> = {
          unoptimized: {
            label: 'Unoptimized',
            items: findings.filter((f) => f.type === 'unoptimized'),
          },
          large: {
            label: `Large files (≥${formatBytes(threshold)})`,
            items: findings.filter((f) => f.type === 'large'),
          },
          missingAlt: {
            label: 'Missing alt text',
            items: findings.filter((f) => f.type === 'missing-alt'),
          },
          displaySize: {
            label: 'Oversized for display context',
            items: findings.filter((f) => f.type === 'display-size'),
          },
          duplicates: {
            label: 'Perceptual duplicates',
            items: findings.filter((f) => f.type === 'duplicate'),
          },
          brokenRefs: {
            label: 'Broken references in content',
            items: findings.filter((f) => f.type === 'broken-ref'),
          },
          orphan: {
            label: 'Orphan files (no DB record)',
            items: findings.filter((f) => f.type === 'orphan'),
          },
          missingFile: {
            label: 'Missing files (DB record, no file)',
            items: findings.filter((f) => f.type === 'missing-file'),
          },
          quality: {
            label: 'Quality issues (blurry, low-contrast, etc.)',
            items: findings.filter((f) => f.type === 'quality'),
          },
          ocrMatch: {
            label: 'OCR matches',
            items: findings.filter((f) => f.type === 'ocr-match'),
          },
        };

        for (const group of Object.values(groups)) {
          if (group.items.length === 0) continue;
          info(`  ${group.label}: ${group.items.length}`);
          for (const f of group.items.slice(0, 10)) {
            const idStr = f.attachmentId > 0 ? `#${f.attachmentId}  ` : '';
            info(`    ${idStr}${f.filename}  ${f.detail}`);
          }
          if (group.items.length > 10) {
            info(`    ... and ${group.items.length - 10} more`);
          }
          info('');
        }

        if (findings.length === 0) {
          info('  No issues found. Your media library looks good!');
        } else {
          info(`  Total findings: ${findings.length}`);
          info('  Run `localpress optimize --unoptimized --apply` to process unoptimized items.');
          if (findings.some((f) => f.type === 'display-size')) {
            info(
              '  Run `localpress resize --max-width 1920 --apply` to right-size oversized images.',
            );
          }
        }
      }
    });
}

// -- Display-size helpers -----------------------------------------------------

interface SizeEntry {
  name: string;
  width: number;
  height: number;
}

function findLargestRegisteredSize(sizes: NonNullable<MediaItem['sizes']>): SizeEntry | null {
  let largest: SizeEntry | null = null;
  for (const [name, size] of Object.entries(sizes)) {
    if (name === 'full') continue; // 'full' is the source itself
    const pixels = size.width * size.height;
    if (!largest || pixels > largest.width * largest.height) {
      largest = { name, width: size.width, height: size.height };
    }
  }
  return largest;
}

// -- Duplicate detection ------------------------------------------------------

async function detectDuplicates(items: MediaItem[]): Promise<AuditFinding[]> {
  // Only consider image items with a URL.
  const imageItems = items.filter((i) => i.mimeType.startsWith('image/') && i.url);
  if (imageItems.length < 2) return [];

  // biome-ignore lint/suspicious/noExplicitAny: sharp is lazy-loaded and may not be installed
  let sharp: any;
  try {
    const { loadSharp } = await import('../../engine/image/sharp-loader.ts');
    sharp = await loadSharp();
  } catch {
    warn('--duplicates requires sharp to be installed. Skipping duplicate detection.');
    return [];
  }

  info(`  Computing perceptual hashes for ${imageItems.length} images...`);

  // Compute a simple difference hash (dHash) for each image.
  // dHash: resize to 9×8, convert to grayscale, compare adjacent pixels.
  const hashes: Array<{ id: number; filename: string; hash: bigint }> = [];

  for (const item of imageItems) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());

      // Resize to 9×8 grayscale for dHash computation.
      const pixels = await sharp(buffer).resize(9, 8, { fit: 'fill' }).grayscale().raw().toBuffer();

      let hash = 0n;
      for (let row = 0; row < 8; row++) {
        for (let col = 0; col < 8; col++) {
          const left = pixels[row * 9 + col];
          const right = pixels[row * 9 + col + 1];
          hash = (hash << 1n) | (left < right ? 1n : 0n);
        }
      }
      hashes.push({ id: item.id, filename: item.filename, hash });
    } catch {
      // Skip items we can't fetch or process.
    }
  }

  // Find pairs with Hamming distance ≤ 5 (very similar).
  const HAMMING_THRESHOLD = 5;
  const findings: AuditFinding[] = [];
  const reported = new Set<number>();

  for (let i = 0; i < hashes.length; i++) {
    if (reported.has(hashes[i].id)) continue;
    const group: number[] = [];

    for (let j = i + 1; j < hashes.length; j++) {
      if (reported.has(hashes[j].id)) continue;
      const dist = hammingDistance(hashes[i].hash, hashes[j].hash);
      if (dist <= HAMMING_THRESHOLD) {
        group.push(hashes[j].id);
        reported.add(hashes[j].id);
      }
    }

    if (group.length > 0) {
      reported.add(hashes[i].id);
      findings.push({
        type: 'duplicate',
        attachmentId: hashes[i].id,
        filename: hashes[i].filename,
        detail: `Perceptually similar to attachment(s) #${group.join(', #')}`,
        duplicateOf: group,
      });
    }
  }

  return findings;
}

function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

// -- Broken reference detection -----------------------------------------------

async function detectBrokenRefs(items: MediaItem[], _siteUrl: string): Promise<AuditFinding[]> {
  // Build a set of known attachment URLs for fast lookup.
  const knownUrls = new Set(items.map((i) => i.url));
  const findings: AuditFinding[] = [];

  // Check each attachment URL with a HEAD request.
  // We're looking for attachments that are registered in WP but whose
  // underlying file returns a non-200 response.
  const CONCURRENCY = 10;
  const chunks = chunkArray(items, CONCURRENCY);

  for (const chunk of chunks) {
    await Promise.all(
      chunk.map(async (item) => {
        if (!knownUrls.has(item.url)) return;
        try {
          const response = await fetch(item.url, { method: 'HEAD' });
          if (response.status === 404 || response.status === 410) {
            findings.push({
              type: 'broken-ref',
              attachmentId: item.id,
              filename: item.filename,
              detail: `URL returns HTTP ${response.status}: ${item.url}`,
            });
          }
        } catch {
          findings.push({
            type: 'broken-ref',
            attachmentId: item.id,
            filename: item.filename,
            detail: `URL unreachable: ${item.url}`,
          });
        }
      }),
    );
  }

  return findings;
}

// -- Vision audits -----------------------------------------------------------

async function detectQualityIssues(images: MediaItem[], model: string): Promise<AuditFinding[]> {
  const { generateCaption, isOllamaAvailable } = await import('../../engine/caption/ollama.ts');
  if (!(await isOllamaAvailable())) {
    warn('Ollama is not running — skipping --quality check.');
    return [];
  }

  const findings: AuditFinding[] = [];
  for (const item of images) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const buf = Buffer.from(await response.arrayBuffer());

      // Ask the model for a yes/no quality assessment with a one-line reason.
      const result = await generateCaption(buf, {
        kind: 'alt', // reuse alt pipeline for clean post-processing
        model,
        prompt:
          'Is this image significantly blurry, low-contrast, badly exposed, or poorly composed? ' +
          'Answer with exactly one word: "YES" or "NO" followed by a brief reason. ' +
          'Example: "NO sharp and well-lit" or "YES motion blur on subject". Be strict — only flag clearly problematic images.',
      });

      const text = result.caption.trim();
      if (/^yes\b/i.test(text)) {
        findings.push({
          type: 'quality',
          attachmentId: item.id,
          filename: item.filename,
          detail: text.replace(/^yes[,:\s]*/i, '').trim() || 'flagged by quality check',
        });
      }
    } catch {
      // Skip items we can't fetch or process.
    }
  }
  return findings;
}

async function detectOcrMatches(
  images: MediaItem[],
  searchTerm: string,
  model: string,
): Promise<AuditFinding[]> {
  const { generateCaption, isOllamaAvailable } = await import('../../engine/caption/ollama.ts');
  if (!(await isOllamaAvailable())) {
    warn('Ollama is not running — skipping --ocr-text check.');
    return [];
  }

  const findings: AuditFinding[] = [];
  const safeTerm = JSON.stringify(searchTerm); // safely embed in prompt

  for (const item of images) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) continue;
      const buf = Buffer.from(await response.arrayBuffer());

      const result = await generateCaption(buf, {
        kind: 'alt',
        model,
        prompt: `Does this image visually contain the text ${safeTerm} (case-insensitive, partial match OK)? Answer with exactly one word: "YES" or "NO" followed by a brief note about what text is visible. Example: "NO no text visible" or "YES title bar reads exactly that". Be strict — only say YES if the text actually appears.`,
      });

      const text = result.caption.trim();
      if (/^yes\b/i.test(text)) {
        findings.push({
          type: 'ocr-match',
          attachmentId: item.id,
          filename: item.filename,
          detail: text.replace(/^yes[,:\s]*/i, '').trim() || `contains "${searchTerm}"`,
        });
      }
    } catch {
      // Skip items we can't fetch or process.
    }
  }
  return findings;
}

// -- Utilities ----------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
