/**
 * `localpress push <path> [--replace <id>]` — upload a local file as a new
 * attachment, or as a replacement for an existing one.
 *
 * The replacement-with-fallback logic is shared with `optimize`: if true
 * in-place replacement isn't available, falls back to creating a new
 * attachment and surfaces a references report (unless --strict).
 */

import { basename } from 'node:path';
import type { Command } from 'commander';
import { AdapterResolver } from '../../adapters/resolver.ts';
import { CapabilityUnavailableError } from '../../adapters/types.ts';
import { parseIntOption } from '../utils/args.ts';
import { loadConfig, resolveActiveSite } from '../utils/config.ts';
import { error, info, printJson, warn } from '../utils/output.ts';

export function registerPushCommand(program: Command): void {
  program
    .command('push <path>')
    .description('Upload a local file to the media library')
    .option(
      '--replace <id>',
      'replace this attachment instead of creating a new one',
      parseIntOption('--replace'),
    )
    .option('--title <title>', 'attachment title')
    .option('--alt <text>', 'alt text')
    .option('--caption <text>', 'caption')
    .option('--description <text>', 'description')
    .option('--post <id>', 'attach to this post', parseIntOption('--post'))
    .action(async (filePath: string, options) => {
      const parentOpts = program.opts();
      const config = await loadConfig();
      const site = resolveActiveSite(config, parentOpts.site);
      const resolver = new AdapterResolver(site);

      // Read the local file.
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        error(`File not found: ${filePath}`);
        process.exit(2);
      }
      const fileBuffer = Buffer.from(await file.arrayBuffer());
      const filename = basename(filePath);

      if (options.replace !== undefined) {
        // Attempt replace-in-place.
        const replaceAdapter = resolver.tryResolve('replace-in-place');

        if (replaceAdapter) {
          try {
            const result = await replaceAdapter.replaceInPlace(options.replace, fileBuffer);
            if (parentOpts.json) {
              printJson({ action: 'replaced', attachment: result });
            } else {
              info(`✓ Replaced attachment #${options.replace} in place.`);
            }
            return;
          } catch (err) {
            if (!(err instanceof CapabilityUnavailableError)) throw err;
            // Fall through to fallback.
          }
        }

        // Fallback: upload as new attachment.
        if (parentOpts.strict) {
          error(
            `True in-place replacement is not available for site '${site.name}'. Configure SSH for WP-CLI access, or remove --strict to allow fallback.`,
          );
          process.exit(6);
        }

        warn(
          `In-place replacement not available. Uploading as a new attachment. Run \`localpress references ${options.replace}\` to see where the old attachment is used.`,
        );
      }

      // Upload as new attachment.
      const uploadAdapter = resolver.resolve('upload');
      try {
        const result = await uploadAdapter.upload(fileBuffer, {
          filename,
          title: options.title,
          altText: options.alt,
          caption: options.caption,
          description: options.description,
          postId: options.post,
        });

        if (parentOpts.json) {
          printJson({
            action: options.replace ? 'uploaded-as-new' : 'uploaded',
            attachment: result,
            replacedId: options.replace ?? null,
          });
        } else {
          info(`✓ Uploaded as attachment #${result.id} (${filename}).`);
          if (options.replace) {
            info(`  ⚠ This is a new attachment, not a replacement of #${options.replace}.`);
            info(
              `  Run \`localpress references ${options.replace} --update-to ${result.id}\` to rewrite references (v0.5).`,
            );
          }
        }
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exit(4);
      }
    });
}
