/**
 * `localpress watch-status` — report watcher orchestration state.
 *
 * Reports which directories have been watched for the active site, file
 * counts, and last activity timestamps. Useful for agents to check
 * "is automation already wired up here?" before starting their own ops.
 *
 * NOTE: this command does not detect a running watcher process — only
 * whether watch_mappings rows exist. A future enhancement could write a
 * pid file from the long-running `watch` command and check liveness.
 * For v1 the historical mapping data is the honest signal we can give.
 */

import type { Command } from 'commander';
import { SiteDb } from '../../engine/state/db.ts';
import { getSiteDbPath, loadConfig, resolveActiveSite } from '../utils/config.ts';
import { info, printJson } from '../utils/output.ts';

export function registerWatchStatusCommand(program: Command): void {
  program
    .command('watch-status')
    .description(
      'Report which directories have been watched on the active site (file→attachment mappings).',
    )
    .action(async () => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const db = SiteDb.init(getSiteDbPath(site.name));

      const directories = db.summarizeWatchDirectories(site.name);
      db.close();

      // "running" is honest here: we can't yet detect a live process, so we
      // report false. Once a pid-file scheme exists, this becomes accurate.
      const payload = {
        site: site.name,
        running: false,
        runningDetectionImplemented: false,
        directories,
      };

      if (parentOpts.json) {
        printJson(payload);
        return;
      }

      if (directories.length === 0) {
        info(`  No watch history for site '${site.name}'.`);
        info('  Start a watcher with: localpress watch <directory>');
        return;
      }

      info(`  Watch history for ${site.name}:`);
      for (const d of directories) {
        const when = new Date(d.lastActivityAt).toLocaleString();
        info(`    ${d.watchDir}  (${d.fileCount} files, last activity ${when})`);
      }
      info('');
      info(
        '  Note: live-process detection is not yet implemented. This report shows historical mappings only.',
      );
    });
}
