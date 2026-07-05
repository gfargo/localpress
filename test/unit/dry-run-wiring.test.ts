/**
 * Regression test for the global `--dry-run` collision bug (OSS-554 / #90
 * follow-up): `--dry-run` and `--apply` live on the root program. In
 * commander 12, a subcommand that declares its own option with the same
 * long flag silently shadows the global one — `options.dryRun` stays
 * `undefined` on the subcommand's `action()` no matter where the flag is
 * placed on the command line, so any code reading `options.dryRun` directly
 * (instead of `program.opts().dryRun` / `resolveDryRun`) never sees it.
 *
 * This walks every registered command (including nested subcommands, e.g.
 * `posts delete`) and asserts none of them redeclares `--dry-run` or
 * `--apply` locally, which is the structural precondition for the bug.
 */

import { describe, expect, test } from 'bun:test';
import { Command, Option } from 'commander';
import { registerA11yCommand } from '../../src/cli/commands/a11y.ts';
import { registerAuditCommand } from '../../src/cli/commands/audit.ts';
import { registerCaptionCommand } from '../../src/cli/commands/caption.ts';
import { registerClassifyCommand } from '../../src/cli/commands/classify.ts';
import { registerCompletionsCommand } from '../../src/cli/commands/completions.ts';
import { registerConfigCommand } from '../../src/cli/commands/config.ts';
import { registerConvertCommand } from '../../src/cli/commands/convert.ts';
import { registerDeleteCommand } from '../../src/cli/commands/delete.ts';
import { registerDescribeCommand } from '../../src/cli/commands/describe.ts';
import { registerDoctorCommand } from '../../src/cli/commands/doctor.ts';
import { registerEditCommand } from '../../src/cli/commands/edit.ts';
import { registerExportCommand } from '../../src/cli/commands/export.ts';
import { registerHistoryCommand } from '../../src/cli/commands/history.ts';
import { registerImportCommand } from '../../src/cli/commands/import.ts';
import { registerInitCommand } from '../../src/cli/commands/init.ts';
import { registerListCommand } from '../../src/cli/commands/list.ts';
import { registerMcpCommand } from '../../src/cli/commands/mcp.ts';
import { registerMetadataCommand } from '../../src/cli/commands/metadata.ts';
import { registerOptimizeCommand } from '../../src/cli/commands/optimize.ts';
import { registerPostsCommand } from '../../src/cli/commands/posts.ts';
import { registerPullCommand } from '../../src/cli/commands/pull.ts';
import { registerPushCommand } from '../../src/cli/commands/push.ts';
import { registerReferencesCommand } from '../../src/cli/commands/references.ts';
import { registerRegenerateCommand } from '../../src/cli/commands/regenerate.ts';
import { registerRemoveBgCommand } from '../../src/cli/commands/remove-bg.ts';
import { registerRenameCommand } from '../../src/cli/commands/rename.ts';
import { registerResizeCommand } from '../../src/cli/commands/resize.ts';
import { registerShowCommand } from '../../src/cli/commands/show.ts';
import { registerSitesCommand } from '../../src/cli/commands/sites.ts';
import { registerStatsCommand } from '../../src/cli/commands/stats.ts';
import { registerTagCommand } from '../../src/cli/commands/tag.ts';
import { registerTitleCommand } from '../../src/cli/commands/title.ts';
import { registerUndoCommand } from '../../src/cli/commands/undo.ts';
import { registerUpdateCommand } from '../../src/cli/commands/update.ts';
import { registerVisionCommand } from '../../src/cli/commands/vision.ts';
import { registerWatchStatusCommand } from '../../src/cli/commands/watch-status.ts';
import { registerWatchCommand } from '../../src/cli/commands/watch.ts';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('localpress')
    .addOption(new Option('--site <name>', 'override the active site for this command'))
    .addOption(new Option('--json', 'machine-readable JSON output').default(false))
    .addOption(new Option('--quiet', 'errors only; suppress info messages').default(false))
    .addOption(new Option('--dry-run', 'show what would happen without executing').default(false))
    .addOption(new Option('--apply', 'opt out of dry-run for bulk ops').default(false))
    .addOption(new Option('--yes', 'skip confirmation prompts').default(false))
    .addOption(
      new Option('--strict', 'fail loudly when capability fallbacks would activate').default(false),
    );

  registerA11yCommand(program);
  registerAuditCommand(program);
  registerCaptionCommand(program);
  registerClassifyCommand(program);
  registerCompletionsCommand(program);
  registerConfigCommand(program);
  registerConvertCommand(program);
  registerDeleteCommand(program);
  registerDescribeCommand(program);
  registerDoctorCommand(program);
  registerEditCommand(program);
  registerExportCommand(program);
  registerHistoryCommand(program);
  registerImportCommand(program);
  registerInitCommand(program);
  registerListCommand(program);
  registerMcpCommand(program);
  registerMetadataCommand(program);
  registerOptimizeCommand(program);
  registerPostsCommand(program);
  registerPullCommand(program);
  registerPushCommand(program);
  registerReferencesCommand(program);
  registerRegenerateCommand(program);
  registerRemoveBgCommand(program);
  registerRenameCommand(program);
  registerResizeCommand(program);
  registerShowCommand(program);
  registerSitesCommand(program);
  registerStatsCommand(program);
  registerTagCommand(program);
  registerTitleCommand(program);
  registerUndoCommand(program);
  registerUpdateCommand(program);
  registerVisionCommand(program);
  registerWatchCommand(program);
  registerWatchStatusCommand(program);

  return program;
}

/** Recursively collect every command and nested subcommand (e.g. `posts delete`). */
function collectCommands(
  command: Command,
  path: string[] = [],
): Array<{ path: string[]; command: Command }> {
  const here = path.length === 0 ? [] : [{ path, command }];
  const nested = command.commands.flatMap((sub) => collectCommands(sub, [...path, sub.name()]));
  return [...here, ...nested];
}

describe('dry-run/apply flag wiring', () => {
  const program = buildProgram();
  const allCommands = collectCommands(program);

  test('sanity: command tree was actually built', () => {
    expect(allCommands.length).toBeGreaterThan(20);
  });

  for (const { path, command } of allCommands) {
    const label = path.join(' ');

    test(`\`${label}\` does not redeclare --dry-run locally`, () => {
      const collision = command.options.find((opt) => opt.long === '--dry-run');
      expect(collision).toBeUndefined();
    });

    test(`\`${label}\` does not redeclare --apply locally`, () => {
      const collision = command.options.find((opt) => opt.long === '--apply');
      expect(collision).toBeUndefined();
    });
  }
});
