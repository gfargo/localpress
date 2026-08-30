/**
 * ONNX model manager for background removal.
 *
 * Downloads and caches models in the localpress config directory.
 * Models are downloaded on first use and reused from cache thereafter.
 *
 * Supported models:
 *   - u2net: General-purpose salient object detection (~176MB, Apache-2.0)
 *   - u2netp: Lightweight variant (~4.7MB, Apache-2.0)
 *   - silueta: Optimized u2net variant (~44MB, Apache-2.0)
 *   - isnet-general-use: ISNet general-purpose model (~176MB, Apache-2.0) — better edge quality
 *   - birefnet-lite: BiRefNet lightweight variant (~224MB, MIT) — state-of-the-art quality
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../../cli/utils/config.ts';

const MODEL_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MODEL_DOWNLOAD_RETRIES = 2;
const MODEL_LOCK_TIMEOUT_MS = 10 * 60_000;
const MODEL_LOCK_STALE_MS = 15 * 60_000;
const MODEL_CHECKSUM_DISABLED_ENV = 'MODEL_CHECKSUM_DISABLED';

export type ModelName = 'u2net' | 'u2netp' | 'silueta' | 'isnet-general-use' | 'birefnet-lite';

export interface ModelInfo {
  name: ModelName;
  url: string;
  filename: string;
  sizeApprox: string;
  license: string;
  sizeBytes: number;
  checksum: `md5:${string}` | `sha256:${string}`;
}

/**
 * Model registry. Primary URLs are GitHub release assets (no auth required).
 * HuggingFace mirrors are kept as fallback comments but now require auth.
 */
const MODEL_REGISTRY: Record<ModelName, ModelInfo> = {
  u2net: {
    name: 'u2net',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx',
    filename: 'u2net.onnx',
    sizeApprox: '~176 MB',
    license: 'Apache-2.0',
    sizeBytes: 175_997_641,
    checksum: 'md5:60024c5c889badc19c04ad937298a77b',
  },
  u2netp: {
    name: 'u2netp',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    filename: 'u2netp.onnx',
    sizeApprox: '~4.7 MB',
    license: 'Apache-2.0',
    sizeBytes: 4_574_861,
    checksum: 'md5:8e83ca70e441ab06c318d82300c84806',
  },
  silueta: {
    name: 'silueta',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx',
    filename: 'silueta.onnx',
    sizeApprox: '~44 MB',
    license: 'Apache-2.0',
    sizeBytes: 44_173_029,
    checksum: 'md5:55e59e0d8062d2f5d013f4725ee84782',
  },
  'isnet-general-use': {
    name: 'isnet-general-use',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    filename: 'isnet-general-use.onnx',
    sizeApprox: '~176 MB',
    license: 'Apache-2.0',
    sizeBytes: 178_648_008,
    checksum: 'md5:fc16ebd8b0c10d971d3513d564d01e29',
  },
  'birefnet-lite': {
    name: 'birefnet-lite',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/f82954f197e4671c1934c01d7dd85b9687c011b9/onnx/model.onnx',
    filename: 'birefnet-lite.onnx',
    sizeApprox: '~224 MB',
    license: 'MIT',
    sizeBytes: 224_005_088,
    checksum: 'sha256:5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333',
  },
};

/**
 * Default background-removal model.
 *
 * `isnet-general-use` rather than `u2net`: on the checked-in photorealistic
 * fixture, u2net and silueta both discard low-contrast clothing entirely —
 * a cream sweater against a light background reads as non-salient, so the
 * subject gets cut off at the neck (IoU 0.78 / 0.73 against a 0.85 floor).
 * isnet clears every floor and leaves markedly less colour fringing at hair
 * and glass edges. It costs roughly 2x the inference time (~4s vs ~2s per
 * image on CPU) for the same ~176 MB download. See test/quality/.
 */
export const DEFAULT_MODEL: ModelName = 'isnet-general-use';

