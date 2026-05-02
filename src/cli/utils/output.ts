/**
 * Output formatting helpers.
 *
 * Two output modes:
 *   - default: human-readable, with optional Ink-rendered progress for bulk ops
 *   - --json:  newline-delimited JSON to stdout, structured records to stderr
 *
 * Skills always pass --json. Humans get the default. We pick automatically
 * if stdout is a pipe (tty=false) — though --json wins if explicitly set.
 */

export interface OutputOptions {
  json: boolean;
  quiet: boolean;
}

let currentOptions: OutputOptions = { json: false, quiet: false };

export function setOutputOptions(opts: Partial<OutputOptions>): void {
  currentOptions = { ...currentOptions, ...opts };
}

export function getOutputOptions(): OutputOptions {
  return currentOptions;
}

/**
 * Print a human-readable line. Suppressed if --quiet or --json.
 * For --json mode, use printJson() instead.
 */
export function info(message: string): void {
  if (currentOptions.quiet || currentOptions.json) return;
  process.stdout.write(`${message}\n`);
}

/**
 * Print a warning to stderr. Honored even in --quiet mode.
 * In --json mode, emits as a JSON object on stderr.
 */
export function warn(message: string): void {
  if (currentOptions.json) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', message })}\n`);
  } else {
    process.stderr.write(`warning: ${message}\n`);
  }
}

/** Print an error to stderr. */
export function error(message: string): void {
  if (currentOptions.json) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message })}\n`);
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
}

/**
 * Emit a structured record to stdout. Used in --json mode.
 * In human mode, falls back to a pretty-printed representation.
 */
export function printJson<T>(record: T): void {
  if (currentOptions.json) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } else if (!currentOptions.quiet) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  }
}

/**
 * v0.1 placeholder: every command stub calls this so users see something
 * useful while we fill in implementations.
 */
export function notImplemented(commandPath: string, plannedMilestone = 'v0.1'): never {
  const message = `${commandPath} is not yet implemented in this scaffold (planned: ${plannedMilestone}).`;
  error(message);
  error('See docs/v1-plan.md for the implementation roadmap.');
  process.exit(99); // ExitCode.NotImplemented
}
