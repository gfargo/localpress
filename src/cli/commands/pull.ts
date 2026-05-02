/**
 * `localpress pull <ids> [--to <dir>]` — download attachments without processing.
 *
 * Useful for offline backups, manual review, or piping into other tools.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerPullCommand(program: Command): void {
  program
    .command('pull <ids...>')
    .description('Download attachments to a local directory without processing')
    .option('--to <dir>', 'destination directory (default: current working dir)')
    .option('--include-sizes', 'also download all generated thumbnail/medium/large variants')
    .action(async (_ids, _options) => {
      notImplemented('pull');
    });
}
