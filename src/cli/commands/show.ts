/**
 * `localpress show <id>` — show metadata, dimensions, and processing history
 * for a single attachment.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerShowCommand(program: Command): void {
  program
    .command('show <id>')
    .description('Show metadata and optimization history for an attachment')
    .action(async (_id) => {
      notImplemented('show');
    });
}
