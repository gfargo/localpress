/**
 * `localpress push <path> [--replace <id>]` — upload a local file as a new
 * attachment, or as a replacement for an existing one.
 *
 * The replacement-with-fallback logic is shared with `optimize`: if true
 * in-place replacement isn't available, falls back to creating a new
 * attachment and surfaces a references report (unless --strict).
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerPushCommand(program: Command): void {
  program
    .command('push <path>')
    .description('Upload a local file to the media library')
    .option('--replace <id>', 'replace this attachment instead of creating a new one', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--title <title>', 'attachment title')
    .option('--alt <text>', 'alt text')
    .option('--caption <text>', 'caption')
    .option('--description <text>', 'description')
    .option('--post <id>', 'attach to this post', (v) => Number.parseInt(v, 10))
    .action(async (_path, _options) => {
      notImplemented('push');
    });
}