export function isModelName(name: string): name is ModelName {
  return Object.hasOwn(MODEL_REGISTRY, name);
}

export function getModelInfo(name: ModelName): ModelInfo {
  return { ...MODEL_REGISTRY[name] };
}

export function listAvailableModels(): ModelInfo[] {
  return Object.values(MODEL_REGISTRY).map((model) => ({ ...model }));
}

/** Get the directory where models are cached. */
export function getModelsDir(): string {
  return join(getConfigDir(), 'models');
}

/** Get the full path to a cached model file. */
export function getModelPath(name: ModelName): string {
  const info = MODEL_REGISTRY[name];
  return join(getModelsDir(), info.filename);
}

/** Check if a model is already downloaded. */
export function isModelCached(name: ModelName): boolean {
  const modelPath = getModelPath(name);
  if (!existsSync(modelPath)) return false;
  try {
    const stat = statSync(modelPath);
    return (
      stat.isFile() &&
      stat.size > 0 &&
      (isChecksumDisabled() || stat.size === MODEL_REGISTRY[name].sizeBytes)
    );
  } catch {
    return false;
  }
}

/**
 * Ensure a model is available locally. Downloads if not cached.
 * Returns the path to the model file.
 */
export async function ensureModel(
  name: ModelName,
  onProgress?: (message: string) => void,
): Promise<string> {
  const modelPath = getModelPath(name);
  const info = MODEL_REGISTRY[name];
  const modelsDir = getModelsDir();
  mkdirSync(modelsDir, { recursive: true });

  if (await useValidCachedModel(modelPath, info, onProgress)) return modelPath;

  const lockPath = `${modelPath}.lock`;
  await acquireModelLock(lockPath, name, onProgress);

  try {
    // A second localpress process may have completed the download while this
    // process waited for the lock.
    if (await useValidCachedModel(modelPath, info, onProgress)) return modelPath;

    onProgress?.(`Downloading model '${name}' (${info.sizeApprox})...`);
    onProgress?.(`  Source: ${info.url}`);
    onProgress?.(`  License: ${info.license}`);

    const downloaded = await downloadModelFile(info, modelPath, onProgress);
    onProgress?.(`  ✓ Model saved to ${modelPath} (${(downloaded / (1024 * 1024)).toFixed(1)} MB)`);

    return modelPath;
  } finally {
    rmSync(lockPath, { force: true });
  }
}

class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ModelDownloadError';
  }
}

