/**
 * `localpress describe [ids...]` — AI-generated longer description.
 *
 * Companion to `caption` (alt text) and `title`. Writes a 2-3 sentence
 * description to the attachment's WP description field — useful for
 * image galleries, attachment pages, and SEO.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { WpBackend } from '../../adapters/types.ts';
import { DEFAULT_OLLAMA_MODEL, DEFAULT_OLLAMA_URL } from '../../engine/caption/ollama.ts';
import { preflightOllama, runBulkVision } from '../../engine/caption/run-bulk.ts';
import { resolveHistoryConfig } from '../../engine/history/index.ts';
import { SiteDb } from '../../engine/state/db.ts';
import { getConfigDir, getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

export function registerDescribeCommand(program: Command): void {
  program
    .command('describe [ids...]')
    .description(
      "AI-generated 2-3 sentence description written to the attachment's WP description field.",
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
    .option('--all', 'process all image attachments (dry-run unless --apply)')
    .option('--missing-description', 'only items currently lacking a description')
    .option('--language <lang>', 'generate in this language (e.g. "Spanish")')
    .option('--overwrite', 'replace existing descriptions')
    .action(async (idStrs: string[], options) => {
      const parentOpts = program.opts();

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);
      const listAdapter = resolver.resolve('list');
      const getAdapter = resolver.resolve('get');
      const metaAdapter = resolver.resolve('update-meta');

      const effectiveModel: string =
        options.model ?? config.defaults?.captionModel ?? DEFAULT_OLLAMA_MODEL;

      const preflightError = await preflightOllama(effectiveModel, options.ollamaUrl);
      if (preflightError) {
        error(preflightError);
        process.exit(2);
      }

      const isBulk = !idStrs.length && (options.missingDescription || options.all);
      const isDryRun = resolveDryRun(parentOpts, isBulk);

      if (!idStrs.length && !isBulk) {
        error(
          'Specify attachment IDs, --missing-description, or --all.\n' +
            '  localpress describe 123 124\n' +
            '  localpress describe --missing-description --apply',
        );
        process.exit(2);
      }

      let ids: number[];
      if (idStrs.length > 0) {
        ids = idStrs.map((s) => Number.parseInt(s, 10));
        if (ids.some(Number.isNaN)) {
          error('All arguments must be valid attachment IDs (integers).');
          process.exit(2);
        }
      } else {
        info('  Fetching image attachments…');
        const all = await fetchAllImages(listAdapter);
        ids = options.missingDescription
          ? all.filter((m) => !m.description?.trim()).map((m) => m.id)
          : all.map((m) => m.id);
        info(`  Found ${ids.length} target attachment(s).`);
      }

      if (ids.length === 0) {
        info('  Nothing to do.');
        return;
      }

      if (isBulk && isDryRun) {
        info('  Dry-run: pass --apply to write descriptions to WordPress.\n');
      }

      const db = SiteDb.init(getSiteDbPath(site.name));
      db.ensureSite(site.name, site.url);

      const historyConfig = resolveHistoryConfig(config.history);

      const result = await runBulkVision({
        ids,
        isDryRun,
        effectiveModel,
        ollamaUrl: options.ollamaUrl,
        language: options.language,
        getAdapter,
        metaAdapter,
        db,
        siteName: site.name,
        siteUrl: site.url,
        configDir: getConfigDir(),
        historyEnabled: historyConfig.enabled,
        historyMaxSizeBytes: historyConfig.maxSizeBytes ?? 0,
        options: {
          kind: 'description',
          operation: 'describe',
          buildUpdate: (generated) => ({ description: generated }),
          readPrevious: (item) => item.description,
          overwrite: options.overwrite ?? false,
          preflightSkip: (item) =>
            item.mimeType.startsWith('image/') ? undefined : 'not an image',
        },
        onItemStart: (item) => info(`  Describing #${item.id} (${item.filename})…`),
        onItemSuccess: (_item, generated, durationMs) =>
          info(`    ✓ ${truncateForLog(generated)} (${durationMs}ms)`),
        onItemSkip: (item, reason) => info(`  — #${item.id} (${item.filename}) — ${reason}`),
        onItemError: (id, message) => error(`    ✗ #${id}: ${message}`),
      });

      db.close();

      if (parentOpts.json) {
        printJson({
          dryRun: isDryRun,
          ...result,
        });
        return;
      }

      const dryNote = isDryRun ? ' (dry run — WordPress not updated)' : '';
      if (result.processed + result.skipped > 0 || result.failures > 0) {
        info(
          `\n  Done: ${result.processed} described, ${result.skipped} skipped, ${result.failures} failed${dryNote}.`,
        );
      }

      if (result.failures > 0) process.exit(1);
    });
}

function truncateForLog(s: string, max = 100): string {
  if (s.length <= max) return `"${s}"`;
  return `"${s.slice(0, max).trim()}…"`;
}

async function fetchAllImages(
  adapter: WpBackend,
): Promise<Array<{ id: number; description: string | undefined }>> {
  const out: Array<{ id: number; description: string | undefined }> = [];
  let page = 1;
  while (true) {
    try {
      const result = await adapter.listMediaPage({ type: 'image/', perPage: 100, page });
      out.push(...result.items.map((i) => ({ id: i.id, description: i.description })));
      if (page >= result.totalPages) break;
      page++;
    } catch (err) {
      warn(`  Pagination stopped: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }
  return out;
}
