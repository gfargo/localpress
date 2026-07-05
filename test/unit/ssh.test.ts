/**
 * Unit tests for SSH adapter helpers and WP-CLI availability detection.
 *
 * These tests verify:
 * - sshDestination() builds correct user@host strings
 * - buildSshArgs() produces correct SSH command arguments
 * - isWpCliAvailableForSite() correctly gates on required fields
 * - AdapterResolver behavior with various SSH config shapes
 */

import { describe, expect, test } from 'bun:test';

import { AdapterResolver } from '../../src/adapters/resolver.ts';
import { buildSshArgs, shellQuote, sshDestination } from '../../src/adapters/ssh.ts';
import { isWpCliAvailableForSite } from '../../src/adapters/wp-cli.ts';
import type { SiteConfig, SshConfig } from '../../src/types.ts';

// -- shellQuote ---------------------------------------------------------------

// Parses a single POSIX single-quoted shell "word" back into its raw value,
// mirroring what a real shell would do — used to assert shellQuote() output
// round-trips through an actual shell without executing anything.
function parseSingleQuotedWord(word: string): string {
  let result = '';
  let i = 0;
  while (i < word.length) {
    if (word[i] === "'") {
      const end = word.indexOf("'", i + 1);
      result += word.slice(i + 1, end);
      i = end + 1;
    } else if (word.startsWith("\\'", i)) {
      result += "'";
      i += 2;
    } else {
      result += word[i];
      i += 1;
    }
  }
  return result;
}

describe('shellQuote', () => {
  test('wraps a plain value in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  test('round-trips values containing single quotes', () => {
    const value = "O'Brien's headshot";
    expect(parseSingleQuotedWord(shellQuote(value))).toBe(value);
  });

  test('round-trips shell metacharacters without executing them', () => {
    const dangerous = [
      '$(rm -rf /)',
      '`echo pwned`',
      '; rm -rf ~',
      '"double quotes"',
      '\\backslash\\',
      'newline\ntext',
      '/tmp; rm -rf ~',
    ];
    for (const value of dangerous) {
      expect(parseSingleQuotedWord(shellQuote(value))).toBe(value);
    }
  });

  test('round-trips a JSON payload with embedded quotes', () => {
    const meta = { title: "O'Brien's headshot", note: 'says "hi"' };
    const json = JSON.stringify(meta);
    const quoted = shellQuote(json);
    expect(JSON.parse(parseSingleQuotedWord(quoted))).toEqual(meta);
  });
});

// -- Test fixtures ------------------------------------------------------------

const baseSite: SiteConfig = {
  name: 'test-site',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
};

const minimalSsh: SshConfig = {
  host: 'example.test',
  user: 'deploy',
  wpPath: '/var/www/html',
};

const fullSsh: SshConfig = {
  host: '203.0.113.42',
  user: 'ubuntu',
  port: 2222,
  wpPath: '/var/www/wordpress',
  identityFile: '~/.ssh/id_ed25519',
};

const legacySsh: SshConfig = {
  host: 'deploy@example.test',
  user: '',
  wpPath: '/var/www/html',
};

// -- sshDestination -----------------------------------------------------------

describe('sshDestination', () => {
  test('builds user@host from separate fields', () => {
    expect(sshDestination(minimalSsh)).toBe('deploy@example.test');
  });

  test('builds user@host with IP address', () => {
    expect(sshDestination(fullSsh)).toBe('ubuntu@203.0.113.42');
  });

  test('preserves legacy user@host format when user is empty', () => {
    expect(sshDestination(legacySsh)).toBe('deploy@example.test');
  });

  test('does not double-prefix when host already contains @', () => {
    const ssh: SshConfig = {
      host: 'admin@example.test',
      user: 'admin',
      wpPath: '/var/www/html',
    };
    // When host already has @, use it as-is (legacy compat)
    expect(sshDestination(ssh)).toBe('admin@example.test');
  });

  test('handles subdomain hosts', () => {
    const ssh: SshConfig = {
      host: 'ssh.mysite.kinsta.cloud',
      user: 'mysite',
      wpPath: '/www/mysite/public',
    };
    expect(sshDestination(ssh)).toBe('mysite@ssh.mysite.kinsta.cloud');
  });
});

// -- buildSshArgs -------------------------------------------------------------

describe('buildSshArgs', () => {
  test('minimal config produces correct args', () => {
    const args = buildSshArgs(minimalSsh);
    expect(args).toContain('-o');
    expect(args).toContain('StrictHostKeyChecking=accept-new');
    expect(args).toContain('BatchMode=yes');
    expect(args[args.length - 1]).toBe('deploy@example.test');
    // No -p flag for default port
    expect(args).not.toContain('-p');
    // No -i flag without identityFile
    expect(args).not.toContain('-i');
    // No IdentitiesOnly without identityFile (allows agent to work normally)
    expect(args).not.toContain('IdentitiesOnly=yes');
  });

  test('custom port adds -p flag', () => {
    const args = buildSshArgs(fullSsh);
    const portIdx = args.indexOf('-p');
    expect(portIdx).toBeGreaterThanOrEqual(0);
    expect(args[portIdx + 1]).toBe('2222');
  });

  test('port 22 does not add -p flag', () => {
    const ssh: SshConfig = { ...minimalSsh, port: 22 };
    const args = buildSshArgs(ssh);
    expect(args).not.toContain('-p');
  });

  test('identityFile adds -i flag and IdentitiesOnly=yes', () => {
    const args = buildSshArgs(fullSsh);
    const iIdx = args.indexOf('-i');
    expect(iIdx).toBeGreaterThanOrEqual(0);
    expect(args[iIdx + 1]).toBe('~/.ssh/id_ed25519');
    // IdentitiesOnly prevents agent from offering all keys
    expect(args).toContain('IdentitiesOnly=yes');
  });

  test('destination is always the last argument', () => {
    const args = buildSshArgs(fullSsh);
    expect(args[args.length - 1]).toBe('ubuntu@203.0.113.42');
  });

  test('always includes BatchMode=yes for non-interactive use', () => {
    const args = buildSshArgs(minimalSsh);
    const batchIdx = args.indexOf('BatchMode=yes');
    expect(batchIdx).toBeGreaterThan(0);
    // Preceded by -o
    expect(args[batchIdx - 1]).toBe('-o');
  });
});

