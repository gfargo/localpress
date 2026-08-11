/**
 * Unit tests for the grace-window delete scheduler used by `watch --delete`
 * to survive atomic (delete+recreate) editor saves.
 */

import { describe, expect, test } from 'bun:test';
import { createDeleteScheduler } from '../../src/cli/utils/delete-grace.ts';

const GRACE_MS = 25;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createDeleteScheduler', () => {
  test('fires onDelete once after the grace window with no intervening cancel', async () => {
    const fired: string[] = [];
    const scheduler = createDeleteScheduler({
      graceMs: GRACE_MS,
      onDelete: (key) => {
        fired.push(key);
      },
    });

    scheduler.scheduleDelete('a.png');
    await wait(GRACE_MS * 2);

    expect(fired).toEqual(['a.png']);
  });

  test('cancelDelete within the grace window prevents onDelete from ever firing', async () => {
    const fired: string[] = [];
    const scheduler = createDeleteScheduler({
      graceMs: GRACE_MS,
      onDelete: (key) => {
        fired.push(key);
      },
    });

    scheduler.scheduleDelete('a.png');
    scheduler.cancelDelete('a.png');
    await wait(GRACE_MS * 2);

    expect(fired).toEqual([]);
  });

  test('a second scheduleDelete for the same key resets the timer (only one fire)', async () => {
    const fired: string[] = [];
    const scheduler = createDeleteScheduler({
      graceMs: GRACE_MS,
      onDelete: (key) => {
        fired.push(key);
      },
    });

    scheduler.scheduleDelete('a.png');
    await wait(GRACE_MS / 2);
    scheduler.scheduleDelete('a.png');
    await wait(GRACE_MS / 2);

    // The first timer's original deadline has now passed, but the reset
    // should have pushed it out — no fire yet.
    expect(fired).toEqual([]);

    await wait(GRACE_MS);
    expect(fired).toEqual(['a.png']);
  });

  test('clearAll cancels all pending deletes', async () => {
    const fired: string[] = [];
    const scheduler = createDeleteScheduler({
      graceMs: GRACE_MS,
      onDelete: (key) => {
        fired.push(key);
      },
    });

    scheduler.scheduleDelete('a.png');
    scheduler.scheduleDelete('b.png');
    scheduler.clearAll();
    await wait(GRACE_MS * 2);

    expect(fired).toEqual([]);
  });

  test('cancelDelete returns true when a timer was pending, false otherwise', () => {
    const scheduler = createDeleteScheduler({ graceMs: GRACE_MS, onDelete: () => {} });

    expect(scheduler.cancelDelete('missing.png')).toBe(false);

    scheduler.scheduleDelete('a.png');
    expect(scheduler.cancelDelete('a.png')).toBe(true);
    expect(scheduler.cancelDelete('a.png')).toBe(false);
  });
});
