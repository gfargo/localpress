/**
 * Shared commander argParser helpers.
 */

import { InvalidArgumentError } from 'commander';

/** Parses an integer CLI option value, rejecting non-numeric input via commander's own error path. */
export function parseIntOption(flagLabel: string) {
  return (value: string): number => {
    const parsed = Number(value);
    if (value.trim() === '' || !Number.isSafeInteger(parsed)) {
      throw new InvalidArgumentError(`'${value}' is not a valid integer for ${flagLabel}.`);
    }
    return parsed;
  };
}

/** Like `parseIntOption`, but also rejects negative values. */
export function parseNonNegativeIntOption(flagLabel: string) {
  const parseAsInt = parseIntOption(flagLabel);
  return (value: string): number => {
    const parsed = parseAsInt(value);
    if (parsed < 0) {
      throw new InvalidArgumentError(`'${value}' must not be negative for ${flagLabel}.`);
    }
    return parsed;
  };
}

/** Parses a strictly positive integer CLI option. */
export function parsePositiveIntOption(flagLabel: string) {
  return (value: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
      throw new InvalidArgumentError(`'${value}' must be a positive integer for ${flagLabel}.`);
    }
    return parsed;
  };
}
