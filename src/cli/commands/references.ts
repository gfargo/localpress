/**
 * `localpress references <id>` — show every place attachment <id> is used.
 *
 * v0.1 fast scan (REST):
 *   - featured images (`_thumbnail_id` post meta)
 *   - Gutenberg block IDs (`<!-- wp:image {"id":N} -->`)
 *
 * v0.5 full scan (WP-CLI):
 *   - inline content URLs and srcset
 *   - custom field meta values
 *   - --update-to <new-id> for safe rewriting via wp search-replace
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

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
    .action(async (_id, _options) => {
      notImplemented('references');
    });
}
