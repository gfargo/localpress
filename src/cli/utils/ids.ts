import { error } from './output.ts';

/**
 * Parse CLI attachment ID arguments into deduplicated integers.
 * Exits the process with code 2 if any argument isn't a valid integer.
 */
export function parseAttachmentIds(idStrs: string[]): number[] {
  const ids = idStrs.map((s) => Number.parseInt(s, 10));
  if (ids.some(Number.isNaN)) {
    error('All arguments must be valid attachment IDs (integers).');
    process.exit(2);
  }
  return [...new Set(ids)];
}
