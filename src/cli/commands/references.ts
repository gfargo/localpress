/**
 * `localpress references <id>` — show every place attachment <id> is used.
 *
 * v0.1 fast scan (REST):
 *   - featured images
 *   - Gutenberg block IDs
 *
 * v0.5 full scan (WP-CLI):
 *   - inline content URLs and srcset
 *   - custom field meta values
 *   - --update-to <new-id> for safe rewriting
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ReferenceScope } from '../../adapters/types.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerReferencesCommand(program: Command): void {
  program
    .command('references <id>')
    .description('Show every place an attachment is used')
    .option('--scope <scope>', 'fast (default; REST-only) or full (WP-CLI required, v0.5)', 'fast')
    .option(
      '--update-to <newId>',
      'rewrite all references to point at this new attachment ID (v0.5)',
      (v) => Number.parseInt(v, 10),
    )
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error(`Invalid attachment ID: ${idStr}`);
        process.exit(2);
      }

      if (options.updateTo !== undefined) {
        error('--update-to requires the WP-CLI adapter (v0.5). Not yet available.');
        process.exit(6);
      }

      const scope: ReferenceScope = options.scope === 'full' ? 'full' : 'fast';

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      const capName = scope === 'full' ? 'full-references' : 'fast-references';
      const adapter = resolver.tryResolve(capName);
      if (!adapter) {
        error(
          scope === 'full'
            ? 'Full reference scanning requires the WP-CLI adapter (v0.5).'
            : `No adapter available for reference scanning on site '${site.name}'.`,
        );
        process.exit(6);
      }

      if (scope === 'fast') {
        warn('Running fast scan (featured images + Gutenberg blocks). Use --scope full for a complete scan (v0.5).');
      }

      let references;
      try {
        references = await adapter.findReferences(id, scope);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
        return;
      }

      if (parentOpts.json) {
        printJson({
          attachmentId: id,
          scope,
          references,
        });
      } else {
        if (references.length === 0) {
          info(`No references found for attachment #${id} (${scope} scan).`);
          return;
        }

        info(`References to attachment #${id} (${scope} scan):\n`);
        for (const ref of references) {
          const occ = ref.occurrences && ref.occurrences > 1 ? ` (${ref.occurrences}×)` : '';
          const meta = ref.metaKey ? ` [meta: ${ref.metaKey}]` : '';
          info(`  ${ref.postType} #${ref.postId}  "${ref.postTitle}"  ${ref.type}${occ}${meta}`);
        }
        info(`\n  Total: ${references.length} reference(s).`);
      }
    });
}
