import { describe, expect, test } from 'bun:test';
import { slugify } from '../../src/cli/commands/rename.ts';

describe('slugify', () => {
  test('lowercases and converts spaces to hyphens', () => {
    expect(slugify('Red Coffee Mug')).toBe('red-coffee-mug');
  });

  test('strips punctuation', () => {
    expect(slugify("Cat's terminal output!")).toBe('cats-terminal-output');
  });

  test('collapses underscores and runs of hyphens', () => {
    expect(slugify('Screenshot__from---terminal')).toBe('screenshot-from-terminal');
  });

  test('trims leading/trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  test('handles unicode by stripping non-ASCII', () => {
    expect(slugify('café résumé')).toBe('caf-rsum');
  });

  test('truncates to 100 chars', () => {
    const long = 'word '.repeat(40); // ~200 chars
    expect(slugify(long).length).toBeLessThanOrEqual(100);
  });

  test('strips trailing punctuation from the input cleanly', () => {
    expect(slugify('Terminal command output.')).toBe('terminal-command-output');
  });

  test('the user real-world case', () => {
    // From a real vision-generated title.
    expect(slugify('Terminal showing localpress caption output')).toBe(
      'terminal-showing-localpress-caption-output',
    );
  });
});
