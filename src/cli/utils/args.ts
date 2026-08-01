/**
 * Shared commander argParser helpers.
 */

import { InvalidArgumentError } from 'commander';

/** Parses an integer CLI option value, rejecting non-numeric input via commander's own error path. */
export function parseIntOption(flagLabel: string) {
  return (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
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
