/**
 * `localpress references <id>` — show every place attachment <id> is used.
 *
 * Fast scan (REST): featured images + Gutenberg block IDs
 * Full scan (WP-CLI): + inline content URLs, srcset, custom field meta
 * --update-to <new-id>: rewrite all references via wp search-replace (WP-CLI)
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { ReferenceScope } from '../../adapters/types.ts';
import { sshExec } from '../../adapters/ssh.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerReferencesCommand(program: Command): void {
  program
    .command('references <id>')
    .description('Show every place an attachment is used')
    .option('--scope <scope>', 'fast (REST) or full (WP-CLI required)', 'fast')
    .option(
      '--update-to <newId>',
      'rewrite all references to point at this new attachment ID (requires WP-CLI)',
      (v) => Number.parseInt(v, 10),
    )
    .action(async (idStr: string, options) => {
      const parentOpts = program.opts();
      const id = Number.parseInt(idStr, 10);
      if (Number.isNaN(id)) {
        error(`Invalid attachment ID: ${idStr}`);
        process.exit(2);
      }

      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      // Handle --update-to: requires WP-CLI.
      if (options.updateTo !== undefined) {
        const newId = options.updateTo as number;
        if (Number.isNaN(newId)) {
          error('--update-to must be a valid attachment ID.');
          process.exit(2);
        }

        if (!site.ssh) {
          error('--update-to requires WP-CLI over SSH. Configure SSH access for this site.');
          process.exit(6);
        }

        // Get the old and new attachment URLs.
        const getAdapter = resolver.resolve('get');
        const oldItem = await getAdapter.getMedia(id);
        const newItem = await getAdapter.getMedia(newId);

        info(`Rewriting references from #${id} → #${newId}...`);

        const isDryRun = parentOpts.dryRun && !parentOpts.apply;
        const dryRunFlag = isDryRun ? '--dry-run' : '';

        // 1. Update featured images (_thumbnail_id).
        await sshExec(
          site.ssh,
          `cd ${site.ssh.wpPath} && wp db query "UPDATE wp_postmeta SET meta_value='${newId}' WHERE meta_key='_thumbnail_id' AND meta_value='${id}'" --allow-root`,
        );
        if (!isDryRun) {
          info(`  ✓ Updated _thumbnail_id references.`);
        }

        // 2. Search-replace the old URL with the new URL in post content.
        if (oldItem.url && newItem.url) {
          const replaceResult = await sshExec(
            site.ssh,
            `cd ${site.ssh.wpPath} && wp search-replace "${oldItem.url}" "${newItem.url}" wp_posts --precise ${dryRunFlag} --allow-root`,
          );
          info(`  ✓ URL replacement: ${replaceResult.stdout.trim()}`);
        }

        // 3. Replace Gutenberg block IDs.
        const blockOld = `"id":${id}`;
        const blockNew = `"id":${newId}`;
        const blockResult = await sshExec(
          site.ssh,
          `cd ${site.ssh.wpPath} && wp search-replace '${blockOld}' '${blockNew}' wp_posts --precise ${dryRunFlag} --allow-root`,
        );
        info(`  ✓ Block ID replacement: ${blockResult.stdout.trim()}`);

        if (isDryRun) {
          info('\n  Dry-run complete. Pass --apply to execute the rewrites.');
        } else {
          info('\n  References rewritten successfully.');
        }

        if (parentOpts.json) {
          printJson({
            action: 'update-references',
            fromId: id,
            toId: newId,
            dryRun: isDryRun,
          });
        }
        return;
      }

      // Normal reference scan.
      const scope: ReferenceScope = options.scope === 'full' ? 'full' : 'fast';

      const capName = scope === 'full' ? 'full-references' : 'fast-references';
      const adapter = resolver.tryResolve(capName);
      if (!adapter) {
        error(
          scope === 'full'
            ? 'Full reference scanning requires WP-CLI over SSH. Configure SSH access for this site.'
            : `No adapter available for reference scanning on site '${site.name}'.`,
        );
        process.exit(6);
      }

      if (scope === 'fast') {
        warn(
          'Running fast scan (featured images + Gutenberg blocks). Use --scope full for a complete scan.',
        );
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
        printJson({ attachmentId: id, scope, references });
      } else {
        if (references.length === 0) {
          info(`No references found for attachment #${id} (${scope} scan).`);
          return;
        }

        info(`References to attachment #${id} (${scope} scan):\n`);
        for (const ref of references) {
          const occ = ref.occurrences && ref.occurrences > 1 ? ` (${ref.occurrences}×)` : '';
          const meta = ref.metaKey ? ` [meta: ${ref.metaKey}]` : '';
          info(
            `  ${ref.postType} #${ref.postId}  "${ref.postTitle}"  ${ref.type}${occ}${meta}`,
          );
        }
        info(`\n  Total: ${references.length} reference(s).`);
      }
    });
}
