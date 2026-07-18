/**
 * Tests that `openInEditor` reports a missing editor binary via callback
 * instead of crashing the process on an unhandled 'error' event.
 *
 * `node:child_process` is mocked so no real process is spawned; instead we
 * capture the registered 'error' listener and invoke it directly, mirroring
 * how Node would deliver a real ENOENT for a missing binary.
 */

import { describe, expect, mock, test } from 'bun:test';

type ErrorListener = (err: Error) => void;

const lastChild: { errorListener: ErrorListener | null; unrefed: boolean } = {
  errorListener: null,
  unrefed: false,
};

mock.module('node:child_process', () => ({
  spawn: () => {
    lastChild.errorListener = null;
    lastChild.unrefed = false;
    return {
      on: (event: string, listener: ErrorListener) => {
        if (event === 'error') lastChild.errorListener = listener;
      },
      unref: () => {
        lastChild.unrefed = true;
      },
    };
  },
}));

const { describeEditor, openInEditor } = await import('../../src/engine/editor/detect.ts');

describe('openInEditor', () => {
  test('returns an OpenResult synchronously and registers an error listener', () => {
    const result = openInEditor('/tmp/whatever.jpg', 'definitely-not-a-real-binary-xyz');

    expect(result.command).toBe('definitely-not-a-real-binary-xyz');
    expect(result.args).toEqual(['/tmp/whatever.jpg']);
    expect(lastChild.errorListener).toBeTypeOf('function');
    expect(lastChild.unrefed).toBe(true);
  });

  test('invokes onError instead of crashing when the binary does not exist', () => {
    let caughtError: Error | undefined;

    openInEditor('/tmp/whatever.jpg', 'definitely-not-a-real-binary-xyz', (err) => {
      caughtError = err;
    });

    // Simulate the async ENOENT 'error' event Node would emit for a missing binary.
    lastChild.errorListener?.(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError?.message).toBe('spawn ENOENT');
  });

  test('does not throw when onError is omitted', () => {
    expect(() => {
      openInEditor('/tmp/whatever.jpg', 'definitely-not-a-real-binary-xyz');
      lastChild.errorListener?.(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    }).not.toThrow();
  });
});

describe('describeEditor', () => {
  test('returns the explicit editor app when provided', () => {
    expect(describeEditor('gimp')).toBe('gimp');
  });

  test('returns a platform-appropriate default description', () => {
    expect(describeEditor()).toBeTruthy();
  });
});
