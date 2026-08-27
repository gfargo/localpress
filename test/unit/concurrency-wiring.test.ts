import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const BULK_COMMANDS = [
  'caption',
  'classify',
  'convert',
  'describe',
  'export',
  'import',
  'optimize',
  'pull',
  'regenerate',
  'remove-bg',
  'rename',
  'resize',
  'tag',
  'title',
  'vision',
] as const;

describe('bulk command concurrency wiring', () => {
  for (const command of BULK_COMMANDS) {
    test(`${command} resolves the shared CLI/config concurrency setting`, async () => {
      const path = join(import.meta.dir, '..', '..', 'src', 'cli', 'commands', `${command}.ts`);
      const source = await Bun.file(path).text();

      expect(source).toContain('resolveConcurrency(');
      expect(source).toContain('config.defaults?.concurrency');
    });
  }
});
