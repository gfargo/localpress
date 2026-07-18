/**
 * Unit tests for WpCliAdapter.listMediaPage() pagination.
 *
 * Regression coverage for a parity bug where listMediaPage fabricated its
 * pagination (`total: items.length, totalPages: 1`), which stopped
 * paginating consumers after page 1 even when more pages existed. The fix
 * issues a `--format=count` query (scoped to the same filters, without the
 * pagination args) to compute a real total/totalPages.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as actualSsh from '../../src/adapters/ssh.ts';
import type { SshExecResult } from '../../src/adapters/ssh.ts';

const sshExecMock = mock<(ssh: unknown, command: string) => Promise<SshExecResult>>();

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

function fakePost(id: number) {
  return {
    ID: id,
    post_title: `Photo ${id}`,
    post_name: `photo-${id}`,
    post_mime_type: 'image/jpeg',
    post_date: '2026-01-01 00:00:00',
  };
}

describe('WpCliAdapter.listMediaPage()', () => {
  beforeEach(() => {
    sshExecMock.mockReset();
  });

  test('computes total/totalPages from a real count query when perPage is set', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('--format=count')) {
        expect(command).not.toContain('--posts_per_page');
        expect(command).not.toContain('--paged');
        return result('250');
      }
      if (command.includes('--fields=ID,post_title,post_name,post_mime_type,post_date')) {
        expect(command).toContain('--posts_per_page=100');
        expect(command).toContain('--paged=1');
        return result(JSON.stringify([fakePost(1), fakePost(2)]));
      }
      const getMatch = command.match(/post get (\d+)/);
      if (getMatch) {
        const post = fakePost(Number.parseInt(getMatch[1], 10));
        return result(
          JSON.stringify({ ...post, guid: `https://example.test/${post.post_name}.jpg` }),
        );
      }
      if (command.includes('post meta list')) {
        return result(JSON.stringify([]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const page = await adapter.listMediaPage({ perPage: 100, page: 1 });

    expect(page.total).toBe(250);
    expect(page.totalPages).toBe(3);
    expect(page.items).toHaveLength(2);
  });

  test('reports a single page when no perPage is given (WP-CLI returns the full set)', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('--format=count')) return result('42');
      if (command.includes('--fields=ID,post_title,post_name,post_mime_type,post_date')) {
        return result(JSON.stringify([fakePost(1)]));
      }
      if (command.includes('post get')) {
        const post = fakePost(1);
        return result(
          JSON.stringify({ ...post, guid: `https://example.test/${post.post_name}.jpg` }),
        );
      }
      if (command.includes('post meta list')) {
        return result(JSON.stringify([]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const page = await adapter.listMediaPage({});

    expect(page.total).toBe(42);
    expect(page.totalPages).toBe(1);
  });

  test('floors totalPages at 1 for an empty result set', async () => {
    sshExecMock.mockImplementation(async (_ssh: unknown, command: string) => {
      if (command.includes('--format=count')) return result('0');
      if (command.includes('--fields=ID,post_title,post_name,post_mime_type,post_date')) {
        return result(JSON.stringify([]));
      }
      throw new Error(`unexpected command: ${command}`);
    });

    const adapter = new WpCliAdapter(site);
    const page = await adapter.listMediaPage({ perPage: 50, page: 1 });

    expect(page.total).toBe(0);
    expect(page.totalPages).toBe(1);
  });
});
