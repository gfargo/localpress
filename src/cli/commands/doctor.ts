/**
 * `localpress doctor` — show backend availability and capability matrix.
 *
 * In --json mode, emits a structured capability report — exactly what the
 * skill consumes to decide which operations the agent can attempt.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson } from '../utils/output.ts';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Show backend availability and capability matrix for a site')
    .option('--all-sites', 'show capabilities for every configured site (not just the active one)')
    .action(async (options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();

      const siteNames = options.allSites
        ? Object.keys(config.sites)
        : [resolveActiveSite(config, parentOpts.site).name];

      if (siteNames.length === 0) {
        error('No sites configured. Run `localpress init` to add one.');
        process.exit(3);
      }

      for (const name of siteNames) {
        const site = config.sites[name];
        if (!site) continue;

        const resolver = new AdapterResolver(site);
        const availability = resolver.availability();
        const report = resolver.capabilityReport();

        if (parentOpts.json) {
          printJson({
            site: name,
            url: site.url,
            adapters: availability,
            capabilities: report,
          });
        } else {
          info(`\nSite: ${name} (${site.url})`);
          info(`  ${availability.rest ? '✓' : '✗'} REST API`);
          info(`  ${availability.wpCli ? '✓' : '✗'} WP-CLI (SSH)`);
          info(`  ${availability.mcp ? '✓' : '✗'} MCP`);
          info('');
          info('  Capabilities:');
          for (const cap of report) {
            const status = cap.preferredAdapter ? '✓' : '✗';
            const via = cap.preferredAdapter ? ` (via ${cap.preferredAdapter})` : '';
            info(`    ${status} ${cap.capability}${via}`);
          }
        }
      }
    });
}
