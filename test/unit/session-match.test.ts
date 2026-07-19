/**
 * `matchSessionByPrefix` unit tests.
 *
 * Regression coverage for issue #217: an ambiguous session-ID prefix used to
 * silently resolve to the first `.find()` match instead of erroring.
 */

import { describe, expect, test } from 'bun:test';
import {
  MIN_SESSION_PREFIX_LEN,
  formatAmbiguousCandidates,
  matchSessionByPrefix,
} from '../../src/cli/utils/session-match.ts';
import type { SessionRecord } from '../../src/engine/history/types.ts';

function makeSession(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    siteName: 'testsite',
    command: 'optimize',
    paramsJson: null,
    startedAt: Date.parse('2024-01-01T00:00:00Z'),
    finishedAt: null,
    itemCount: 1,
    ...overrides,
  };
}

describe('matchSessionByPrefix', () => {
  test('unique prefix resolves to a single match', () => {
    const sessions = [
      makeSession('aaaa1111-0000-0000-0000-000000000000'),
      makeSession('bbbb2222-0000-0000-0000-000000000000'),
    ];
    const result = matchSessionByPrefix(sessions, 'aaaa1111');
    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.session.id).toBe('aaaa1111-0000-0000-0000-000000000000');
    }
  });

  test('prefix shared by multiple sessions is reported as ambiguous', () => {
    const sessions = [
      makeSession('aaaa1111-0000-0000-0000-000000000000'),
      makeSession('aaaa2222-0000-0000-0000-000000000000'),
      makeSession('bbbb3333-0000-0000-0000-000000000000'),
    ];
    const result = matchSessionByPrefix(sessions, 'aaaa');
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((c) => c.id).sort()).toEqual(
        ['aaaa1111-0000-0000-0000-000000000000', 'aaaa2222-0000-0000-0000-000000000000'].sort(),
      );
    }
  });

  test('prefix matching nothing returns none', () => {
    const sessions = [makeSession('aaaa1111-0000-0000-0000-000000000000')];
    const result = matchSessionByPrefix(sessions, 'zzzz');
    expect(result.kind).toBe('none');
  });

  test('prefix shorter than the minimum length is rejected before scanning', () => {
    const sessions = [
      makeSession('aaaa1111-0000-0000-0000-000000000000'),
      makeSession('aaab2222-0000-0000-0000-000000000000'),
    ];
    const shortPrefix = 'a'.repeat(MIN_SESSION_PREFIX_LEN - 1);
    const result = matchSessionByPrefix(sessions, shortPrefix);
    expect(result.kind).toBe('too-short');
  });

  test('prefix exactly at the minimum length is scanned normally', () => {
    const sessions = [makeSession('aaaa1111-0000-0000-0000-000000000000')];
    const result = matchSessionByPrefix(sessions, 'aaaa');
    expect(result.kind).toBe('match');
  });
});

describe('formatAmbiguousCandidates', () => {
  test('produces a JSON-friendly summary of each candidate', () => {
    const sessions = [
      makeSession('aaaa1111-0000-0000-0000-000000000000', { command: 'optimize' }),
      makeSession('aaaa2222-0000-0000-0000-000000000000', { command: 'caption' }),
    ];
    const result = matchSessionByPrefix(sessions, 'aaaa');
    expect(result.kind).toBe('ambiguous');
    if (result.kind !== 'ambiguous') return;

    const formatted = formatAmbiguousCandidates(result.candidates);
    expect(formatted.map((c) => c.id).sort()).toEqual(
      ['aaaa1111-0000-0000-0000-000000000000', 'aaaa2222-0000-0000-0000-000000000000'].sort(),
    );
    for (const c of formatted) {
      expect(c.shortId).toBe(c.id.slice(0, 8));
      expect(typeof c.command).toBe('string');
      expect(typeof c.startedAt).toBe('number');
    }
  });
});
