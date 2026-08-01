/**
 * Unit tests for shared commander argParser helpers.
 */

import { describe, expect, test } from 'bun:test';
import { InvalidArgumentError } from 'commander';
import { parseIntOption, parseNonNegativeIntOption } from '../../src/cli/utils/args.ts';

describe('parseIntOption', () => {
  test('parses a valid integer', () => {
    expect(parseIntOption('--flag')('123')).toBe(123);
  });

  test('rejects non-numeric input', () => {
    expect(() => parseIntOption('--flag')('abc')).toThrow(InvalidArgumentError);
  });

  test('accepts negative values', () => {
    expect(parseIntOption('--flag')('-5')).toBe(-5);
  });
});

describe('parseNonNegativeIntOption', () => {
  test('parses a valid non-negative integer', () => {
    expect(parseNonNegativeIntOption('--max-unoptimized-bytes')('50000000')).toBe(50_000_000);
  });

  test('accepts zero', () => {
    expect(parseNonNegativeIntOption('--max-unoptimized-bytes')('0')).toBe(0);
  });

  test('rejects negative values', () => {
    expect(() => parseNonNegativeIntOption('--max-unoptimized-bytes')('-1')).toThrow(
      InvalidArgumentError,
    );
  });

  test('rejects non-numeric input', () => {
    expect(() => parseNonNegativeIntOption('--max-unoptimized-bytes')('abc')).toThrow(
      InvalidArgumentError,
    );
  });
});
