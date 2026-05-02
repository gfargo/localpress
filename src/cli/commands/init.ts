/**
 * `localpress init` — interactive setup wizard.
 *
 * Walks the user through:
 *   1. Site URL
 *   2. Username + Application Password
 *   3. Connection test (calls /wp-json/wp/v2/users/me)
 *   4. Capability detection report (same output as `localpress doctor`)
 *   5. Optional SSH config for the WP-CLI adapter
 *   6. Save to config file
 *
 * The wizard uses Ink (React for CLIs) for the interactive UI.
 * v0.1 implementation; stubbed in this scaffold.
 */

import type { Command } from 'commander';
import { notImplemented } from '../utils/output.ts';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Connect a WordPress site (interactive wizard)')
    .option('--name <name>', 'name for this site (skip the prompt)')
    .option('--url <url>', 'WordPress site URL (skip the prompt)')
    .option('--non-interactive', 'fail instead of prompting (for scripts)')
    .action(async (_options) => {
      notImplemented('init');
    });
}
