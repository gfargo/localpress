/**
 * Regression test for OSS-1338 / localpress#283 (preview-apply path): after
 * `optimize --preview` applies a resize, `onApply` re-fetches the attachment
 * from WordPress to build UI metadata. That network call can fail
 * independently of the replace-in-place, which already committed the new
 * dimensions. Before this fix, a failed re-fetch made `recordSuccess` fall
 * back to `item.width`/`item.height` — the pre-processing dimensions — which
 * reintroduces the exact "verify reports permanent width/height drift" bug
 * this issue is about, just in the preview path instead of the bulk path.
 *
 * Fixed by threading the engine's own post-processing dimensions (computed
 * locally during `onProcess`, mirroring the non-preview path's
 * `result.after`) through to `onApply` via `lastStats`, so the recorded
 * width/height never depends on the post-apply re-fetch succeeding.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { RestAdapter } from '../../src/adapters/rest.ts';
import type { Capability, MediaItem, ReplaceOptions } from '../../src/adapters/types.ts';
import { registerOptimizeCommand } from '../../src/cli/commands/optimize.ts';
import { getSiteDbPath, saveConfig } from '../../src/cli/utils/config.ts';
import { SiteDb } from '../../src/engine/state/db.ts';

const realChildProcess = await import('node:child_process');

const capturedUrlBox: { value: string | null } = { value: null };

// bun:test's mock.module() replaces the module for the whole test process, so
// spread the real module through and only override spawn (see
// preview-server.test.ts for the same pattern).
mock.module('node:child_process', () => ({
  ...realChildProcess,
  spawn: (_cmd: string, args: string[]) => {
    capturedUrlBox.value = args[args.length - 1] ?? null;
    return { on: () => {}, unref: () => {} };
  },
}));

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
let mediaFetchCount: number;

beforeEach(async () => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalFetch = globalThis.fetch;
  originalReplaceInPlace = RestAdapter.prototype.replaceInPlace;
  tmpDir = mkdtempSync(join(tmpdir(), 'localpress-preview-apply-dims-test-'));
  process.env.XDG_CONFIG_HOME = tmpDir;
  mediaFetchCount = 0;

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

  const probe = new RestAdapter({
    name: SITE_NAME,
    url: 'https://example.test',
    username: 'admin',
    appPassword: 'app-password',
    createdAt: new Date(0).toISOString(),
  });
  (probe.capabilities as unknown as Set<Capability>).add('replace-in-place');
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

describe('optimize --preview apply path', () => {
  test('records post-processing width/height even when the post-apply WP re-fetch fails', async () => {
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
        mediaFetchCount++;
        // First call: the initial fetch that primes the preview. Any later
        // call is the post-apply re-fetch inside `onApply` — fail it to
        // simulate the network hiccup this test guards against.
        if (mediaFetchCount > 1) {
          throw new Error('simulated network failure on post-apply re-fetch');
        }
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

    RestAdapter.prototype.replaceInPlace = async (
      _id: number,
      file: Buffer,
      options?: ReplaceOptions,
    ): Promise<MediaItem> => {
      remote = { mimeType: options?.newMimeType ?? remote.mimeType, bytes: file };
      const resized = await sharp(file).metadata();
      return {
        id: WP_ID,
        title: 'Photo',
        filename: 'photo.jpg',
        url: SOURCE_URL,
        mimeType: remote.mimeType,
        width: resized.width ?? 0,
        height: resized.height ?? 0,
        sizeBytes: file.length,
        uploadedAt: new Date(0).toISOString(),
      };
    };

    const exitSpy = spyOn(process, 'exit').mockImplementation(() => undefined as never);
    capturedUrlBox.value = null;

    try {
      const optimizeProgram = buildProgram();
      registerOptimizeCommand(optimizeProgram);
      const runPromise = optimizeProgram.parseAsync(['optimize', String(WP_ID), '--preview'], {
        from: 'user',
      });

      for (let i = 0; i < 200 && !capturedUrlBox.value; i++) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (!capturedUrlBox.value) {
        throw new Error('preview server did not open a browser URL in time');
      }

      const [base, token] = (capturedUrlBox.value as string).split('#');
      const { port } = new URL(base);

      // Drive the preview UI's flow using the real fetch (globalThis.fetch is
      // mocked above to simulate the WordPress API, not this local server).
      const processRes = await originalFetch(`http://127.0.0.1:${port}/api/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Preview-Token': token ?? '' },
        body: JSON.stringify({ maxWidth: 100 }),
      });
      expect(processRes.status).toBe(200);

      const applyRes = await originalFetch(`http://127.0.0.1:${port}/api/apply`, {
        method: 'POST',
        headers: { 'X-Preview-Token': token ?? '' },
      });
      expect(applyRes.status).toBe(200);

      await runPromise;

      // The post-apply re-fetch failed (mediaFetchCount > 1 throws), so if
      // recordSuccess still fell back to `item.width`/`item.height` (200x200),
      // this would regress back to the original bug.
      const db = SiteDb.init(getSiteDbPath(SITE_NAME));
      const record = db.getAttachment(SITE_NAME, WP_ID);
      db.close();
      expect(record).not.toBeNull();
      expect(record?.width).toBe(100);
      expect(record?.height).toBe(100);
    } finally {
      exitSpy.mockRestore();
    }
  });
});
