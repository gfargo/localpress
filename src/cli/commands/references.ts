/**
 * `localpress references <id>` — show every place attachment <id> is used.
 *
 * Fast scan (REST): featured images + Gutenberg block IDs
 * Full scan (WP-CLI): + inline content URLs, srcset, custom field meta
 * --update-to <new-id>: rewrite all references via wp search-replace (WP-CLI)
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { shellQuote, sshExec } from '../../adapters/ssh.ts';
import type { ReferenceScope } from '../../adapters/types.ts';
import { parseIntOption } from '../utils/args.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';
import { resolveDryRun } from '../utils/run-mode.ts';

export function registerReferencesCommand(program: Command): void {
  program
    .command('references <id>')
    .description('Show every place an attachment is used')
    .option('--scope <scope>', 'fast (REST) or full (WP-CLI required)', 'fast')
    .option(
      '--update-to <newId>',
      'rewrite all references to point at this new attachment ID (requires WP-CLI)',
      parseIntOption('--update-to'),
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
        const ssh = site.ssh;

        // Get the old and new attachment URLs.
        const getAdapter = resolver.resolve('get');
        const oldItem = await getAdapter.getMedia(id);
        const newItem = await getAdapter.getMedia(newId);

        info(`Rewriting references from #${id} → #${newId}...`);

        const isDryRun = resolveDryRun(parentOpts, false);
        const dryRunFlag = isDryRun ? '--dry-run' : '';
        const cd = `cd ${shellQuote(ssh.wpPath)}`;

        // Fails the whole step loudly if a remote command errors, and reports
        // which steps had already completed (this flow is not transactional).
        const completed: string[] = [];
        const run = async (label: string, command: string): Promise<string> => {
          const res = await sshExec(ssh, `${cd} && ${command} --allow-root`);
          if (res.exitCode !== 0) {
            const applied = completed.length
              ? `Already applied: ${completed.join(', ')} — the rewrite is now partial.`
              : 'No changes were applied.';
            throw new Error(
              `${label} failed (exit ${res.exitCode}): ${res.stderr || res.stdout}\n${applied}`,
            );
          }
          completed.push(label);
          return res.stdout.trim();
        };

        // Resolve the real table prefix ($table_prefix may not be wp_).
        const prefixRes = await sshExec(ssh, `${cd} && wp db prefix --allow-root`);
        const prefix = prefixRes.stdout.trim() || 'wp_';

        // 1. Featured images (_thumbnail_id) — a raw UPDATE with no --dry-run
        //    switch, so in dry-run mode we only COUNT the affected rows.
        if (isDryRun) {
          const countRes = await sshExec(
            ssh,
            `${cd} && wp db query "SELECT COUNT(*) FROM ${prefix}postmeta WHERE meta_key='_thumbnail_id' AND meta_value='${id}'" --skip-column-names --allow-root`,
          );
          info(`  Would update ${countRes.stdout.trim() || 0} featured-image reference(s).`);
        } else {
          await run(
            'featured-image update',
            `wp db query "UPDATE ${prefix}postmeta SET meta_value='${newId}' WHERE meta_key='_thumbnail_id' AND meta_value='${id}'"`,
          );
          info('  ✓ Updated _thumbnail_id references.');
        }

        // 2. URL replacement across ALL tables (page builders store URLs in
        //    postmeta/options too). --precise keeps serialized data valid.
        if (oldItem.url && newItem.url) {
          const out = await run(
            'URL replacement',
            `wp search-replace ${shellQuote(oldItem.url)} ${shellQuote(newItem.url)} --precise ${dryRunFlag}`,
          );
          info(`  ✓ URL replacement: ${out}`);
        }

        // 3. Gutenberg block IDs — regex-anchored so rewriting id 12 can't
        //    corrupt 123. Restricted to post_content (regex isn't serialize-safe,
        //    and block markup only lives there).
        const blockPattern = `"id":${id}(?![0-9])`;
        const blockReplace = `"id":${newId}`;
        const out = await run(
          'block ID replacement',
          `wp search-replace ${shellQuote(blockPattern)} ${shellQuote(blockReplace)} ${prefix}posts --include-columns=post_content --regex ${dryRunFlag}`,
        );
        info(`  ✓ Block ID replacement: ${out}`);

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

      let references: import('../../adapters/types.ts').Reference[];
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
          info(`  ${ref.postType} #${ref.postId}  "${ref.postTitle}"  ${ref.type}${occ}${meta}`);
        }
        info(`\n  Total: ${references.length} reference(s).`);
      }
    });
}
