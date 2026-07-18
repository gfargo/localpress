/**
 * Unit tests for the `localpress verify` command registration.
 *
 * Regression test for #195: `verify` was registered with a required
 * `<ids...>` positional, which made commander reject `verify --all`
 * before the action ever ran. Locks in the fix (`[ids...]`, optional).
 */

import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerVerifyCommand } from '../../src/cli/commands/verify.ts';

describe('verify command registration', () => {
  test('verify command is registered in the CLI', async () => {
    const mod = await import('../../src/cli/commands/verify.ts');
    expect(mod.registerVerifyCommand).toBeFunction();
  });

  test('the ids positional is optional, so --all is reachable', () => {
    const program = new Command();
    registerVerifyCommand(program);

    const verify = program.commands.find((cmd) => cmd.name() === 'verify');
    expect(verify).toBeDefined();
    expect(verify?.registeredArguments).toHaveLength(1);
    expect(verify?.registeredArguments[0]?.required).toBe(false);
  });
});
