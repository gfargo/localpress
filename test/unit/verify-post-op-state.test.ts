/**
 * Regression test for OSS-922 / localpress#196: `verify` reported false
 * drift for every attachment `optimize`/`convert`/`resize`/`remove-bg` had
 * just replaced in place, because the `attachments` table recorded the
 * *pre-processing* size/hash/mimeType instead of the actual live (post-op)
 * state. Fixed by having each replace-in-place write path record the
 * post-op state instead.
 *
 * This exercises the real `optimize` command end-to-end (with the REST
 * adapter's replace-in-place capability faked in, since REST alone can't
 * replace file bytes) against a fake WordPress, then runs `verify` against
 * the same fake WordPress state and asserts no drift is reported.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { RestAdapter } from '../../src/adapters/rest.ts';
import type { Capability, MediaItem, ReplaceOptions } from '../../src/adapters/types.ts';
import { registerOptimizeCommand } from '../../src/cli/commands/optimize.ts';
import { registerVerifyCommand } from '../../src/cli/commands/verify.ts';
import { getSiteDbPath, saveConfig } from '../../src/cli/utils/config.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

const SITE_NAME = 'testsite';
const WP_ID = 42;
const SOURCE_URL = 'https://example.test/wp-content/uploads/photo.jpg';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('localpress')
    .exitOverride()
    .addOption(new Option('--site <name>', 'override the active site for this command'))
    .addOption(new Option('--json', 'machine-readable JSON output').default(false))
    .addOption(new Option('--quiet', 'errors only; suppress info messages').default(true))
    .addOption(new Option('--dry-run', 'show what would happen without executing').default(false))
    .addOption(new Option('--apply', 'opt out of dry-run for bulk ops').default(false))
    .addOption(new Option('--yes', 'skip confirmation prompts').default(true))
    .addOption(
      new Option('--strict', 'fail loudly when capability fallbacks would activate').default(false),
    );
  return program;
}

let originalXdgConfigHome: string | undefined;
let originalFetch: typeof fetch;
let originalReplaceInPlace: typeof RestAdapter.prototype.replaceInPlace;
let tmpDir: string;

// Mutable "remote WordPress" state — the fake replaceInPlace mutates this,
// and the fetch mock reads from it, simulating a real round-trip.
let remote: { mimeType: string; bytes: Buffer };

beforeEach(async () => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalFetch = globalThis.fetch;
  originalReplaceInPlace = RestAdapter.prototype.replaceInPlace;
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-verify-post-op-test-'));
  process.env.XDG_CONFIG_HOME = tmpDir;

  await saveConfig({
    version: 1,
    activeSite: SITE_NAME,
    sites: {
      [SITE_NAME]: {
        name: SITE_NAME,
        url: 'https://example.test',
        username: 'admin',
        appPassword: 'app-password',
        createdAt: new Date(0).toISOString(),
      },
    },
  });

  // REST genuinely can't replace file bytes, but this test exercises the
  // replace-in-place write path (the one the bug lived in) — fake both the
  // capability and the write so a plain REST-configured site can exercise it.
  // `capabilities` is a shared module-level Set — mutating it via any
  // instance affects every RestAdapter, including the ones the commands
  // construct internally.
  const probe = new RestAdapter({
    name: SITE_NAME,
    url: 'https://example.test',
    username: 'admin',
    appPassword: 'app-password',
    createdAt: new Date(0).toISOString(),
  });
  (probe.capabilities as unknown as Set<Capability>).add('replace-in-place');
  RestAdapter.prototype.replaceInPlace = async (
    _id: number,
    file: Buffer,
    options?: ReplaceOptions,
  ): Promise<MediaItem> => {
    remote = { mimeType: options?.newMimeType ?? remote.mimeType, bytes: file };
    return {
      id: WP_ID,
      title: 'Photo',
      filename: 'photo.jpg',
      url: SOURCE_URL,
      mimeType: remote.mimeType,
      width: 200,
      height: 200,
      sizeBytes: file.length,
      uploadedAt: new Date(0).toISOString(),
    };
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  RestAdapter.prototype.replaceInPlace = originalReplaceInPlace;
  const probe = new RestAdapter({
    name: SITE_NAME,
    url: 'https://example.test',
    username: 'admin',
    appPassword: 'app-password',
    createdAt: new Date(0).toISOString(),
  });
  (probe.capabilities as unknown as Set<Capability>).delete('replace-in-place');
  if (originalXdgConfigHome === undefined) {
    // biome-ignore lint/performance/noDelete: env var must be truly absent, not the string "undefined"
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('optimize (replace-in-place) then verify', () => {
  test('verify reports no drift against the post-optimize state', async () => {
    const sharp = (await import('sharp')).default;
    const sourceBytes = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .jpeg({ quality: 95 })
      .toBuffer();

    remote = { mimeType: 'image/jpeg', bytes: sourceBytes };

    globalThis.fetch = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes(`/wp-json/wp/v2/media/${WP_ID}`)) {
        return Response.json({
          id: WP_ID,
          title: { rendered: 'Photo', raw: 'Photo' },
          source_url: SOURCE_URL,
          mime_type: remote.mimeType,
          media_details: {
            width: 200,
            height: 200,
            file: 'photo.jpg',
            filesize: remote.bytes.length,
          },
          alt_text: '',
          caption: { rendered: '', raw: '' },
          description: { rendered: '', raw: '' },
          date: new Date(0).toISOString(),
          slug: 'photo',
        });
      }
      if (url === SOURCE_URL) {
        return new Response(remote.bytes, { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    }) as typeof fetch;

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);

    try {
      // Force a real format change so the write path is unambiguously exercised
      // (and so a stale pre-op mimeType would be caught even if sizes happened
      // to land within verify's byte-drift tolerance).
      const optimizeProgram = buildProgram();
      registerOptimizeCommand(optimizeProgram);
      await optimizeProgram.parseAsync(['optimize', String(WP_ID), '--to', 'webp'], {
        from: 'user',
      });

      // The attachments table must now reflect the live (post-optimize) file,
      // not the pre-optimize jpeg — this is the actual bug fix.
      const db = SiteDb.init(getSiteDbPath(SITE_NAME));
      const record = db.getAttachment(SITE_NAME, WP_ID);
      db.close();
      expect(record).not.toBeNull();
      expect(record?.mimeType).toBe('image/webp');
      expect(record?.sizeBytes).toBe(remote.bytes.length);
      expect(record?.sizeBytes).not.toBe(sourceBytes.length);

      const verifyProgram = buildProgram();
      registerVerifyCommand(verifyProgram);
      await verifyProgram.parseAsync(['verify', String(WP_ID), '--hash'], { from: 'user' });

      // verify.ts exits 1 on drift/mismatch/missing — it must not have.
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
