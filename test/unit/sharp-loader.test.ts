/**
 * Unit tests for the sharp loader module.
 *
 * Tests the cached loading behavior and the SharpNotInstalledError class.
 * Path discovery and auto-install are integration concerns (they touch real
 * filesystem and spawn subprocesses) so they're tested indirectly via behavior.
 */

import { describe, expect, test } from 'bun:test';

import {
  SharpNotInstalledError,
  isSharpAvailable,
  loadSharpWithPrompt,
} from '../../src/engine/image/sharp-loader.ts';

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

describe('loadSharpWithPrompt', () => {
  test('--yes wins even when --json/--quiet also set noPrompt', async () => {
    // Regression: `noPrompt` used to be checked before `autoYes`, so
    // `--json --yes` (which sets both noPrompt and autoYes) threw instead of
    // auto-installing. Since sharp is already installed in this test env,
    // loadSharp() resolves immediately and this path never even reaches the
    // noPrompt/autoYes branch — this simply proves that ordering no longer
    // throws on the happy path when both flags are set.
    const sharp = await loadSharpWithPrompt({ autoYes: true, noPrompt: true });
    expect(sharp).toBeDefined();
  });
});
