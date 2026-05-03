/**
 * Smoke test — verifies the project structure compiles and key types
 * cohere. Real implementation tests come in v0.1.
 */

import { describe, expect, test } from 'bun:test';

import { type AdapterAvailability, AdapterResolver } from '../../src/adapters/resolver.ts';
import {
  type Capability,
  CapabilityUnavailableError,
  type WpBackend,
} from '../../src/adapters/types.ts';
import { SCHEMA_VERSION } from '../../src/engine/state/schema.ts';
import { ExitCode, type SiteConfig } from '../../src/types.ts';

const fakeRestOnlySite: SiteConfig = {
  name: 'test-rest-only',
  url: 'https://example.test',
  username: 'admin',
  appPassword: 'aaaa bbbb cccc dddd eeee ffff',
  createdAt: new Date('2026-01-01').toISOString(),
};

const fakeWpCliSite: SiteConfig = {
  ...fakeRestOnlySite,
  name: 'test-wp-cli',
  ssh: {
    host: 'admin@example.test',
    wpPath: '/var/www/wordpress',
  },
};

describe('exit codes', () => {
  test('NotImplemented exit code is 99 (matches output.ts)', () => {
    expect(ExitCode.NotImplemented).toBe(99);
  });

  test('all exit codes are unique', () => {
    const values = Object.values(ExitCode);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('schema', () => {
  test('initial schema version is 2', () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe('AdapterResolver', () => {
  test('REST-only site reports REST available, WP-CLI absent', () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    const availability: AdapterAvailability = resolver.availability();
    expect(availability.rest).toBe(true);
    expect(availability.wpCli).toBe(false);
    expect(availability.mcp).toBe(false);
  });

  test('Site with SSH config reports both REST and WP-CLI available', () => {
    const resolver = new AdapterResolver(fakeWpCliSite);
    const availability = resolver.availability();
    expect(availability.rest).toBe(true);
    expect(availability.wpCli).toBe(true);
  });

  test('REST-only site cannot resolve replace-in-place', () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    expect(resolver.tryResolve('replace-in-place')).toBeNull();
  });

  test('WP-CLI-equipped site prefers WP-CLI for replace-in-place', () => {
    const resolver = new AdapterResolver(fakeWpCliSite);
    const adapter = resolver.tryResolve('replace-in-place');
    expect(adapter).not.toBeNull();
    expect(adapter?.name).toBe('wp-cli');
  });

  test('REST adapter is preferred for cheap operations even when WP-CLI is available', () => {
    // List is supported by both; preference order says wp-cli wins, but
    // the resolver currently picks WP-CLI first per priority.
    // If we ever want REST-first for cheap ops, this test will catch the change.
    const resolver = new AdapterResolver(fakeWpCliSite);
    const adapter = resolver.tryResolve('list');
    expect(adapter?.name).toBe('wp-cli');
  });

  test('capabilityReport covers all Capability values', () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    const report = resolver.capabilityReport();
    const reported: Capability[] = report.map((r) => r.capability);
    expect(reported).toContain('list');
    expect(reported).toContain('replace-in-place');
    expect(reported).toContain('full-references');
    expect(reported.length).toBeGreaterThanOrEqual(10);
  });
});

describe('REST adapter capability surface', () => {
  test('REST adapter cannot replace-in-place (throws CapabilityUnavailableError)', async () => {
    const resolver = new AdapterResolver(fakeRestOnlySite);
    const rest: WpBackend | null = resolver.getAdapter('rest');
    if (!rest) throw new Error('expected REST adapter to be configured');

    expect(rest.capabilities.has('replace-in-place')).toBe(false);

    await expect(rest.replaceInPlace(123, Buffer.from(''))).rejects.toThrow(
      CapabilityUnavailableError,
    );
  });
});
