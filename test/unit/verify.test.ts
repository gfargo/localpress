/**
 * Unit tests for the `localpress verify` command registration and the
 * `verify --hash` file-comparison helper.
 *
 * Includes a regression test for #195: `verify` was registered with a
 * required `<ids...>` positional, which made commander reject `verify --all`
 * before the action ever ran. Locks in the fix (`[ids...]`, optional).
 *
 * Also covers OSS-902: the remote file fetch must send auth headers, and any
 * failure to actually perform the comparison must be reported as
 * `verified: false` (never silently treated as a match).
 */

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Command } from 'commander';
import { WpApiError, WpCliError } from '../../src/adapters/types.ts';
import {
  type AllSitesVerifyReport,
  type SiteVerifySummary,
  aggregateVerifyResults,
  allSitesExitCode,
  classifyRemoteFetchError,
  registerVerifyCommand,
  verifyRemoteHash,
} from '../../src/cli/commands/verify.ts';

const AUTH_HEADER = 'Basic dXNlcjpwYXNz';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('verify command registration', () => {
  test('verify command is registered in the CLI', async () => {
    const mod = await import('../../src/cli/commands/verify.ts');
    expect(mod.registerVerifyCommand).toBeFunction();
  });

  test('the ids positional is optional, so --all is reachable', () => {
    const program = new Command();
    registerVerifyCommand(program);

    const verify = program.commands.find((cmd) => cmd.name() === 'verify');
    expect(verify).toBeDefined();
    expect(verify?.registeredArguments).toHaveLength(1);
    expect(verify?.registeredArguments[0]?.required).toBe(false);
  });

  test('--all-sites option is registered on the verify command', () => {
    const program = new Command();
    registerVerifyCommand(program);

    const verify = program.commands.find((cmd) => cmd.name() === 'verify');
    expect(verify).toBeDefined();
    const allSitesOpt = verify?.options.find((o) => o.long === '--all-sites');
    expect(allSitesOpt).toBeDefined();
  });
});

describe('verifyRemoteHash', () => {
  test('matching bytes: verified true, mismatch false', async () => {
    const bytes = new TextEncoder().encode('hello world');
    const localHash = sha256(bytes);

    const fetchImpl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash,
      fetchImpl,
    });

    expect(result.verified).toBe(true);
    expect(result.mismatch).toBe(false);
  });

  test('differing bytes: verified true, mismatch true', async () => {
    const remoteBytes = new TextEncoder().encode('different content');
    const localHash = sha256(new TextEncoder().encode('hello world'));

    const fetchImpl = (async () =>
      new Response(remoteBytes, { status: 200 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash,
      fetchImpl,
    });

    expect(result.verified).toBe(true);
    expect(result.mismatch).toBe(true);
  });

  test('401/403 response: verified false with a reason, not a silent ok', async () => {
    const fetchImpl = (async () =>
      new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: 'deadbeef',
      fetchImpl,
    });

    expect(result.verified).toBe(false);
    expect(result.mismatch).toBe(false);
    expect(result.reason).toContain('401');
  });

  test('fetch throws: verified false with a reason', async () => {
    const fetchImpl = (async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const result = await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: 'deadbeef',
      fetchImpl,
    });

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('network unreachable');
  });

  test('sends the Authorization header on the outgoing request', async () => {
    let capturedHeaders: Headers | undefined;

    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Uint8Array(), { status: 200 });
    }) as unknown as typeof fetch;

    await verifyRemoteHash({
      url: 'https://example.com/file.jpg',
      authHeader: AUTH_HEADER,
      localHash: sha256(new Uint8Array()),
      fetchImpl,
    });

    expect(capturedHeaders?.get('Authorization')).toBe(AUTH_HEADER);
  });
});

describe('classifyRemoteFetchError', () => {
  test('HTTP 404 classifies as missing-remote', () => {
    const result = classifyRemoteFetchError(new WpApiError('not found', 404));
    expect(result.status).toBe('missing-remote');
    expect(result.httpStatus).toBe(404);
  });

  test('HTTP 401 classifies as unreachable, not missing-remote', () => {
    const result = classifyRemoteFetchError(new WpApiError('unauthorized', 401));
    expect(result.status).toBe('unreachable');
    expect(result.httpStatus).toBe(401);
    expect(result.reason).toContain('unauthorized');
  });

  test('HTTP 403 classifies as unreachable', () => {
    const result = classifyRemoteFetchError(new WpApiError('forbidden', 403));
    expect(result.status).toBe('unreachable');
    expect(result.httpStatus).toBe(403);
  });

  test('HTTP 500 classifies as unreachable', () => {
    const result = classifyRemoteFetchError(new WpApiError('server error', 500));
    expect(result.status).toBe('unreachable');
    expect(result.httpStatus).toBe(500);
  });

  test('WpApiError with no status classifies as unreachable', () => {
    const result = classifyRemoteFetchError(new WpApiError('malformed response'));
    expect(result.status).toBe('unreachable');
    expect(result.httpStatus).toBeUndefined();
  });

  test('plain network error (no status) classifies as unreachable', () => {
    const result = classifyRemoteFetchError(new Error('ECONNREFUSED'));
    expect(result.status).toBe('unreachable');
    expect(result.httpStatus).toBeUndefined();
    expect(result.reason).toContain('ECONNREFUSED');
  });

  test('non-Error thrown value classifies as unreachable', () => {
    const result = classifyRemoteFetchError('boom');
    expect(result.status).toBe('unreachable');
    expect(result.reason).toContain('boom');
  });

  test('WpCliError with WP-CLI "could not find the post" message classifies as missing-remote', () => {
    const result = classifyRemoteFetchError(
      new WpCliError(
        'WP-CLI error (exit 1): Error: Could not find the post with ID 123.',
        1,
        'Error: Could not find the post with ID 123.',
      ),
    );
    expect(result.status).toBe('missing-remote');
    expect(result.httpStatus).toBeUndefined();
  });

  test('WpCliError from an SSH/connectivity failure classifies as unreachable, not missing-remote', () => {
    const result = classifyRemoteFetchError(
      new WpCliError(
        'WP-CLI error (exit 255): ssh: connect to host example.test port 22: Connection refused',
        255,
        'ssh: connect to host example.test port 22: Connection refused',
      ),
    );
    expect(result.status).toBe('unreachable');
    expect(result.reason).toContain('Connection refused');
  });

  test('WpCliError from an unrelated WP-CLI failure (e.g. transient DB error) classifies as unreachable', () => {
    const result = classifyRemoteFetchError(
      new WpCliError(
        'WP-CLI error (exit 1): wp-cli: transient database error',
        1,
        'wp-cli: transient database error',
      ),
    );
    expect(result.status).toBe('unreachable');
  });
});

