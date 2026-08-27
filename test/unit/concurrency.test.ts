import { describe, expect, test } from 'bun:test';
import { parseIntOption, parsePositiveIntOption } from '../../src/cli/utils/args.ts';
import {
  forEachConcurrent,
  limitConcurrency,
  resolveConcurrency,
  sortResultsById,
} from '../../src/cli/utils/concurrency.ts';

describe('forEachConcurrent', () => {
  test('never exceeds the requested worker count', async () => {
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];

    await forEachConcurrent([0, 1, 2, 3, 4, 5], 2, async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(item);
      active--;
    });

    expect(maxActive).toBe(2);
    expect(completed.toSorted()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  test('provides each original index exactly once', async () => {
    const seen: Array<[string, number]> = [];

    await forEachConcurrent(['a', 'b', 'c'], 8, async (item, index) => {
      seen.push([item, index]);
    });

    expect(seen).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN])('rejects invalid concurrency %s', async (value) => {
    await expect(forEachConcurrent([1], value, async () => {})).rejects.toThrow(
      /positive integer/i,
    );
  });
});

describe('limitConcurrency', () => {
  test('keeps a request below the cap and caps a larger request', () => {
    expect(limitConcurrency(1, 2)).toBe(1);
    expect(limitConcurrency(8, 2)).toBe(2);
  });

  test.each([0, -1, 1.5, Number.NaN])('rejects invalid request %s', (value) => {
    expect(() => limitConcurrency(value, 2)).toThrow(/positive integer/i);
  });
});

describe('resolveConcurrency', () => {
  test('resolves CLI over config over fallback', () => {
    expect(resolveConcurrency(2, 3, { fallback: 4 }).effective).toBe(2);
    expect(resolveConcurrency(undefined, 3, { fallback: 4 }).effective).toBe(3);
    expect(resolveConcurrency(undefined, undefined, { fallback: 4 }).effective).toBe(4);
  });

  test('reports command-specific caps', () => {
    expect(resolveConcurrency(8, undefined, { maximum: 2 })).toEqual({
      requested: 8,
      effective: 2,
      capped: true,
    });
  });

  test('rejects an invalid configured value', () => {
    expect(() => resolveConcurrency(undefined, 0)).toThrow(/positive integer/i);
  });
});

describe('sortResultsById', () => {
  test('restores input order after out-of-order completion', () => {
    const results = [{ id: 30 }, { id: 10 }, { id: 20 }];
    sortResultsById(results, [10, 20, 30]);
    expect(results.map((result) => result.id)).toEqual([10, 20, 30]);
  });
});

describe('parsePositiveIntOption', () => {
  const parse = parsePositiveIntOption('--concurrency');

  test('accepts a whole positive number', () => {
    expect(parse('2')).toBe(2);
  });

  test.each(['0', '-1', '1.5', '2workers', '', '9007199254740992'])(
    'rejects invalid value %s',
    (value) => {
      expect(() => parse(value)).toThrow(/positive integer/i);
    },
  );
});

describe('parseIntOption', () => {
  const parse = parseIntOption('--port');

  test('accepts whole numbers without truncating the input', () => {
    expect(parse('0')).toBe(0);
    expect(parse('-2')).toBe(-2);
  });

  test.each(['1.5', '12px', '', '9007199254740992'])('rejects invalid value %s', (value) => {
    expect(() => parse(value)).toThrow(/valid integer/i);
  });
});
