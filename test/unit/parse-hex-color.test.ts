/**
 * Tests for parseHexColor() — the --bg color parser used by remove-bg.
 */

import { describe, expect, test } from 'bun:test';
import { parseHexColor } from '../../src/engine/rembg/remove-bg.ts';

describe('parseHexColor', () => {
  test('parses a 6-digit hex color', () => {
    expect(parseHexColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('000000')).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('expands a 3-digit shorthand hex color', () => {
    expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor('#0af')).toEqual({ r: 0, g: 170, b: 255 });
  });

  test('throws on an invalid hex string instead of returning NaN', () => {
    expect(() => parseHexColor('nope')).toThrow(/Invalid hex color/);
    expect(() => parseHexColor('#12345')).toThrow(/Invalid hex color/);
  });
});
