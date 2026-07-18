/**
 * Unit tests for WpCliAdapter's shell command construction.
 *
 * WpCliAdapter shells out via `sshExec`/`scpUpload` (child_process under the
 * hood), so these tests mock `../../src/adapters/ssh.ts` and assert on the
 * exact command strings the adapter builds — rather than exercising a real
 * SSH connection. Every interpolated value must round-trip through
 * `shellQuote` (already unit-tested in ssh.test.ts) so commands built from
 * titles/paths/filenames containing `'`, `"`, `` ` ``, `$(...)`, or `;`
 * can't break or inject into the remote shell.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

interface FakeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

let sshCalls: string[] = [];
let scpCalls: Array<{ localPath: string; remotePath: string }> = [];
let failOn: ((command: string) => boolean) | null = null;
let attachmentMetadataOverride: string | null = null;
// Override for the bulk db query used by pruneOrphans to fetch all
// _wp_attachment_metadata rows.
let pruneMetadataRowsOverride: string | null = null;
// Override for the find command used by pruneOrphans to list files on disk.
let findFilesOverride: string | null = null;

function ok(stdout: string): FakeExecResult {
  return { stdout, stderr: '', exitCode: 0 };
}

// Canned WP-CLI responses good enough to drive the adapter's control flow
// without a real WordPress install. Deliberately includes a filename with an
// embedded apostrophe — the exact shape the ticket calls out (attachment
// titled "O'Brien's headshot").
function respond(command: string): FakeExecResult {
  if (command.includes('_wp_attached_file') && command.includes('post meta get')) {
    return ok("2024/01/O'Brien's headshot.png");
  }
  if (command.includes(`eval 'echo wp_upload_dir()`)) {
    return ok('/var/www/html/wp-content/uploads');
  }
  // pruneOrphans: find all files on disk (sshExec path).
  if (command.startsWith('find ') && findFilesOverride !== null) {
    return ok(findFilesOverride);
  }
  // pruneOrphans: bulk fetch of all _wp_attachment_metadata rows via db query.
  if (
    command.includes('db query') &&
    command.includes("meta_key='_wp_attachment_metadata'") &&
    pruneMetadataRowsOverride !== null
  ) {
    return ok(pruneMetadataRowsOverride);
  }
  if (
    command.includes('post meta get') &&
    command.includes('_wp_attachment_metadata --format=json')
  ) {
    return ok(
      attachmentMetadataOverride ??
        JSON.stringify({ file: "2024/01/O'Brien's headshot.png", sizes: {} }),
    );
  }
  if (command.includes('_wp_attachment_metadata --format=json 2>/dev/null')) {
    return ok('null');
  }
  if (command.includes('post meta list') && command.includes('_wp_attachment_metadata')) {
    return ok(
      JSON.stringify([{ meta_value: { file: "2024/01/O'Brien's headshot.png", sizes: {} } }]),
    );
  }
  if (command.includes('post meta list') && command.includes('_wp_attachment_image_alt')) {
    return ok('[]');
  }
  if (command.includes('_wp_attachment_image_alt 2>/dev/null')) {
    return ok('');
  }
  if (command.includes('media import')) {
    return ok('42');
  }
  if (
    command.includes('post get') &&
    command.includes('--fields=ID,post_title,post_name,post_mime_type,post_date,guid')
  ) {
    return ok(
      JSON.stringify({
        ID: 42,
        post_title: 'title',
        post_name: 'name',
        post_mime_type: 'image/webp',
        post_date: '2024-01-01',
        guid: 'https://example.test/wp-content/uploads/img.webp',
      }),
    );
  }
  if (command.includes('post list --post_type=attachment')) {
    return ok('[]');
  }
  return ok('');
}

// bun:test's mock.module() replaces the module for the whole test process
// (there is no per-file un-mock), so other files importing '../../src/adapters/ssh.ts'
// — namely ssh.test.ts — would otherwise see these fakes too. Import the real
// module first and pass its pure helpers (shellQuote/sshDestination/buildSshArgs/
// scpDownload) straight through unmodified; only sshExec/scpUpload are faked,
// which no other test file calls directly.
const real = await import('../../src/adapters/ssh.ts');

mock.module('../../src/adapters/ssh.ts', () => ({
  shellQuote: real.shellQuote,
  sshDestination: real.sshDestination,
  buildSshArgs: real.buildSshArgs,
  scpDownload: real.scpDownload,
  sshExec: async (_ssh: unknown, command: string) => {
    sshCalls.push(command);
    if (failOn?.(command)) {
      return { stdout: '', stderr: 'simulated failure', exitCode: 1 };
    }
    return respond(command);
  },
  scpUpload: async (_ssh: unknown, localPath: string, remotePath: string) => {
    scpCalls.push({ localPath, remotePath });
    return ok('');
  },
}));

const { shellQuote } = real;
const { WpCliAdapter } = await import('../../src/adapters/wp-cli.ts');

import { readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SiteConfig } from '../../src/types.ts';

const site: SiteConfig = {
  name: 'test-site',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
  ssh: {
    host: 'example.test',
    user: 'deploy',
    wpPath: '/var/www/html',
  },
};

beforeEach(() => {
  sshCalls = [];
  scpCalls = [];
  failOn = null;
  attachmentMetadataOverride = null;
  pruneMetadataRowsOverride = null;
  findFilesOverride = null;
});

afterEach(async () => {
  // Sweep any local temp files the adapter wrote but a failing test path left behind.
  const dir = tmpdir();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.startsWith('localpress-upload-') || name.startsWith('localpress-replace-')) {
      await unlink(join(dir, name)).catch(() => {});
    }
  }
});

describe('WpCliAdapter — cd quoting', () => {
  test('quotes wpPath in the cd for every wp() command', async () => {
    const spacedSite: SiteConfig = {
      ...site,
      ssh: { host: 'example.test', user: 'deploy', wpPath: '/var/www/my site; rm -rf ~' },
    };
    const adapter = new WpCliAdapter(spacedSite);
    await adapter.regenerateThumbnails(1);
    expect(
      sshCalls.some((c) => c.includes(`cd ${shellQuote('/var/www/my site; rm -rf ~')} &&`)),
    ).toBe(true);
    // Never interpolated unescaped.
    expect(sshCalls.some((c) => c.includes('cd /var/www/my site'))).toBe(false);
  });
});

describe('WpCliAdapter#upload', () => {
  test('shell-quotes title/alt/caption/description', async () => {
    const adapter = new WpCliAdapter(site);
    const metadata = {
      filename: 'photo.png',
      title: `O'Brien's "headshot"`,
      altText: 'a `whoami` b',
      caption: '$(rm -rf /)',
      description: 'desc; rm -rf ~',
    };
    await adapter.upload(Buffer.from('data'), metadata);

    const importCall = sshCalls.find((c) => c.includes('media import'));
    expect(importCall).toBeDefined();
    expect(importCall).toContain(`--title=${shellQuote(metadata.title)}`);
    expect(importCall).toContain(`--alt=${shellQuote(metadata.altText)}`);
    expect(importCall).toContain(`--caption=${shellQuote(metadata.caption)}`);
    expect(importCall).toContain(`--description=${shellQuote(metadata.description)}`);
  });

  test('generates unique, uuid-bearing temp paths per call', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.upload(Buffer.from('a'), { filename: 'a.png' });
    await adapter.upload(Buffer.from('b'), { filename: 'b.png' });

    expect(scpCalls).toHaveLength(2);
    expect(scpCalls[0].remotePath).not.toBe(scpCalls[1].remotePath);
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
    expect(scpCalls[0].remotePath).toMatch(uuidRe);
    expect(scpCalls[1].remotePath).toMatch(uuidRe);
  });

  test('cleans up the remote temp file even when media import fails', async () => {
    failOn = (c) => c.includes('media import');
    const adapter = new WpCliAdapter(site);
    await expect(adapter.upload(Buffer.from('data'), { filename: 'photo.png' })).rejects.toThrow();

    const remoteTmp = scpCalls[0].remotePath;
    expect(sshCalls.some((c) => c === `rm -f ${shellQuote(remoteTmp)}`)).toBe(true);
  });

  test('sanitizes filenames with spaces or shell metacharacters in the scp remote path', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.upload(Buffer.from('a'), { filename: 'my photo.png' });
    await adapter.upload(Buffer.from('b'), { filename: '$(id).png' });
    await adapter.upload(Buffer.from('c'), { filename: '`whoami`.png' });

    expect(scpCalls).toHaveLength(3);
    for (const call of scpCalls) {
      expect(call.remotePath).toMatch(/^\/tmp\/localpress-upload-[A-Za-z0-9._-]+$/);
      expect(call.remotePath).not.toMatch(/\s|[$`;]/);
    }
  });
});

describe('WpCliAdapter#replaceInPlace', () => {
  test('shell-quotes every remote path, including filenames with apostrophes', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.replaceInPlace(7, Buffer.from('bytes'), {
      newExtension: '.webp',
      newMimeType: 'image/webp',
    });

    const newPath = "/var/www/html/wp-content/uploads/2024/01/O'Brien's headshot.webp";
    const oldPath = "/var/www/html/wp-content/uploads/2024/01/O'Brien's headshot.png";

    expect(
      sshCalls.some((c) => c.includes(`mkdir -p ${shellQuote(newPath.replace(/\/[^/]+$/, ''))}`)),
    ).toBe(true);
    expect(
      sshCalls.some(
        (c) => c.includes('mv ') && c.includes(shellQuote(newPath)) && c.includes('chmod 644'),
      ),
    ).toBe(true);
    expect(sshCalls.some((c) => c === `rm -f ${shellQuote(oldPath)}`)).toBe(true);
    expect(
      sshCalls.some((c) =>
        c.includes(`_wp_attached_file ${shellQuote("2024/01/O'Brien's headshot.webp")}`),
      ),
    ).toBe(true);
    expect(sshCalls.some((c) => c.includes(`--post_mime_type=${shellQuote('image/webp')}`))).toBe(
      true,
    );
  });

  test('correctly escapes the _wp_attachment_metadata JSON update (the reported bug)', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.replaceInPlace(7, Buffer.from('0123456789'), {
      newExtension: '.webp',
    });

    const expectedMeta = {
      file: "2024/01/O'Brien's headshot.webp",
      sizes: {},
      filesize: 10,
    };
    const expectedCommand = `_wp_attachment_metadata ${shellQuote(JSON.stringify(expectedMeta))} --format=json`;

    const metaUpdateCall = sshCalls.find(
      (c) => c.includes('post meta update') && c.includes('_wp_attachment_metadata'),
    );
    expect(metaUpdateCall).toBeDefined();
    // The old, broken implementation escaped embedded quotes via
    // `.replace(/'/g, "\\'")`, which produces `\'` — invalid inside a
    // single-quoted POSIX string (the shell just closes the quote early).
    // shellQuote's `'\''` idiom is the only thing that round-trips correctly,
    // so an exact match here proves the fix, not just "some escaping happened".
    expect(metaUpdateCall).toContain(expectedCommand);
  });

  test('propagates a genuine failure updating _wp_attachment_metadata instead of swallowing it', async () => {
    failOn = (c) => c.includes('post meta update') && c.includes('_wp_attachment_metadata');
    const adapter = new WpCliAdapter(site);

    await expect(
      adapter.replaceInPlace(7, Buffer.from('bytes'), { newExtension: '.webp' }),
    ).rejects.toThrow();
  });

  test('tolerates a missing/unparseable _wp_attachment_metadata as non-fatal', async () => {
    attachmentMetadataOverride = '';
    const adapter = new WpCliAdapter(site);

    await expect(
      adapter.replaceInPlace(7, Buffer.from('bytes'), { newExtension: '.webp' }),
    ).resolves.toBeDefined();

    // No metadata to update from, so no _wp_attachment_metadata update call was made.
    expect(
      sshCalls.some((c) => c.includes('post meta update') && c.includes('_wp_attachment_metadata')),
    ).toBe(false);
  });

  test('generates unique, uuid-bearing temp paths per call', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.replaceInPlace(1, Buffer.from('a'));
    await adapter.replaceInPlace(1, Buffer.from('b'));

    expect(scpCalls).toHaveLength(2);
    expect(scpCalls[0].remotePath).not.toBe(scpCalls[1].remotePath);
  });
});

describe('WpCliAdapter#updateMetadata', () => {
  test('shell-quotes title/altText/caption/description', async () => {
    const adapter = new WpCliAdapter(site);
    const metadata = {
      title: `It's a "test"`,
      altText: '`whoami`',
      caption: '$(id)',
      description: '; ls -la',
    };
    await adapter.updateMetadata(3, metadata);

    expect(sshCalls.some((c) => c.includes(`--post_title=${shellQuote(metadata.title)}`))).toBe(
      true,
    );
    expect(
      sshCalls.some((c) => c.includes(`_wp_attachment_image_alt ${shellQuote(metadata.altText)}`)),
    ).toBe(true);
    expect(sshCalls.some((c) => c.includes(`--post_excerpt=${shellQuote(metadata.caption)}`))).toBe(
      true,
    );
    expect(
      sshCalls.some((c) => c.includes(`--post_content=${shellQuote(metadata.description)}`)),
    ).toBe(true);
  });
});

describe('WpCliAdapter#pruneOrphans', () => {
  test('groups the extension alternation so -type f applies to every branch', async () => {
    const adapter = new WpCliAdapter(site);
    await adapter.pruneOrphans();

    const findCall = sshCalls.find((c) => c.startsWith('find '));
    expect(findCall).toBeDefined();
    expect(findCall).toContain(
      `find ${shellQuote('/var/www/html/wp-content/uploads')} -type f \\(`,
    );
    expect(findCall).toMatch(/-type f \\\( -name '\*\.jpg' -o -name/);
    expect(findCall).toContain('\\)');
  });

  test('does not report the original_image as an orphan when WP scaled the upload', async () => {
    // WordPress big-image threshold scenario:
    //   _wp_attached_file  → "2024/06/photo-scaled.jpg"  (the scaled-down version)
    //   _wp_attachment_metadata.original_image → "photo.jpg"  (the untouched original,
    //     stored in the same 2024/06/ directory and referenced nowhere else in the DB)
    //
    // Both files exist on disk.  Before the fix, photo.jpg was NOT in registeredFiles
    // and therefore surfaced as an orphan — acting on the report deletes the original.
    const uploadsBase = '/var/www/html/wp-content/uploads';
    const scaledFile = '2024/06/photo-scaled.jpg';
    const originalFile = 'photo.jpg'; // original_image basename (same dir)
    const originalFullPath = `${uploadsBase}/2024/06/${originalFile}`;
    const scaledFullPath = `${uploadsBase}/${scaledFile}`;

    // Simulate the two files that exist on disk.
    findFilesOverride = [scaledFullPath, originalFullPath].join('\n');

    // Simulate the _wp_attached_file DB row pointing at the scaled version.
    // (The respond() mock's db query for _wp_attached_file returns '' by default;
    // we inject it via the bulk metadata approach instead — the attached-file query
    // returns empty, but the attachment-metadata query gives us everything we need
    // to register both paths.)
    //
    // Simulate the _wp_attachment_metadata DB row that carries original_image.
    pruneMetadataRowsOverride = JSON.stringify({
      file: scaledFile,
      sizes: {},
      original_image: originalFile,
    });

    const adapter = new WpCliAdapter(site);
    const result = await adapter.pruneOrphans();

    // The original full-resolution file must NOT be in the orphan list.
    expect(result.orphanFiles).not.toContain(originalFullPath);
    // The scaled file is registered via _wp_attached_file (empty in this mock,
    // but it still appears in registeredFiles via metadata.file), so it should
    // not be an orphan either if it came through.
    // The critical assertion: no orphan reported for the original.
    expect(result.orphanFiles.every((f) => f !== originalFullPath)).toBe(true);
  });
});
