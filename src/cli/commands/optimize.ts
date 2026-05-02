/**
 * `localpress optimize <ids|--all|--unoptimized>` — the marquee v0.1 command.
 *
 * Behavior decisions (locked in conversation):
 *   - Bulk operations (--all, --unoptimized) are SAFE BY DEFAULT (dry-run).
 *     User must pass --apply to execute.
 *   - Explicit IDs (e.g. `optimize 123 124 125`) execute immediately —
 *     the user said which IDs, so they meant it.
 *   - Replace-in-place is the DEFAULT. Falls back to new-attachment +
 *     references report if WP-CLI / Enable Media Replace plugin aren't
 *     available, unless --strict is set.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerOptimizeCommand(program: Command): void {
  program
    .command('optimize [ids...]')
    .description('Compress (and optionally convert) media. Use IDs, --all, or --unoptimized.')
    .option('--all', 'process every attachment in the library (dry-run unless --apply)')
    .option(
      '--unoptimized',
      "process only attachments localpress hasn't seen yet (dry-run unless --apply)",
    )
    .option('--larger-than <bytes>', 'only attachments larger than this (works with --all)', (v) =>
      Number.parseInt(v, 10),
    )
    .option(
      '--to <format>',
      'convert during optimization: webp, avif, or jpeg (defaults to source format)',
    )
    .option(
      '--mode <mode>',
      'compression mode: lossy or lossless (default: lossy for jpeg/webp/avif, lossless for png)',
    )
    .option('--quality <n>', '0-100 quality value (codec-specific)', (v) => Number.parseInt(v, 10))
    .option(
      '--no-replace-in-place',
      'always upload as a new attachment, never attempt true replacement',
    )
    .option('--keep-original', 'do not replace; save the optimized copy as a separate attachment')
    .action(async (_ids, _options) => {
      notImplemented('optimize');
    });
}
