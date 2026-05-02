/**
 * System rembg integration.
 *
 * For users who already have Python rembg installed, this provides a
 * --rembg flag that shells out to the system `rembg` command instead
 * of using our built-in ONNX pipeline. This gives access to rembg's
 * full model zoo and GPU acceleration without bundling Python.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SystemRembgOptions {
  /** rembg model name (e.g. 'u2net', 'isnet-general-use', 'birefnet-general'). */
  model?: string;
  /** Alpha matting. */
  alphaMatte?: boolean;
}

export interface SystemRembgResult {
  bytes: Buffer;
  durationMs: number;
}

/**
 * Check if the system `rembg` command is available.
 */
export async function isSystemRembgAvailable(): Promise<boolean> {
  try {
    const result = await execCommand('rembg', ['--version']);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Get the version of the system rembg installation.
 */
export async function getSystemRembgVersion(): Promise<string | null> {
  try {
    const result = await execCommand('rembg', ['--version']);
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove background using the system rembg command.
 *
 * Writes the input to a temp file, runs `rembg i`, and reads the output.
 */
export async function removeBackgroundWithSystemRembg(
  imageBytes: Buffer,
  options: SystemRembgOptions = {},
): Promise<SystemRembgResult> {
  const startTime = Date.now();

  const inputPath = join(tmpdir(), `localpress-rembg-in-${Date.now()}.png`);
  const outputPath = join(tmpdir(), `localpress-rembg-out-${Date.now()}.png`);

  // Write input file.
  await Bun.write(inputPath, imageBytes);

  // Build rembg command.
  const args = ['i'];
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.alphaMatte) {
    args.push('-a');
  }
  args.push(inputPath, outputPath);

  const result = await execCommand('rembg', args);

  if (result.exitCode !== 0) {
    // Clean up.
    cleanup(inputPath, outputPath);
    throw new Error(`rembg failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`);
  }

  // Read output file.
  const outputFile = Bun.file(outputPath);
  if (!(await outputFile.exists())) {
    cleanup(inputPath, outputPath);
    throw new Error('rembg did not produce an output file.');
  }

  const outputBytes = Buffer.from(await outputFile.arrayBuffer());
  const durationMs = Date.now() - startTime;

  // Clean up temp files.
  cleanup(inputPath, outputPath);

  return { bytes: outputBytes, durationMs };
}

// -- Helpers ------------------------------------------------------------------

function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      const { unlinkSync } = require('node:fs');
      unlinkSync(p);
    } catch {
      // Best effort.
    }
  }
}

function execCommand(
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute ${command}: ${err.message}`));
    });

    proc.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}
