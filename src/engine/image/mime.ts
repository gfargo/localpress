/** Shared MIME/extension lookups for image format conversion. */

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
};

const FORMAT_TO_MIME: Record<string, string> = {
  webp: 'image/webp',
  avif: 'image/avif',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
};

export function mimeToExtension(mimeType: string): string | undefined {
  return MIME_TO_EXTENSION[mimeType];
}

export function formatToMime(format: string): string {
  return FORMAT_TO_MIME[format] ?? `image/${format}`;
}
