/**
 * Subprocess fixture for doctor-exit-code tests.
 *
 * Runs `localpress doctor` with a mock fetch that always throws TypeError
 * (simulating an unreachable host), so tests can exercise the NetworkError
 * exit-code path without real network I/O and without setting process.exitCode
 * in the test runner's own process (which would poison bun's test exit code).
 *
 * The rejection message is configurable via LOCALPRESS_TEST_FETCH_ERROR (default:
 * the Node/undici-style "fetch failed") so callers can also exercise Bun's real
 * rejection message ("Unable to connect. Is the computer able to access the
 * url?"), which never matched the old ENOTFOUND/ECONNREFUSED substring check.
 *
 * Usage (via Bun.spawnSync):
 *   bun run test/fixtures/doctor-unreachable.ts [doctor args...]
 *
 * The site config is read from XDG_CONFIG_HOME, which the caller seeds before
 * spawning this script.
 */

import { Command, Option } from 'commander';
import { registerDoctorCommand } from '../../src/cli/commands/doctor.ts';
import { setOutputOptions } from '../../src/cli/utils/output.ts';

// Mock fetch before any module that calls it is initialized.
const fetchErrorMessage = process.env.LOCALPRESS_TEST_FETCH_ERROR ?? 'fetch failed';
globalThis.fetch = (async () => {
  throw new TypeError(fetchErrorMessage);
}) as unknown as typeof fetch;

const program = new Command();
program
  .name('localpress')
  .exitOverride()
  .addOption(new Option('--site <name>', 'override the active site for this command'))
  .addOption(new Option('--json', 'machine-readable JSON output').default(false))
  .addOption(new Option('--quiet', 'errors only; suppress info messages').default(false))
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    setOutputOptions({ json: Boolean(opts.json), quiet: Boolean(opts.quiet) });
  });

registerDoctorCommand(program);

await program.parseAsync(process.argv.slice(2), { from: 'user' });
