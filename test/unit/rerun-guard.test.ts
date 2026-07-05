/**
 * Unit tests for the rerun guard used by watch.ts and watcher.ts to avoid
 * silently dropping saves that land while a sync is already in flight.
 */

import { describe, expect, test } from 'bun:test';
import { createRerunGuard } from '../../src/cli/utils/rerun-guard.ts';

/** A deferred promise, used to simulate a slow in-flight operation. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('createRerunGuard', () => {
  test('a call that arrives during an in-flight run is queued, not dropped', async () => {
    const calls: number[] = [];
    const gate = deferred<void>();

    const trigger = createRerunGuard<number>(async (n) => {
      calls.push(n);
      if (n === 1) await gate.promise;
    });

    const first = trigger(1);
    // The second call arrives while the first is still in flight (gated).
    const second = trigger(2);

    // The queued call must resolve immediately — it doesn't block the caller
    // waiting for the in-flight run to finish.
    await second;
    expect(calls).toEqual([1]);

    // Release the in-flight run; the queued call should now fire automatically.
    gate.resolve();
    await first;

    expect(calls).toEqual([1, 2]);
  });

  test('multiple overlapping calls collapse into a single rerun (last-write-wins)', async () => {
    const calls: number[] = [];
    const gate = deferred<void>();

    const trigger = createRerunGuard<number>(async (n) => {
      calls.push(n);
      if (n === 1) await gate.promise;
    });

    const first = trigger(1);
    await trigger(2);
    await trigger(3);

    gate.resolve();
    await first;

    // Only the first call and the last queued call should have run — not
    // one rerun per dropped/overlapping call.
    expect(calls).toEqual([1, 3]);
  });

  test('single non-overlapping calls run immediately with no extra reruns', async () => {
    const calls: number[] = [];
    const trigger = createRerunGuard<number>(async (n) => {
      calls.push(n);
    });

    await trigger(1);
    await trigger(2);
    await trigger(3);

    expect(calls).toEqual([1, 2, 3]);
  });
});
