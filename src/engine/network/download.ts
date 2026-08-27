import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 5_000;

export interface DownloadOptions {
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  headers?: RequestInit['headers'];
  expectedContentType?: string | RegExp | ((contentType: string) => boolean);
  fetchImpl?: FetchLike;
  retryDelay?: (delayMs: number) => Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DownloadResult {
  bytes: Buffer;
  sha256: string;
  contentType: string | null;
  finalUrl: string;
}

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid-url'
      | 'http-error'
      | 'timeout'
      | 'too-large'
      | 'invalid-content-type'
      | 'incomplete'
      | 'network-error',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/** Accept normal image responses and generic binary responses used by some CDNs. */
export function isImageContentType(contentType: string): boolean {
  return contentType.startsWith('image/') || contentType === 'application/octet-stream';
}

/**
 * Download a remote file with bounded memory use, retries, timeout handling,
 * and a SHA-256 digest produced while the response body is streamed.
 */
export async function downloadToBuffer(
  url: string | URL,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const parsedUrl = parseRemoteUrl(url);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const retries = nonNegativeInteger(options.retries, DEFAULT_RETRIES, 'retries');
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelay = options.retryDelay ?? delay;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(parsedUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: options.headers,
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const httpError = new DownloadError(
          `Download failed: ${response.status} ${response.statusText}`.trim(),
          'http-error',
          response.status,
        );
        if (attempt < retries && isRetryableStatus(response.status)) {
          lastError = httpError;
          await retryDelay(retryDelayMs(response, attempt));
          continue;
        }
        throw httpError;
      }

      const contentType = normalizeContentType(response.headers.get('content-type'));
      if (
        contentType &&
        options.expectedContentType &&
        !matchesContentType(contentType, options.expectedContentType)
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError(
          `Unexpected content type '${contentType}' while downloading ${parsedUrl}.`,
          'invalid-content-type',
        );
      }

      const declaredLength = parseContentLength(response.headers.get('content-length'));
      if (declaredLength !== null && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        throw new DownloadError(
          `Download is too large (${declaredLength} bytes; limit is ${maxBytes}).`,
          'too-large',
        );
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new DownloadError('Download response did not contain a body.', 'network-error');
      }

      const chunks: Uint8Array[] = [];
      const hash = createHash('sha256');
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new DownloadError(`Download exceeded the ${maxBytes}-byte limit.`, 'too-large');
        }
        chunks.push(value);
        hash.update(value);
      }

      if (declaredLength !== null && received !== declaredLength) {
        throw new DownloadError(
          `Incomplete download: expected ${declaredLength} bytes, received ${received}.`,
          'incomplete',
        );
      }

      return {
        bytes: Buffer.concat(chunks, received),
        sha256: hash.digest('hex'),
        contentType,
        finalUrl: response.url || parsedUrl.toString(),
      };
    } catch (caught) {
      const downloadError = normalizeDownloadError(caught, controller.signal.aborted, parsedUrl);
      lastError = downloadError;
      if (attempt >= retries || !isRetryableError(downloadError)) throw downloadError;
      await retryDelay(250 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new DownloadError(`Failed to download ${parsedUrl}.`, 'network-error');
}

function parseRemoteUrl(url: string | URL): URL {
  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    throw new DownloadError(`Invalid download URL: ${String(url)}`, 'invalid-url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadError(
      `Unsupported download protocol '${parsed.protocol}'. Only HTTP and HTTPS are allowed.`,
      'invalid-url',
    );
  }
  return parsed;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return resolved;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeContentType(value: string | null): string | null {
  return value?.split(';', 1)[0]?.trim().toLowerCase() || null;
}

function matchesContentType(
  contentType: string,
  expected: NonNullable<DownloadOptions['expectedContentType']>,
): boolean {
  if (typeof expected === 'function') return expected(contentType);
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(contentType);
  }
  return contentType === expected.toLowerCase();
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error: DownloadError): boolean {
  return error.code === 'timeout' || error.code === 'network-error' || error.code === 'incomplete';
}

function normalizeDownloadError(caught: unknown, timedOut: boolean, url: URL): DownloadError {
  if (caught instanceof DownloadError) return caught;
  if (timedOut || (caught instanceof DOMException && caught.name === 'AbortError')) {
    return new DownloadError(`Download timed out: ${url}`, 'timeout');
  }
  const detail = caught instanceof Error ? caught.message : String(caught);
  return new DownloadError(`Network error while downloading ${url}: ${detail}`, 'network-error');
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, seconds * 1_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, date - Date.now()));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** attempt);
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
