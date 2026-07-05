/**
 * Tests for cleanCaption() — the post-processor that turns verbose
 * Ollama responses into usable HTML alt-text.
 */

import { describe, expect, test } from 'bun:test';
import { cleanCaption, cleanClassify } from '../../src/engine/caption/ollama.ts';

describe('cleanCaption', () => {
  test('passes through already-clean alt text unchanged', () => {
    expect(cleanCaption('Red ceramic mug on a wooden desk')).toBe(
      'Red ceramic mug on a wooden desk',
    );
  });

  test('strips surrounding quotes', () => {
    expect(cleanCaption('"Red ceramic mug on a wooden desk"')).toBe(
      'Red ceramic mug on a wooden desk',
    );
    expect(cleanCaption("'Red mug'")).toBe('Red mug');
  });

  test('strips "The image shows" intro and recapitalizes', () => {
    expect(cleanCaption('The image shows a red coffee mug on a wooden desk.')).toBe(
      'A red coffee mug on a wooden desk.',
    );
  });

  test('strips "This image is" intro', () => {
    expect(cleanCaption('This image is of a sunset over mountains.')).toBe(
      'A sunset over mountains.',
    );
  });

  test('strips "Here is a description of …:" intro', () => {
    expect(cleanCaption('Here is a brief description of the image: A red mug.')).toBe('A red mug.');
  });

  test('strips "I see" intro', () => {
    expect(cleanCaption('I see a cat sitting on a windowsill.')).toBe(
      'A cat sitting on a windowsill.',
    );
  });

  test('strips "Description:" leading label', () => {
    expect(cleanCaption('Description: A red mug.')).toBe('A red mug.');
    expect(cleanCaption('Alt-text: A red mug.')).toBe('A red mug.');
  });

  test('keeps only the first paragraph from multi-paragraph output', () => {
    const verbose = `A terminal showing localpress output.

* A header bar at the top
* A list of attachment IDs below
* Status text in green

The terminal uses a dark color scheme.`;
    expect(cleanCaption(verbose)).toBe('A terminal showing localpress output.');
  });

  test('cuts at first bullet point', () => {
    const bulletEssay = `A terminal window with command output.
* The terminal has a gray background
* Text is displayed in white`;
    expect(cleanCaption(bulletEssay)).toBe('A terminal window with command output.');
  });

  test('truncates very long output at a word boundary', () => {
    const long = `${'word '.repeat(60)}word`; // 305 chars
    const out = cleanCaption(long);
    expect(out.length).toBeLessThanOrEqual(241);
    expect(out.endsWith('…')).toBe(true);
    // Truncation should land on a word boundary (last char before ellipsis is a letter).
    expect(/[a-z]…$/.test(out)).toBe(true);
  });

  test('handles the real llama3.2-vision verbose output pattern', () => {
    const real = `The image shows a screenshot of a terminal window displaying a command prompt with a list of commands and their outputs. The purpose of the image is to illustrate the use of various commands in a terminal environment.

* A terminal window with a command prompt:
        + The terminal window has a gray background with white text.

Overall, the image provides a visual representation of the commands and their outputs.`;
    const out = cleanCaption(real);
    // First paragraph should win, intro should be stripped, no bullets.
    expect(out).not.toContain('*');
    expect(out).not.toContain('Overall');
    expect(out.startsWith('A screenshot of a terminal window')).toBe(true);
    expect(out.length).toBeLessThan(250);
  });
});

describe('cleanClassify', () => {
  test('matches a plain single-word label', () => {
    expect(cleanClassify('screenshot')).toBe('screenshot');
    expect(cleanClassify('Diagram')).toBe('diagram');
  });

  test('does not match a label mentioned only in a negation', () => {
    // "screenshot" appears in the text, but only as the label being denied —
    // "photograph" (matched via the `photo` label) is the actual answer and
    // comes first in the sentence.
    expect(cleanClassify('This is a photograph, not a screenshot.')).toBe('photo');
  });

  test('picks the earliest mentioned label when several appear', () => {
    expect(cleanClassify('Not a diagram — this looks like an illustration.')).toBe('diagram');
  });

  test('falls back to the first word when no label matches', () => {
    expect(cleanClassify('unrecognized output here')).toBe('unrecognized');
  });
});
