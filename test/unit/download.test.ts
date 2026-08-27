import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  DownloadError,
  type FetchLike,
  downloadToBuffer,
  isImageContentType,
} from '../../src/engine/network/download.ts';

const noDelay = async () => {};

describe('downloadToBuffer', () => {
  test('streams bytes and returns metadata plus a SHA-256 digest', async () => {
    const payload = Buffer.from('safe download');
    const result = await downloadToBuffer('https://example.com/photo.png', {
      fetchImpl: mockFetch(
        new Response(payload, {
          headers: {
            'content-length': String(payload.length),
            'content-type': 'image/png; charset=binary',
          },
        }),
      ),
    });

    expect(result.bytes).toEqual(payload);
    expect(result.contentType).toBe('image/png');
    expect(result.finalUrl).toBe('https://example.com/photo.png');
    expect(result.sha256).toBe(createHash('sha256').update(payload).digest('hex'));
  });

  test('rejects non-HTTP URLs before calling fetch', async () => {
    let called = false;
    const promise = downloadToBuffer('file:///tmp/photo.png', {
      fetchImpl: async () => {
        called = true;
        return new Response();
      },
    });

    await expect(promise).rejects.toMatchObject({ code: 'invalid-url' });
    expect(called).toBe(false);
  });

  test('rejects an oversized declared response before reading it', async () => {
    const response = new Response('small', {
      headers: { 'content-length': '1000' },
    });

    await expect(
      downloadToBuffer('https://example.com/large.bin', {
        fetchImpl: mockFetch(response),
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  test('stops a streamed response when the actual bytes exceed the limit', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8));
          controller.enqueue(new Uint8Array(8));
          controller.close();
        },
      }),
    );

    await expect(
      downloadToBuffer('https://example.com/growing.bin', {
        fetchImpl: mockFetch(response),
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });

  test('times out and aborts a stalled request', async () => {
    const stalledFetch: FetchLike = (_, init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });

    await expect(
      downloadToBuffer('https://example.com/stalled.bin', {
        fetchImpl: stalledFetch,
        retries: 0,
        timeoutMs: 10,
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  test('retries transient HTTP responses and honors Retry-After', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('busy', {
          status: 503,
          headers: { 'retry-after': '2' },
        });
      }
      return new Response('ready');
    };

    const result = await downloadToBuffer('https://example.com/retry.bin', {
      fetchImpl,
      retryDelay: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    expect(result.bytes.toString()).toBe('ready');
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  test('retries an incomplete response and reports the final failure', async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts += 1;
      return new Response('short', { headers: { 'content-length': '10' } });
    };

    await expect(
      downloadToBuffer('https://example.com/incomplete.bin', {
        fetchImpl,
        retries: 1,
        retryDelay: noDelay,
      }),
    ).rejects.toMatchObject({ code: 'incomplete' });
    expect(attempts).toBe(2);
  });

  test('rejects an explicit, unexpected content type', async () => {
    await expect(
      downloadToBuffer('https://example.com/not-an-image', {
        fetchImpl: mockFetch(
          new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
        ),
        expectedContentType: isImageContentType,
      }),
    ).rejects.toBeInstanceOf(DownloadError);
  });

  test('accepts image and generic binary MIME types for image downloads', () => {
    expect(isImageContentType('image/webp')).toBe(true);
    expect(isImageContentType('application/octet-stream')).toBe(true);
    expect(isImageContentType('text/html')).toBe(false);
  });
});

function mockFetch(response: Response): FetchLike {
  return async () => response;
}
