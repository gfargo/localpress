#!/usr/bin/env bun
/**
 * localpress — CLI entry point.
 *
 * Wires up commander with all v0.1 commands, applies global flags,
 * and dispatches to per-command handlers.
 */

import { Command, Option } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { registerA11yCommand } from './commands/a11y.ts';
import { registerAuditCommand } from './commands/audit.ts';
import { registerCaptionCommand } from './commands/caption.ts';
import { registerClassifyCommand } from './commands/classify.ts';
import { registerCompletionsCommand } from './commands/completions.ts';
import { registerConfigCommand } from './commands/config.ts';
import { registerConvertCommand } from './commands/convert.ts';
import { registerDeleteCommand } from './commands/delete.ts';
import { registerDescribeCommand } from './commands/describe.ts';
import { registerDoctorCommand } from './commands/doctor.ts';
import { registerEditCommand } from './commands/edit.ts';
import { registerExportCommand } from './commands/export.ts';
import { registerHistoryCommand } from './commands/history.ts';
import { registerImportCommand } from './commands/import.ts';
import { registerInitCommand } from './commands/init.ts';
import { registerListCommand } from './commands/list.ts';
import { registerMcpCommand } from './commands/mcp.ts';
import { registerMetadataCommand } from './commands/metadata.ts';
import { registerOptimizeCommand } from './commands/optimize.ts';
import { registerPostsCommand } from './commands/posts.ts';
import { registerPullCommand } from './commands/pull.ts';
import { registerPushCommand } from './commands/push.ts';
import { registerReferencesCommand } from './commands/references.ts';
import { registerRegenerateCommand } from './commands/regenerate.ts';
import { registerRemoveBgCommand } from './commands/remove-bg.ts';
import { registerRenameCommand } from './commands/rename.ts';
import { registerResizeCommand } from './commands/resize.ts';
import { registerShowCommand } from './commands/show.ts';
import { registerSitesCommand } from './commands/sites.ts';
import { registerStatsCommand } from './commands/stats.ts';
import { registerTagCommand } from './commands/tag.ts';
import { registerTitleCommand } from './commands/title.ts';
import { registerUndoCommand } from './commands/undo.ts';
import { registerUpdateCommand } from './commands/update.ts';
import { registerVisionCommand } from './commands/vision.ts';
import { registerWatchStatusCommand } from './commands/watch-status.ts';
import { registerWatchCommand } from './commands/watch.ts';
import { setOutputOptions } from './utils/output.ts';

const program = new Command();

program
  .name('localpress')
  .description('Local-compute WordPress media optimization. Your laptop, your library.')
  .version(packageJson.version, '-v, --version', 'output the current version')
  .addOption(new Option('--site <name>', 'override the active site for this command'))
  .addOption(new Option('--json', 'machine-readable JSON output').default(false))
  .addOption(new Option('--quiet', 'errors only; suppress info messages').default(false))
  .addOption(
    new Option(
      '--concurrency <n>',
      'parallel workers for bulk ops (default: CPU count - 1)',
    ).argParser((v) => Number.parseInt(v, 10)),
  )
  .addOption(new Option('--dry-run', 'show what would happen without executing').default(false))
  .addOption(new Option('--apply', 'opt out of dry-run for bulk ops').default(false))
  .addOption(new Option('--yes', 'skip confirmation prompts').default(false))
  .addOption(
    new Option('--strict', 'fail loudly when capability fallbacks would activate').default(false),
  )
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    setOutputOptions({
      json: Boolean(opts.json),
      quiet: Boolean(opts.quiet),
    });
  });

// Register all commands.
registerInitCommand(program);
registerSitesCommand(program);
registerDoctorCommand(program);
registerConfigCommand(program);
registerListCommand(program);
registerShowCommand(program);
registerStatsCommand(program);
registerCaptionCommand(program);
registerTitleCommand(program);
registerDescribeCommand(program);
registerClassifyCommand(program);
registerTagCommand(program);
registerVisionCommand(program);
registerMetadataCommand(program);
registerDeleteCommand(program);
registerAuditCommand(program);
registerA11yCommand(program);
registerOptimizeCommand(program);
registerConvertCommand(program);
registerResizeCommand(program);
registerRemoveBgCommand(program);
registerEditCommand(program);
registerPullCommand(program);
registerPushCommand(program);
registerExportCommand(program);
registerImportCommand(program);
registerReferencesCommand(program);
registerRegenerateCommand(program);
registerRenameCommand(program);
registerHistoryCommand(program);
registerUndoCommand(program);
registerUpdateCommand(program);
registerWatchCommand(program);
registerWatchStatusCommand(program);
registerCompletionsCommand(program);
registerPostsCommand(program);
registerMcpCommand(program);

// Top-level help footer.
program.addHelpText(
  'after',
  `
Examples:
  $ localpress init                              # connect a WordPress site
  $ localpress doctor                            # show backend availability
  $ localpress list --unoptimized                # find images we haven't processed yet
  $ localpress optimize 123 124 125              # compress specific attachments
  $ localpress optimize --unoptimized --apply    # bulk compress (skip dry-run)
  $ localpress references 1234                   # show where attachment 1234 is used

Documentation:
  Full v1 plan:        docs/v1-plan.md
  Competitive brief:   docs/competitive-brief.md
  Issues & feedback:   https://github.com/gfargo/localpress/issues
`,
);

// Top-level CLI error handler — keeps stack traces out of normal failure paths.
async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    process.exit(1);
  }
}

void main();
