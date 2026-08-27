import { cpus } from 'node:os';
export { forEachConcurrent, sortResultsById } from '../../engine/concurrency.ts';

/** Validate and cap a requested worker count for memory-sensitive operations. */
export function limitConcurrency(requested: number, maximum: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`Concurrency must be a positive integer; received ${requested}.`);
  }
  if (!Number.isInteger(maximum) || maximum < 1) {
    throw new Error(`Maximum concurrency must be a positive integer; received ${maximum}.`);
  }
  return Math.min(requested, maximum);
}

export interface ResolvedConcurrency {
  /** Value selected from CLI, config, or the command fallback before capping. */
  requested: number;
  /** Worker count the command should actually use. */
  effective: number;
  /** Whether a command-specific safety cap reduced the requested value. */
  capped: boolean;
}

/** Default for ordinary CPU/network bulk operations. */
export function defaultBulkConcurrency(): number {
  return Math.max(1, cpus().length - 1);
}

/** Resolve CLI > config > fallback and apply an optional command safety cap. */
export function resolveConcurrency(
  cliValue: number | undefined,
  configuredValue: number | undefined,
  options: { fallback?: number; maximum?: number } = {},
): ResolvedConcurrency {
  const requested = cliValue ?? configuredValue ?? options.fallback ?? defaultBulkConcurrency();
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(`Concurrency must be a positive integer; received ${requested}.`);
  }

  const effective =
    options.maximum === undefined ? requested : limitConcurrency(requested, options.maximum);
  return { requested, effective, capped: effective < requested };
}
