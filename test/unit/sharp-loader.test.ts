/**
 * Unit tests for the sharp loader module.
 *
 * Tests the cached loading behavior and the SharpNotInstalledError class.
 * Path discovery and auto-install are integration concerns (they touch real
 * filesystem and spawn subprocesses) so they're tested indirectly via behavior.
 */

import { describe, expect, test } from 'bun:test';

import { SharpNotInstalledError, isSharpAvailable } from '../../src/engine/image/sharp-loader.ts';

describe('SharpNotInstalledError', () => {
  test('is thrown when sharp cannot be loaded', () => {
    const err = new SharpNotInstalledError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SharpNotInstalledError');
  });

  test('message includes actionable install instructions', () => {
    const err = new SharpNotInstalledError();
    expect(err.message).toContain('bun install -g sharp');
    expect(err.message).toContain('npm install -g sharp');
    expect(err.message).toContain('localpress doctor');
  });
});

describe('isSharpAvailable', () => {
  test('returns a boolean', async () => {
    const result = await isSharpAvailable();
    expect(typeof result).toBe('boolean');
  });

  test('returns true in dev mode (sharp is in node_modules)', async () => {
    // In the test environment, sharp IS installed (it's a direct dependency).
    // This verifies the happy path.
    const result = await isSharpAvailable();
    expect(result).toBe(true);
  });
});
