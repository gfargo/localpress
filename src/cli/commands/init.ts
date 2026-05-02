/**
 * `localpress init` — interactive setup wizard.
 *
 * Two modes:
 *   - Interactive (default): Ink-rendered wizard with step-by-step prompts,
 *     masked password input, connection test, and capability report.
 *   - Non-interactive (--non-interactive or piped stdin): requires all
 *     values via flags, fails if any are missing.
 *
 * Flags can pre-fill values in either mode, skipping those prompts.
 */

import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { SiteConfig } from '../../types.ts';
import { loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, warn } from '../utils/output.ts';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Connect a WordPress site (interactive wizard)')
    .option('--name <name>', 'name for this site (skip the prompt)')
    .option('--url <url>', 'WordPress site URL (skip the prompt)')
    .option('--username <user>', 'WordPress username')
    .option('--app-password <password>', 'WordPress Application Password')
    .option('--non-interactive', 'fail instead of prompting (for scripts)')
    .action(async (options) => {
      const isInteractive = !options.nonInteractive && process.stdin.isTTY;

      // Try Ink wizard for interactive mode.
      if (isInteractive && !options.url) {
        try {
          const { render } = await import('ink');
          const React = await import('react');
          const { InitWizard } = await import('../components/InitWizard.tsx');

          const { waitUntilExit } = render(
            React.createElement(InitWizard, {
              initialUrl: options.url,
              initialName: options.name,
              initialUsername: options.username,
              initialPassword: options.appPassword,
            }),
          );

          await waitUntilExit();
          return;
        } catch {
          // Ink rendering failed (e.g. missing deps, CI environment).
          // Fall through to the non-interactive path.
        }
      }

      // Non-interactive path (flags required).
      let siteUrl = options.url as string | undefined;
      let username = options.username as string | undefined;
      let appPassword = options.appPassword as string | undefined;
      let siteName = options.name as string | undefined;

      if (!siteUrl || !username || !appPassword) {
        error(
          'Missing required flags for non-interactive mode.\n' +
            'Usage: localpress init --url https://yoursite.com --username admin --app-password "xxxx xxxx xxxx xxxx xxxx xxxx"\n' +
            '\nRun without flags for the interactive wizard.',
        );
        process.exit(2);
      }

      // Normalize URL.
      if (!siteUrl.startsWith('http')) {
        siteUrl = `https://${siteUrl}`;
      }
      siteUrl = siteUrl.replace(/\/+$/, '');

      if (!siteName) {
        siteName = new URL(siteUrl).hostname;
      }

      // Test the connection.
      info(`Testing connection to ${siteUrl}...`);

      const credentials = `${username}:${appPassword}`;
      const authHeader = `Basic ${btoa(credentials)}`;

      try {
        const response = await fetch(`${siteUrl}/wp-json/wp/v2/users/me`, {
          headers: { Authorization: authHeader },
        });

        if (!response.ok) {
          if (response.status === 401) {
            error(
              'Authentication failed. Check your username and Application Password.\n' +
                `Application Passwords: ${siteUrl}/wp-admin/profile.php`,
            );
          } else {
            error(`Connection failed: ${response.status} ${response.statusText}`);
          }
          process.exit(5);
        }

        const user = (await response.json()) as { name?: string; slug?: string };
        info(`  ✓ Authenticated as ${user.name ?? user.slug ?? username}`);
      } catch (err) {
        error(`Could not connect to ${siteUrl}: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(4);
      }

      // Save config.
      const config = await loadConfig();

      if (config.sites[siteName]) {
        warn(`Site '${siteName}' already exists and will be updated.`);
      }

      const siteConfig: SiteConfig = {
        name: siteName,
        url: siteUrl,
        username,
        appPassword,
        createdAt: new Date().toISOString(),
      };

      config.sites[siteName] = siteConfig;
      if (!config.activeSite) {
        config.activeSite = siteName;
      }

      await saveConfig(config);
      info(`  ✓ Site '${siteName}' saved.`);

      // Show capability report.
      const resolver = new AdapterResolver(siteConfig);
      const availability = resolver.availability();
      const report = resolver.capabilityReport();

      info('');
      info('Backend availability:');
      info(`  ${availability.rest ? '✓' : '✗'} REST API`);
      info(`  ${availability.wpCli ? '✓' : '✗'} WP-CLI (SSH)`);
      info(`  ${availability.mcp ? '✓' : '✗'} MCP`);

      const unavailable = report.filter((r) => !r.preferredAdapter);
      if (unavailable.length > 0) {
        info('');
        info('Unavailable capabilities (require WP-CLI or MCP):');
        for (const cap of unavailable) {
          info(`  ✗ ${cap.capability}`);
        }
      }

      if (!availability.wpCli) {
        info('');
        info('Tip: Configure SSH for WP-CLI to unlock all capabilities.');
      }

      info('\nReady! Try `localpress list` to see your media library.');
    });
}
