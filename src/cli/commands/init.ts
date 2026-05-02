/**
 * `localpress init` — interactive setup wizard.
 *
 * Walks the user through:
 *   1. Site URL
 *   2. Username + Application Password
 *   3. Connection test (calls /wp-json/wp/v2/users/me)
 *   4. Capability detection report (same output as `localpress doctor`)
 *   5. Save to config file
 *
 * Supports both interactive (Ink) and non-interactive (flags) modes.
 */

import * as readline from 'node:readline';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import type { SiteConfig } from '../../types.ts';
import { loadConfig, saveConfig } from '../utils/config.ts';
import { error, info, warn } from '../utils/output.ts';

/** Prompt the user for a line of input. */
function prompt(question: string, mask = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    if (mask) {
      // For passwords: write the question, then suppress echo.
      process.stdout.write(question);
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);

      let value = '';
      const onData = (ch: Buffer) => {
        const c = ch.toString('utf8');
        if (c === '\n' || c === '\r') {
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolve(value);
        } else if (c === '\u0003') {
          // Ctrl+C
          rl.close();
          process.exit(130);
        } else if (c === '\u007F' || c === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          value += c;
          process.stdout.write('*');
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

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
      let siteUrl = options.url as string | undefined;
      let username = options.username as string | undefined;
      let appPassword = options.appPassword as string | undefined;
      let siteName = options.name as string | undefined;

      const isInteractive = !options.nonInteractive && process.stdin.isTTY;

      // Gather missing values interactively or fail.
      if (!siteUrl) {
        if (!isInteractive) {
          error('--url is required in non-interactive mode.');
          process.exit(2);
        }
        info('');
        info('  localpress — connect a WordPress site');
        info('  ─────────────────────────────────────');
        info('');
        siteUrl = await prompt('  Site URL: ');
        if (!siteUrl) {
          error('Site URL is required.');
          process.exit(2);
        }
      }

      // Normalize URL.
      if (!siteUrl.startsWith('http')) {
        siteUrl = `https://${siteUrl}`;
      }
      siteUrl = siteUrl.replace(/\/+$/, '');

      if (!siteName) {
        const defaultName = new URL(siteUrl).hostname;
        if (isInteractive) {
          const input = await prompt(`  Site name [${defaultName}]: `);
          siteName = input || defaultName;
        } else {
          siteName = defaultName;
        }
      }

      if (!username) {
        if (!isInteractive) {
          error('--username is required in non-interactive mode.');
          process.exit(2);
        }
        username = await prompt('  WordPress username: ');
        if (!username) {
          error('Username is required.');
          process.exit(2);
        }
      }

      if (!appPassword) {
        if (!isInteractive) {
          error('--app-password is required in non-interactive mode.');
          process.exit(2);
        }
        info('');
        info('  Application Passwords can be created at:');
        info(`  ${siteUrl}/wp-admin/profile.php`);
        info('');
        appPassword = await prompt('  Application Password: ', true);
        if (!appPassword) {
          error('Application Password is required.');
          process.exit(2);
        }
      }

      // Test the connection.
      info('');
      info(`  Testing connection to ${siteUrl}...`);

      const credentials = `${username}:${appPassword}`;
      const authHeader = `Basic ${btoa(credentials)}`;

      try {
        const response = await fetch(`${siteUrl}/wp-json/wp/v2/users/me`, {
          headers: { Authorization: authHeader },
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (response.status === 401) {
            error(
              'Authentication failed. Check your username and Application Password.\n' +
                'Application Passwords can be created at: ' +
                `${siteUrl}/wp-admin/profile.php`,
            );
          } else {
            error(
              `Connection test failed: ${response.status} ${response.statusText}\n${body.slice(0, 200)}`,
            );
          }
          process.exit(5);
        }

        const user = (await response.json()) as { name?: string; slug?: string };
        info(`  ✓ Authenticated as ${user.name ?? user.slug ?? username}`);
      } catch (err) {
        error(
          `Could not connect to ${siteUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(4);
      }

      // Save the site config.
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

      if (config.activeSite === siteName) {
        info(`  ✓ Set as active site.`);
      }

      // Show capability report.
      const resolver = new AdapterResolver(siteConfig);
      const availability = resolver.availability();
      const report = resolver.capabilityReport();

      info('');
      info('  Backend availability:');
      info(`    ${availability.rest ? '✓' : '✗'} REST API`);
      info(`    ${availability.wpCli ? '✓' : '✗'} WP-CLI (SSH)`);
      info(`    ${availability.mcp ? '✓' : '✗'} MCP`);

      if (!availability.wpCli) {
        info('');
        info(
          '  Tip: Without WP-CLI, image replacements will create new attachments.');
        info(
          '  Configure SSH access for true in-place replacement.');
        info(
          '  Run `localpress doctor` for the full capability matrix.',
        );
      }

      const unavailable = report.filter((r) => !r.preferredAdapter);
      if (unavailable.length > 0) {
        info('');
        info('  Unavailable capabilities (require WP-CLI or MCP):');
        for (const cap of unavailable) {
          info(`    ✗ ${cap.capability}`);
        }
      }

      info('');
      info('  Ready! Try `localpress list` to see your media library.');
    });
}
