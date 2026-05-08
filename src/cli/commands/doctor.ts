/**
 * `localpress doctor` — show backend availability and capability matrix.
 *
 * In --json mode, emits a structured capability report — exactly what the
 * skill consumes to decide which operations the agent can attempt.
 *
 * --fix: attempt to auto-remediate detected issues (test connection, guide
 *        through SSH setup, etc.)
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { SiteConfig } from '../../types.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

/**
 * Plugins that localpress can detect and that affect capability availability.
 * We probe for these via the WP REST API's plugin endpoint (requires
 * `manage_options` capability — available with Application Passwords).
 */
const KNOWN_PLUGINS: Array<{
  slug: string;
  name: string;
  capability: string;
  description: string;
}> = [
  {
    slug: 'enable-media-replace',
    name: 'Enable Media Replace',
    capability: 'replace-in-place (REST fallback)',
    description: 'Enables in-place file replacement without WP-CLI',
  },
  {
    slug: 'wp-cli',
    name: 'WP-CLI (server-side)',
    capability: 'replace-in-place, regenerate-thumbnails, prune-orphans, full-references',
    description: 'Full capability set via SSH — configure SSH in `localpress init`',
  },
  {
    slug: 'jetpack',
    name: 'Jetpack',
    capability: 'CDN awareness',
    description: 'Jetpack CDN may serve different URLs — localpress will use the source URL',
  },
  {
    slug: 'wp-smush-pro',
    name: 'Smush Pro',
    capability: 'conflict awareness',
    description:
      'Smush may re-process images after localpress uploads — consider disabling auto-smush',
  },
  {
    slug: 'shortpixel-image-optimiser',
    name: 'ShortPixel',
    capability: 'conflict awareness',
    description: 'ShortPixel may re-process images after localpress uploads',
  },
  {
    slug: 'ewww-image-optimizer',
    name: 'EWWW Image Optimizer',
    capability: 'conflict awareness',
    description: 'EWWW may re-process images after localpress uploads',
  },
];

interface PluginStatus {
  slug: string;
  name: string;
  active: boolean;
  capability: string;
  description: string;
  version?: string;
}