async function downloadModelFile(
  info: ModelInfo,
  modelPath: string,
  onProgress?: (message: string) => void,
): Promise<number> {
  const partialPath = `${modelPath}.partial`;

  for (let attempt = 0; attempt <= MODEL_DOWNLOAD_RETRIES; attempt += 1) {
    let partialFd: number | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_DOWNLOAD_TIMEOUT_MS);

    try {
      let requestedOffset = partialFileSize(partialPath, info.sizeBytes);
      const headers = requestedOffset > 0 ? { Range: `bytes=${requestedOffset}-` } : undefined;
      const response = await fetch(info.url, {
        redirect: 'follow',
        signal: controller.signal,
        headers,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelDownloadError(
          `Failed to download model '${info.name}': ${response.status} ${response.statusText}`,
          response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500,
        );
      }

      const contentType = response.headers.get('content-type')?.toLowerCase();
      if (contentType?.startsWith('text/') || contentType?.includes('json')) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelDownloadError(
          `Failed to download model '${info.name}': server returned ${contentType} instead of an ONNX file.`,
          false,
        );
      }

      const contentLength = parsePositiveHeader(response.headers.get('content-length'));
      const contentRange = parseContentRange(response.headers.get('content-range'));
      const canResume =
        requestedOffset > 0 && response.status === 206 && contentRange?.start === requestedOffset;
      if (!canResume) requestedOffset = 0;

      const checksumDisabled = isChecksumDisabled();
      const reportedTotal = canResume
        ? (contentRange?.total ?? (contentLength ? requestedOffset + contentLength : 0))
        : contentLength;
      if (!checksumDisabled && reportedTotal > 0 && reportedTotal !== info.sizeBytes) {
        throw new ModelDownloadError(
          `Model '${info.name}' has an unexpected size: expected ${info.sizeBytes} bytes, server reported ${reportedTotal}.`,
          false,
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new ModelDownloadError('Failed to get response body reader.', true);
      }

      const [algorithm, expectedDigest] = splitChecksum(info.checksum);
      const hash = createHash(algorithm);
      if (canResume) {
        await updateHashFromFile(hash, partialPath);
        onProgress?.(`  Resuming at ${(requestedOffset / (1024 * 1024)).toFixed(1)} MB...`);
      }

      partialFd = openSync(partialPath, canResume ? 'a' : 'w');
      let downloaded = requestedOffset;
      let receivedThisAttempt = 0;
      let lastReportedPercent = -5;
      const expectedTotal = checksumDisabled ? reportedTotal : info.sizeBytes;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        let chunkOffset = 0;
        while (chunkOffset < value.length) {
          chunkOffset += writeSync(partialFd, value, chunkOffset, value.length - chunkOffset, null);
        }
        downloaded += value.length;
        receivedThisAttempt += value.length;
        hash.update(value);

        if (!checksumDisabled && downloaded > info.sizeBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ModelDownloadError(
            `Model '${info.name}' exceeded its expected size of ${info.sizeBytes} bytes.`,
            false,
          );
        }

        if (expectedTotal > 0) {
          const percent = Math.min(100, Math.floor((downloaded / expectedTotal) * 100));
          if (percent >= lastReportedPercent + 5 || percent === 100) {
            lastReportedPercent = percent;
            onProgress?.(`  Progress: ${(downloaded / (1024 * 1024)).toFixed(1)} MB (${percent}%)`);
          }
        }
      }

      closeSync(partialFd);
      partialFd = null;

      if (contentLength > 0 && receivedThisAttempt !== contentLength) {
        throw new ModelDownloadError(
          `Downloaded model '${info.name}' is incomplete: expected ${contentLength} new bytes, got ${receivedThisAttempt}. Please retry.`,
          true,
        );
      }
      if (expectedTotal > 0 && downloaded !== expectedTotal) {
        throw new ModelDownloadError(
          `Downloaded model '${info.name}' is incomplete: expected ${expectedTotal} bytes, got ${downloaded}. Please retry.`,
          true,
        );
      }

      const actualDigest = hash.digest('hex');
      if (!checksumDisabled && actualDigest !== expectedDigest) {
        rmSync(partialPath, { force: true });
        throw new ModelDownloadError(
          `Checksum verification failed for model '${info.name}'. The downloaded file was discarded.`,
          attempt < MODEL_DOWNLOAD_RETRIES,
        );
      }

      renameSync(partialPath, modelPath);
      writeIntegrityRecord(modelPath, info, downloaded, actualDigest, algorithm);
      return downloaded;
    } catch (caught) {
      const error = normalizeModelDownloadError(caught, controller.signal.aborted, info.name);
      if (attempt >= MODEL_DOWNLOAD_RETRIES || !error.retryable) {
        rmSync(partialPath, { force: true });
        throw error;
      }
      onProgress?.(
        `  Download interrupted; retrying (${attempt + 2}/${MODEL_DOWNLOAD_RETRIES + 1})...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
      if (partialFd !== null) closeSync(partialFd);
    }
  }

  throw new Error(`Failed to download model '${info.name}'.`);
}

function partialFileSize(partialPath: string, expectedSize: number): number {
  try {
    const size = statSync(partialPath).size;
    if (size > 0 && size < expectedSize) return size;
  } catch {
    return 0;
  }
  rmSync(partialPath, { force: true });
  return 0;
}

function parsePositiveHeader(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function parseContentRange(value: string | null): { start: number; total: number } | null {
  const match = value?.match(/^bytes (\d+)-\d+\/(\d+|\*)$/i);
  if (!match) return null;
  return { start: Number(match[1]), total: match[2] === '*' ? 0 : Number(match[2]) };
}

function updateHashFromFile(hash: ReturnType<typeof createHash>, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

function normalizeModelDownloadError(
  caught: unknown,
  timedOut: boolean,
  name: ModelName,
): ModelDownloadError {
  if (caught instanceof ModelDownloadError) return caught;
  if (timedOut || (caught instanceof DOMException && caught.name === 'AbortError')) {
    return new ModelDownloadError(`Downloading model '${name}' timed out. Please retry.`, true);
  }
  const detail = caught instanceof Error ? caught.message : String(caught);
  return new ModelDownloadError(`Downloading model '${name}' failed: ${detail}`, true);
}

async function useValidCachedModel(
  modelPath: string,
  info: ModelInfo,
  onProgress?: (message: string) => void,
): Promise<boolean> {
  if (!existsSync(modelPath)) return false;
  if (isChecksumDisabled()) {
    try {
      const stat = statSync(modelPath);
      if (stat.isFile() && stat.size > 0) {
        onProgress?.(`Model '${info.name}' found in cache (checksum verification disabled).`);
        return true;
      }
    } catch {
      // Replace unusable cache entries below.
    }
    rmSync(modelPath, { recursive: true, force: true });
    return false;
  }

  try {
    const stat = statSync(modelPath);
    if (!stat.isFile() || stat.size !== info.sizeBytes) {
      throw new Error(`expected ${info.sizeBytes} bytes, found ${stat.size}`);
    }
    const [algorithm, expectedDigest] = splitChecksum(info.checksum);
    const actualDigest = await hashFile(modelPath, algorithm);
    if (actualDigest !== expectedDigest) throw new Error('checksum mismatch');
    writeIntegrityRecord(modelPath, info, stat.size, actualDigest, algorithm);
    onProgress?.(`Model '${info.name}' found in cache (integrity verified).`);
    return true;
  } catch (caught) {
    const detail = caught instanceof Error ? caught.message : String(caught);
    onProgress?.(
      `Cached model '${info.name}' failed integrity verification (${detail}); replacing it.`,
    );
    rmSync(modelPath, { force: true });
    rmSync(`${modelPath}.integrity.json`, { force: true });
    return false;
  }
}

async function acquireModelLock(
  lockPath: string,
  name: ModelName,
  onProgress?: (message: string) => void,
): Promise<void> {
  const startedAt = Date.now();
  let reportedWait = false;

  while (true) {
    try {
      const fd = openSync(lockPath, 'wx');
      closeSync(fd);
      return;
    } catch (caught) {
      const err = caught as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw caught;

      try {
        if (Date.now() - statSync(lockPath).mtimeMs > MODEL_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }

      if (!reportedWait) {
        onProgress?.(`Another process is downloading model '${name}'; waiting for it to finish...`);
        reportedWait = true;
      }
      if (Date.now() - startedAt > MODEL_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the '${name}' model download lock.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function splitChecksum(checksum: ModelInfo['checksum']): ['md5' | 'sha256', string] {
  const [algorithm, digest] = checksum.split(':', 2);
  return [algorithm as 'md5' | 'sha256', digest];
}

function hashFile(path: string, algorithm: 'md5' | 'sha256'): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function writeIntegrityRecord(
  modelPath: string,
  info: ModelInfo,
  sizeBytes: number,
  digest: string,
  algorithm: 'md5' | 'sha256',
): void {
  try {
    writeFileSync(
      `${modelPath}.integrity.json`,
      `${JSON.stringify({ version: 1, source: info.url, sizeBytes, algorithm, digest }, null, 2)}\n`,
    );
  } catch {
    // The sidecar is diagnostic only. Exact registry checksum verification is
    // the source of truth, so a read-only sidecar path must not discard a valid model.
  }
}

function isChecksumDisabled(): boolean {
  const value = process.env[MODEL_CHECKSUM_DISABLED_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
