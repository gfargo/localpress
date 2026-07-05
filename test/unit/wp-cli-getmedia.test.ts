/**
 * Unit tests for WpCliAdapter.getMedia() meta-fetching behavior.
 *
 * Verifies that a genuinely-absent meta key (WP-CLI exits 0 with an empty
 * result) is distinguished from a real WP-CLI/SSH failure (non-zero exit),
 * which must propagate rather than silently read as "no alt text" / "no
 * metadata". Regression coverage for the `|| echo` shim removal.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as actualSsh from '../../src/adapters/ssh.ts';
import type { SshExecResult } from '../../src/adapters/ssh.ts';

const sshExecMock = mock<(ssh: unknown, command: string) => Promise<SshExecResult>>();

// Preserve every real export (sshDestination, buildSshArgs, shellQuote, ...) so
// other test files that import ssh.ts still see the genuine implementations —
// only sshExec is swapped for the mock, since it's the one making real SSH calls.
mock.module('../../src/adapters/ssh.ts', () => ({
  ...actualSsh,
  sshExec: sshExecMock,
}));

afterAll(() => {
  mock.module('../../src/adapters/ssh.ts', () => actualSsh);
});

const { WpCliAdapter } = await import('../../src/adapters/wp-cli.ts');
import type { SiteConfig } from '../../src/types.ts';

const site: SiteConfig = {
  name: 'test-wp-cli',
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

function result(stdout: string, exitCode = 0, stderr = ''): SshExecResult {
  return { stdout, stderr, exitCode };
}

function postGetOutput(id: number) {
  return JSON.stringify({
    ID: id,
    post_title: `Photo ${id}`,
    post_name: `photo-${id}`,
    post_mime_type: 'image/jpeg',
    post_date: '2026-01-01 00:00:00',
    guid: `https://example.test/wp-content/uploads/photo-${id}.jpg`,
  });
}

describe('WpCliAdapter.getMedia()', () => {
  beforeEach(() => {
    sshExecMock.mockReset();
  });

  test('returns populated altText and metadata when both meta keys are present', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('post get')) return result(postGetOutput(1));
      if (command.includes('--keys=_wp_attachment_metadata')) {
        return result(
          JSON.stringify([
            {
              meta_value: { width: 800, height: 600, file: '2026/01/photo-1.jpg', filesize: 12345 },
            },
          ]),
        );
      }
      if (command.includes('--keys=_wp_attachment_image_alt')) {
        return result(JSON.stringify([{ meta_value: 'A scenic photo' }]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const media = await adapter.getMedia(1);

    expect(media.altText).toBe('A scenic photo');
    expect(media.width).toBe(800);
    expect(media.height).toBe(600);
    expect(media.sizeBytes).toBe(12345);
    expect(media.filename).toBe('2026/01/photo-1.jpg');
  });

  test('returns undefined altText when the alt meta key is legitimately absent (exit 0, empty array)', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('post get')) return result(postGetOutput(2));
      if (command.includes('--keys=_wp_attachment_metadata')) {
        return result(JSON.stringify([{ meta_value: { width: 100, height: 100 } }]));
      }
      if (command.includes('--keys=_wp_attachment_image_alt')) {
        return result(JSON.stringify([]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const media = await adapter.getMedia(2);

    expect(media.altText).toBeUndefined();
  });

  test('returns null metadata and falls back to post_name when the metadata key is absent (e.g. non-image attachment)', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('post get')) return result(postGetOutput(3));
      if (command.includes('--keys=_wp_attachment_metadata')) {
        return result(JSON.stringify([]));
      }
      if (command.includes('--keys=_wp_attachment_image_alt')) {
        return result(JSON.stringify([]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const media = await adapter.getMedia(3);

    expect(media.width).toBeUndefined();
    expect(media.sizeBytes).toBeUndefined();
    expect(media.filename).toBe('photo-3');
  });

  test('throws when a meta fetch fails (non-zero exit), instead of silently returning empty values', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('post get')) return result(postGetOutput(4));
      if (command.includes('--keys=_wp_attachment_metadata')) {
        return result('', 1, 'wp-cli: transient database error');
      }
      if (command.includes('--keys=_wp_attachment_image_alt')) {
        return result(JSON.stringify([{ meta_value: 'should not be reached' }]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);

    await expect(adapter.getMedia(4)).rejects.toThrow(/transient database error/);
  });
});