interface DoctorIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  fix?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Show backend availability and capability matrix for a site')
    .option('--all-sites', 'show capabilities for every configured site (not just the active one)')
    .option('--plugins', 'probe for relevant WordPress plugins and report their status')
    .option(
      '--fix',
      'attempt to auto-remediate detected issues (test connection, prompt for missing config)',
    )
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

        // -- Connection test ---------------------------------------------------
        const issues: DoctorIssue[] = [];
        let connectionOk = false;

        try {
          const restAdapter = resolver.getAdapter('rest');
          if (restAdapter) {
            // Quick connectivity check — list 1 item.
            await restAdapter.listMedia({ perPage: 1, page: 1 });
            connectionOk = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('401') || msg.includes('Unauthorized')) {
            issues.push({
              severity: 'error',
              message: 'Authentication failed — Application Password rejected',
              fix: 'Run `localpress sites remove <name>` then `localpress init` to re-enter credentials',
            });
          } else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED')) {
            issues.push({
              severity: 'error',
              message: `Cannot reach ${site.url} — check the URL and your network connection`,
              fix: 'Verify the site URL with `localpress sites` and update if needed',
            });
          } else {
            issues.push({
              severity: 'error',
              message: `REST API error: ${msg}`,
            });
          }
        }

        if (!availability.wpCli) {
          issues.push({
            severity: 'info',
            message:
              'WP-CLI (SSH) not configured — replace-in-place and full reference scanning unavailable',
            fix: `Run \`localpress init --site ${name}\` and add SSH config to unlock these capabilities`,
          });
        }

        // -- Sharp availability check -----------------------------------------
        let sharpAvailable = false;
        try {
          const { loadSharp } = await import('../../engine/image/sharp-loader.ts');
          await loadSharp();
          sharpAvailable = true;
        } catch {
          issues.push({
            severity: 'error',
            message:
              'sharp is not installed — optimize, convert, resize, and remove-bg will not work',
            fix: 'Run `bun install -g sharp` or `npm install -g sharp` (macOS: `brew install vips` first)',
          });
        }

        // -- Plugin detection --------------------------------------------------
        let plugins: PluginStatus[] = [];
        if (options.plugins || options.fix) {
          plugins = await detectPlugins(site);
        }

        // Check for conflicting optimizer plugins.
        const conflictPlugins = plugins.filter(
          (p) =>
            p.active &&
            ['wp-smush-pro', 'shortpixel-image-optimiser', 'ewww-image-optimizer'].includes(p.slug),
        );
        for (const p of conflictPlugins) {
          issues.push({
            severity: 'warning',
            message: `${p.name} is active — it may re-process images after localpress uploads`,
            fix: `Consider disabling auto-optimization in ${p.name} settings to avoid conflicts`,
          });
        }

        const enableMediaReplace = plugins.find(
          (p) => p.slug === 'enable-media-replace' && p.active,
        );
        if (enableMediaReplace) {
          issues.push({
            severity: 'info',
            message: 'Enable Media Replace is active — REST replace-in-place is available',
          });
        }

        // -- --fix: attempt auto-remediation -----------------------------------
        if (options.fix && issues.length > 0) {
          info('\nAttempting auto-remediation...\n');
          for (const issue of issues) {
            if (issue.severity === 'error' && issue.fix) {
              warn(`  ${issue.message}`);
              info(`  → ${issue.fix}`);
            }
          }
          // For auth errors, offer to re-test with updated credentials.
          const authIssue = issues.find(
            (i) => i.severity === 'error' && i.message.includes('Authentication'),
          );
          if (authIssue && connectionOk === false) {
            info('\n  To update credentials, run:');
            info(`    localpress sites remove ${name}`);
            info('    localpress init');
          }
        }

        // -- Output ------------------------------------------------------------
        if (parentOpts.json) {
          printJson({
            site: name,
            url: site.url,
            connectionOk,
            sharpAvailable,
            adapters: availability,
            capabilities: report,
            issues,
            ...(options.plugins || options.fix ? { plugins } : {}),
          });
        } else {
          info(`\nSite: ${name} (${site.url})`);
          info(`  ${connectionOk ? '✓' : '✗'} REST API connection`);
          info(`  ${availability.wpCli ? '✓' : '✗'} WP-CLI (SSH)`);
          info(`  ${availability.mcp ? '✓' : '✗'} MCP`);
          info(`  ${sharpAvailable ? '✓' : '✗'} sharp (image processing)`);
          info('');
          info('  Capabilities:');
          for (const cap of report) {
            const status = cap.preferredAdapter ? '✓' : '✗';
            const via = cap.preferredAdapter ? ` (via ${cap.preferredAdapter})` : '';
            info(`    ${status} ${cap.capability}${via}`);
          }

          if (plugins.length > 0) {
            info('');
            info('  Plugins:');
            for (const p of plugins) {
              const status = p.active ? '✓' : '○';
              const ver = p.version ? ` v${p.version}` : '';
              info(`    ${status} ${p.name}${ver}`);
              info(`      ${p.description}`);
            }
          }

          if (issues.length > 0) {
            info('');
            info('  Issues:');
            for (const issue of issues) {
              const icon =
                issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
              info(`    ${icon} ${issue.message}`);
              if (issue.fix) {
                info(`      → ${issue.fix}`);
              }
            }
          }

          if (issues.filter((i) => i.severity === 'error').length === 0 && connectionOk) {
            info('');
            info('  Everything looks good!');
          }
        }
      }
    });
}

// -- Plugin detection ---------------------------------------------------------

interface WpPluginResponse {
  plugin: string;
  name: string;
  status: 'active' | 'inactive' | 'network-active';
  version: string;
}

async function detectPlugins(site: SiteConfig): Promise<PluginStatus[]> {
  const baseUrl = site.url.replace(/\/+$/, '');
  const credentials = `${site.username}:${site.appPassword}`;
  const authHeader = `Basic ${btoa(credentials)}`;

  let rawPlugins: WpPluginResponse[] = [];

  try {
    const response = await fetch(`${baseUrl}/wp-json/wp/v2/plugins?per_page=100`, {
      headers: { Authorization: authHeader },
    });

    if (response.status === 401 || response.status === 403) {
      warn(
        'Plugin detection requires the `manage_options` capability. ' +
          'Ensure your Application Password user has administrator privileges.',
      );
      return [];
    }

    if (!response.ok) {
      // Plugin endpoint may not be available on all WP versions — fail silently.
      return [];
    }

    rawPlugins = (await response.json()) as WpPluginResponse[];
  } catch {
    // Network error or endpoint not available — skip plugin detection.
    return [];
  }

  // Map known plugins against what's installed.
  return KNOWN_PLUGINS.map((known) => {
    const installed = rawPlugins.find(
      (p) =>
        p.plugin.startsWith(`${known.slug}/`) ||
        p.plugin === known.slug ||
        p.name.toLowerCase().includes(known.name.toLowerCase()),
    );

    return {
      slug: known.slug,
      name: known.name,
      active: installed
        ? installed.status === 'active' || installed.status === 'network-active'
        : false,
      capability: known.capability,
      description: known.description,
      version: installed?.version,
    };
  }).filter((p) => p.active || p.slug === 'enable-media-replace');
  // Always show Enable Media Replace status since it directly affects capabilities.
}
