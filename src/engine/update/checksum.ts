/**
 * Checksum parsing/verification for `localpress update`.
 *
 * `checksums.txt` is `sha256sum`-compatible: `<hex>  <filename>` per line,
 * with an optional `*` binary-mode marker before the filename.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;

    const [, hash, filename] = match;
    map.set(filename.trim(), hash.toLowerCase());
  }

  return map;
}

export async function verifyChecksum(filePath: string, expectedHex: string): Promise<void> {
  const hash = createHash('sha256');

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });

  const actualHex = hash.digest('hex');
  if (actualHex.toLowerCase() !== expectedHex.toLowerCase()) {
    throw new Error(`Checksum mismatch: expected ${expectedHex}, got ${actualHex}`);
  }
}
