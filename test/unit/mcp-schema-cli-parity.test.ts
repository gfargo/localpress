/**
 * Guard test: every `--flag` an MCP tool's handler pushes onto argv must
 * actually be declared on the corresponding CLI subcommand.
 *
 * Regression for #110: the `optimize` tool advertised `maxWidth`/`maxHeight`/
 * `stripMetadata` and mapped them to `--max-width`/`--max-height`/
 * `--strip-metadata`, but `registerOptimizeCommand` didn't declare those
 * flags — any agent that passed them got "unknown option" and the whole
 * tool call failed.
 *
 * This test statically parses `src/cli/mcp/tools.ts` to find every
 * `opt(argv, '--flag', ...)` / `flag(argv, '--flag', ...)` /
 * `argv.push('--flag')` call site per tool, resolves the literal CLI
 * subcommand prefix each tool invokes (e.g. `['sites', 'add']`), and asserts
 * the flag is present in that subcommand's `--help` output.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ToolCliUsage {
  name: string;
  cliPrefix: string[];
  flags: string[];
}

function parseToolUsages(source: string): ToolCliUsage[] {
  const starts: number[] = [];
  const marker = 'server.registerTool(';
  let idx = source.indexOf(marker);
  while (idx !== -1) {
    starts.push(idx);
    idx = source.indexOf(marker, idx + marker.length);
  }

  const usages: ToolCliUsage[] = [];
  for (let i = 0; i < starts.length; i++) {
    const block = source.slice(starts[i], starts[i + 1] ?? source.length);

    const nameMatch = /server\.registerTool\(\s*['"]([\w]+)['"]/.exec(block);
    if (!nameMatch) continue;
    const name = nameMatch[1];

    usages.push({ name, cliPrefix: extractCliPrefix(block), flags: extractFlags(block) });
  }
  return usages;
}

/** Resolve the literal leading string args passed to `runCli`/`argv`, e.g. `['sites', 'add']`. */
function extractCliPrefix(block: string): string[] {
  let bracketStart = -1;
  const argvIdx = block.indexOf('argv = [');
  if (argvIdx !== -1) {
    bracketStart = block.indexOf('[', argvIdx);
  } else {
    const runCliIdx = block.indexOf('runCli([');
    if (runCliIdx !== -1) bracketStart = block.indexOf('[', runCliIdx);
  }
  if (bracketStart === -1) return [];

  const prefix: string[] = [];
  let i = bracketStart + 1;
  while (i < block.length) {
    while (i < block.length && /\s/.test(block[i])) i++;
    const quote = block[i];
    if (quote !== "'" && quote !== '"') break;
    let j = i + 1;
    let str = '';
    while (j < block.length && block[j] !== quote) {
      str += block[j];
      j++;
    }
    prefix.push(str);
    i = j + 1;
    while (i < block.length && /\s/.test(block[i])) i++;
    if (block[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  return prefix;
}

/** Find every `--flag` literal pushed onto argv via the `opt`/`flag` helpers or a raw `argv.push`. */
function extractFlags(block: string): string[] {
  const flags = new Set<string>();
  const callRe = /\b(?:opt|flag)\(argv,\s*['"](--[\w-]+)['"]/g;
  const pushRe = /argv\.push\(\s*['"](--[\w-]+)['"]\s*\)/g;
  for (const re of [callRe, pushRe]) {
    for (const m of block.matchAll(re)) flags.add(m[1]);
  }
  return [...flags];
}

/**
 * Flags pushed via `flag(argv, '--apply', ...)` / `flag(argv, '--dry-run', ...)`
 * are root-program options (see `src/cli/index.ts`) that commander accepts
 * after any subcommand. They intentionally don't appear in a subcommand's own
 * `--help` output, so they're excluded from the per-subcommand check below.
 */
const GLOBAL_FLAGS = new Set(['--apply', '--dry-run']);

const helpCache = new Map<string, string>();

function getHelpText(prefix: string[]): string {
  const key = prefix.join(' ');
  const cached = helpCache.get(key);
  if (cached !== undefined) return cached;

  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const result = spawnSync(process.execPath, ['run', cliEntry, ...prefix, '--help'], {
    encoding: 'utf8',
  });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  helpCache.set(key, text);
  return text;
}

describe('MCP tool schema ↔ CLI flag parity', () => {
  const toolsSource = readFileSync(
    join(import.meta.dir, '..', '..', 'src', 'cli', 'mcp', 'tools.ts'),
    'utf8',
  );
  const usages = parseToolUsages(toolsSource);

  test('parser found a substantial number of tools with flag usage', () => {
    const withFlags = usages.filter((u) => u.flags.length > 0 && u.cliPrefix.length > 0);
    // Sanity check on the static parser itself — if this drops to 0, the
    // regex above stopped matching the source (e.g. after a refactor) and
    // the parity checks below would silently pass on nothing.
    expect(withFlags.length).toBeGreaterThan(15);
  });

  test('--apply and --dry-run are valid root-program options', () => {
    const rootHelp = getHelpText([]);
    for (const flagName of GLOBAL_FLAGS) {
      expect(rootHelp).toContain(flagName);
    }
  });

  for (const usage of usages) {
    const flags = usage.flags.filter((f) => !GLOBAL_FLAGS.has(f));
    if (flags.length === 0 || usage.cliPrefix.length === 0) continue;

    test(`${usage.name}: every mapped flag exists on \`localpress ${usage.cliPrefix.join(' ')}\``, () => {
      const help = getHelpText(usage.cliPrefix);
      expect(help).not.toContain('unknown command');
      for (const flagName of flags) {
        expect(help, `${usage.name} maps to ${flagName}, but it's missing from --help`).toContain(
          flagName,
        );
      }
    });
  }
});
