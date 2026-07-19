/**
 * Prefix matching for session IDs (used by `undo <sessionId>` and
 * `history show <id>`). Both commands accept a short prefix of a session's
 * UUID; this shared helper makes sure an ambiguous prefix is reported rather
 * than silently resolving to the first/newest match.
 */

import type { SessionRecord } from '../../engine/history/types.ts';

/**
 * Minimum accepted prefix length. The UI always prints 8-char prefixes
 * (see history.ts), so this stays well below that while still ruling out
 * accidental 1-3 character inputs that would match broadly.
 */
export const MIN_SESSION_PREFIX_LEN = 4;

export type SessionPrefixMatch =
  | { kind: 'match'; session: SessionRecord }
  | { kind: 'ambiguous'; candidates: SessionRecord[] }
  | { kind: 'none' }
  | { kind: 'too-short' };

/** Match a user-supplied prefix against a list of sessions (newest-first is fine either way). */
export function matchSessionByPrefix(
  sessions: SessionRecord[],
  prefix: string,
): SessionPrefixMatch {
  if (prefix.length < MIN_SESSION_PREFIX_LEN) {
    return { kind: 'too-short' };
  }
  const matches = sessions.filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches };
  return { kind: 'match', session: matches[0] };
}

export interface AmbiguousSessionCandidate {
  id: string;
  shortId: string;
  command: string;
  startedAt: number;
}

/**
 * Structured form of an ambiguous match's candidate list, shared by the
 * human-readable and `--json` renderers in `undo` and `history show` so
 * neither output mode drops the disambiguation info the other shows.
 */
export function formatAmbiguousCandidates(
  candidates: SessionRecord[],
): AmbiguousSessionCandidate[] {
  return candidates.map((c) => ({
    id: c.id,
    shortId: c.id.slice(0, 8),
    command: c.command,
    startedAt: c.startedAt,
  }));
}
