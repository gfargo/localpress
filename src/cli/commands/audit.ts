/**
 * `localpress audit` — find optimization opportunities across the library.
 *
 * v0.1 checks (REST-only):
 *   - large unoptimized images (> threshold)
 *   - unattached media (no post references)
 *
 * v0.5 checks (require WP-CLI adapter):
 *   - missing alt text
 *   - oversized for display container
 *   - true orphans (file present, no DB record — wp media prune territory)
 *
 * --json output is a great fit for the skill: an agent can run `audit --json`
 * and pipe the results into a workflow without parsing human-readable output.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

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
    .option('--missing-alt', 'flag images without alt text (v0.5)')
    .option('--orphans', 'flag uploads-dir files with no DB record (requires WP-CLI; v0.5)')
    .action(async (_options) => {
      notImplemented('audit');
    });
}
