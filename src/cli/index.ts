#!/usr/bin/env bun
/**
 * localpress — CLI entry point.
 *
 * Wires up commander with all v0.1 commands, applies global flags,
 * and dispatches to per-command handlers.
 */

import { Command, CommanderError, Option } from 'commander';

import packageJson from '../../package.json' with { type: 'json' };
import { CapabilityUnavailableError, WpApiError } from '../adapters/types.ts';
import { ExitCode } from '../types.ts';
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
import { parseIntOption } from './utils/args.ts';
import { ConfigError } from './utils/config.ts';
import { error, setOutputOptions } from './utils/output.ts';

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
    ).argParser(parseIntOption('--concurrency')),
  )
  .addOption(new Option('--dry-run', 'show what would happen without executing').default(false))
  .addOption(new Option('--apply', 'opt out of dry-run for bulk ops').default(false))
  .addOption(new Option('--yes', 'skip confirmation prompts').default(false))
  .addOption(
    new Option('--strict', 'fail loudly when capability fallbacks would activate').default(false),
  )
  // Suppress commander's own stderr write for usage errors — the top-level
  // catch below is the single source of truth for error formatting (plain
  // text vs. --json), so let it print the message instead of commander.
  .configureOutput({ outputError: () => {} })
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

// commander's exitOverride() isn't reliably inherited by sub-subcommands
// registered via `.command()` (e.g. `sites add`, `config set-profile`), so
// apply it recursively to make usage errors map to ExitCode.InvalidUsage
// everywhere instead of just at the root.
function applyExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) applyExitOverride(sub);
}
applyExitOverride(program);

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
  // Pre-seed output options from raw argv so usage errors that occur before any
  // command's `preAction` hook runs (e.g. a truly unknown top-level command)
  // still honor --json. The preAction hook overrides this once a command matches.
  setOutputOptions({
    json: process.argv.includes('--json'),
    quiet: process.argv.includes('--quiet'),
  });

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
        process.exit(err.exitCode);
      }
      // Commander's own messages already carry an "error: " prefix — strip it
      // so our error() helper doesn't double it up in plain-text mode.
      error(err.message.replace(/^error: /, ''));
      process.exit(ExitCode.InvalidUsage);
    }
    if (err instanceof ConfigError) {
      error(err.message);
      process.exit(ExitCode.ConfigError);
    }
    if (err instanceof CapabilityUnavailableError) {
      error(err.message);
      process.exit(ExitCode.CapabilityUnavailable);
    }
    if (err instanceof WpApiError) {
      error(err.message);
      process.exit(
        err.status === 401 || err.status === 403 ? ExitCode.AuthError : ExitCode.NetworkError,
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exit(ExitCode.GenericError);
  }
}

void main();