// -- isWpCliAvailableForSite --------------------------------------------------

describe('isWpCliAvailableForSite', () => {
  test('returns true when host, user, and wpPath are all present', () => {
    const site: SiteConfig = { ...baseSite, ssh: minimalSsh };
    expect(isWpCliAvailableForSite(site)).toBe(true);
  });

  test('returns false when ssh is undefined', () => {
    expect(isWpCliAvailableForSite(baseSite)).toBe(false);
  });

  test('returns false when host is empty', () => {
    const site: SiteConfig = {
      ...baseSite,
      ssh: { host: '', user: 'deploy', wpPath: '/var/www/html' },
    };
    expect(isWpCliAvailableForSite(site)).toBe(false);
  });

  test('returns false when user is empty', () => {
    const site: SiteConfig = {
      ...baseSite,
      ssh: { host: 'example.test', user: '', wpPath: '/var/www/html' },
    };
    expect(isWpCliAvailableForSite(site)).toBe(false);
  });

  test('returns false when wpPath is empty', () => {
    const site: SiteConfig = {
      ...baseSite,
      ssh: { host: 'example.test', user: 'deploy', wpPath: '' },
    };
    expect(isWpCliAvailableForSite(site)).toBe(false);
  });

  test('returns true with all optional fields populated', () => {
    const site: SiteConfig = { ...baseSite, ssh: fullSsh };
    expect(isWpCliAvailableForSite(site)).toBe(true);
  });
});

// -- AdapterResolver with SSH configs -----------------------------------------

describe('AdapterResolver SSH integration', () => {
  test('site without SSH only has REST adapter', () => {
    const resolver = new AdapterResolver(baseSite);
    const avail = resolver.availability();
    expect(avail.rest).toBe(true);
    expect(avail.wpCli).toBe(false);
  });

  test('site with valid SSH has both adapters', () => {
    const site: SiteConfig = { ...baseSite, ssh: minimalSsh };
    const resolver = new AdapterResolver(site);
    const avail = resolver.availability();
    expect(avail.rest).toBe(true);
    expect(avail.wpCli).toBe(true);
  });

  test('site with incomplete SSH (missing user) only has REST', () => {
    const site: SiteConfig = {
      ...baseSite,
      ssh: { host: 'example.test', user: '', wpPath: '/var/www/html' },
    };
    const resolver = new AdapterResolver(site);
    const avail = resolver.availability();
    expect(avail.rest).toBe(true);
    expect(avail.wpCli).toBe(false);
  });

  test('site with incomplete SSH (missing wpPath) only has REST', () => {
    const site: SiteConfig = {
      ...baseSite,
      ssh: { host: 'example.test', user: 'deploy', wpPath: '' },
    };
    const resolver = new AdapterResolver(site);
    const avail = resolver.availability();
    expect(avail.wpCli).toBe(false);
  });

  test('WP-CLI capabilities are unavailable without SSH', () => {
    const resolver = new AdapterResolver(baseSite);
    expect(resolver.tryResolve('replace-in-place')).toBeNull();
    expect(resolver.tryResolve('regenerate-thumbnails')).toBeNull();
    expect(resolver.tryResolve('prune-orphans')).toBeNull();
    expect(resolver.tryResolve('full-references')).toBeNull();
  });

  test('WP-CLI capabilities are available with SSH', () => {
    const site: SiteConfig = { ...baseSite, ssh: minimalSsh };
    const resolver = new AdapterResolver(site);
    expect(resolver.tryResolve('replace-in-place')?.name).toBe('wp-cli');
    expect(resolver.tryResolve('regenerate-thumbnails')?.name).toBe('wp-cli');
    expect(resolver.tryResolve('prune-orphans')?.name).toBe('wp-cli');
    expect(resolver.tryResolve('full-references')?.name).toBe('wp-cli');
  });

  test('capabilityReport shows all capabilities available with SSH', () => {
    const site: SiteConfig = { ...baseSite, ssh: fullSsh };
    const resolver = new AdapterResolver(site);
    const report = resolver.capabilityReport();
    const unavailable = report.filter((r) => r.preferredAdapter === null);
    expect(unavailable).toHaveLength(0);
  });

  test('capabilityReport shows missing capabilities without SSH', () => {
    const resolver = new AdapterResolver(baseSite);
    const report = resolver.capabilityReport();
    const unavailable = report.filter((r) => r.preferredAdapter === null);
    expect(unavailable.length).toBeGreaterThan(0);
    const unavailableNames = unavailable.map((r) => r.capability);
    expect(unavailableNames).toContain('replace-in-place');
    expect(unavailableNames).toContain('regenerate-thumbnails');
  });
});
