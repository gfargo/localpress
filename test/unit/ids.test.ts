import { describe, expect, test } from 'bun:test';
import { parseAttachmentId } from '../../src/cli/utils/ids.ts';

describe('parseAttachmentId', () => {
  test.each([
    ['1', 1],
    ['123', 123],
    [' 42 ', 42],
  ])('parses %s', (value, expected) => {
    expect(parseAttachmentId(value)).toBe(expected);
  });

  test.each(['', '0', '-1', '12px', '1.5', '9007199254740992'])('rejects %s', (value) => {
    expect(parseAttachmentId(value)).toBeNull();
  });
});