// Helper to build a SiteVerifySummary for testing aggregation helpers.
function makeSummary(overrides: Partial<SiteVerifySummary> = {}): SiteVerifySummary {
  return {
    site: 'test-site',
    url: 'https://example.com',
    verified: 0,
    ok: 0,
    drift: 0,
    missing: 0,
    unreachable: 0,
    unverified: 0,
    results: [],
    ...overrides,
  };
}

describe('aggregateVerifyResults', () => {
  test('empty input produces all-zero summary', () => {
    const report = aggregateVerifyResults([]);
    expect(report.sites).toHaveLength(0);
    expect(report.summary.sites).toBe(0);
    expect(report.summary.verified).toBe(0);
    expect(report.summary.ok).toBe(0);
    expect(report.summary.drift).toBe(0);
    expect(report.summary.missing).toBe(0);
    expect(report.summary.unreachable).toBe(0);
    expect(report.summary.unverified).toBe(0);
    expect(report.summary.sitesWithErrors).toBe(0);
  });

  test('sums counts across multiple site summaries', () => {
    const summaries = [
      makeSummary({ site: 'site-a', verified: 10, ok: 8, drift: 1, missing: 1 }),
      makeSummary({ site: 'site-b', verified: 5, ok: 3, unreachable: 2 }),
      makeSummary({ site: 'site-c', verified: 7, ok: 6, unverified: 1 }),
    ];
    const report = aggregateVerifyResults(summaries);
    expect(report.summary.sites).toBe(3);
    expect(report.summary.verified).toBe(22);
    expect(report.summary.ok).toBe(17);
    expect(report.summary.drift).toBe(1);
    expect(report.summary.missing).toBe(1);
    expect(report.summary.unreachable).toBe(2);
    expect(report.summary.unverified).toBe(1);
    expect(report.summary.sitesWithErrors).toBe(0);
  });

  test('counts sitesWithErrors when a summary has an error field set', () => {
    const summaries = [
      makeSummary({ site: 'site-a', ok: 5, verified: 5 }),
      makeSummary({ site: 'site-b', error: 'DB unavailable' }),
      makeSummary({ site: 'site-c', error: 'adapter init failed' }),
    ];
    const report = aggregateVerifyResults(summaries);
    expect(report.summary.sitesWithErrors).toBe(2);
    expect(report.summary.ok).toBe(5);
  });

  test('a site with error and zero counts is still included in sites array', () => {
    const summaries = [makeSummary({ site: 'broken', error: 'timeout' })];
    const report = aggregateVerifyResults(summaries);
    expect(report.sites).toHaveLength(1);
    expect(report.sites[0]?.error).toBe('timeout');
  });

  test('single all-ok site produces zero errors', () => {
    const summaries = [makeSummary({ site: 'site-a', verified: 3, ok: 3 })];
    const report = aggregateVerifyResults(summaries);
    expect(report.summary.sitesWithErrors).toBe(0);
    expect(report.summary.drift).toBe(0);
  });
});

describe('allSitesExitCode', () => {
  function makeReport(
    overrides: Partial<AllSitesVerifyReport['summary']> = {},
  ): AllSitesVerifyReport {
    return aggregateVerifyResults([
      makeSummary({
        verified: 3,
        ok: 3,
        drift: overrides.drift ?? 0,
        missing: overrides.missing ?? 0,
        unreachable: overrides.unreachable ?? 0,
        unverified: overrides.unverified ?? 0,
        error: overrides.sitesWithErrors ? 'some error' : undefined,
      }),
    ]);
  }

  test('all-ok report returns exit code 0', () => {
    const report = makeReport();
    expect(allSitesExitCode(report)).toBe(0);
  });

  test('report with drift > 0 returns exit code 1', () => {
    const report = makeReport({ drift: 1 });
    expect(allSitesExitCode(report)).toBe(1);
  });

  test('report with missing > 0 returns exit code 1', () => {
    const report = makeReport({ missing: 2 });
    expect(allSitesExitCode(report)).toBe(1);
  });

  test('report with unreachable > 0 returns exit code 1', () => {
    const report = makeReport({ unreachable: 1 });
    expect(allSitesExitCode(report)).toBe(1);
  });

  test('report with unverified > 0 returns exit code 1', () => {
    const report = makeReport({ unverified: 1 });
    expect(allSitesExitCode(report)).toBe(1);
  });

  test('report with a site-level error returns exit code 1', () => {
    const report = makeReport({ sitesWithErrors: 1 });
    expect(allSitesExitCode(report)).toBe(1);
  });

  test('empty report (no sites) returns exit code 0', () => {
    const report = aggregateVerifyResults([]);
    expect(allSitesExitCode(report)).toBe(0);
  });
});
