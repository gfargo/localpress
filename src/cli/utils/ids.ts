import { error } from './output.ts';

/**
 * Parse CLI attachment ID arguments into deduplicated integers.
 * Exits the process with code 2 if any argument isn't a valid integer.
 */
export function parseAttachmentIds(idStrs: string[]): number[] {
  const ids = idStrs.map(parseAttachmentId);
  if (ids.some((id) => id === null)) {
    error('All arguments must be valid attachment IDs (positive integers).');
    process.exit(2);
  }
  return [...new Set(ids as number[])];
}

/** Parse one WordPress attachment ID without accepting partial numeric strings. */
export function parseAttachmentId(value: string): number | null {
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const id = Number(normalized);
  return Number.isSafeInteger(id) ? id : null;
}
