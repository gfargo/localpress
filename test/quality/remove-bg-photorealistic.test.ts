import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import sharp from 'sharp';
import { BackgroundRemovalSession } from '../../src/engine/rembg/remove-bg.ts';

const runQualityTest = process.env.LOCALPRESS_RUN_MODEL_QUALITY === '1' ? test : test.skip;
const fixturePath = join(
  import.meta.dir,
  '..',
  'fixtures',
  'remove-bg',
  'photorealistic-cutouts.png',
);

interface QualityMetrics {
  iou: number;
  precision: number;
  recall: number;
}

describe('background-removal photorealistic quality', () => {
  runQualityTest(
    'keeps foreground masks within the checked-in u2netp quality floor',
    async () => {
      const metadata = await sharp(fixturePath).metadata();
      const width = Math.floor((metadata.width ?? 0) / 2);
      const height = Math.floor((metadata.height ?? 0) / 2);
      expect(width).toBeGreaterThan(0);
      expect(height).toBeGreaterThan(0);

      const fixtures = [
        { name: 'curly-hair portrait', left: 0, top: 0, minimumIou: 0.85 },
        { name: 'long-haired dog', left: width, top: 0, minimumIou: 0.9 },
        { name: 'clear glass', left: 0, top: height, minimumIou: 0.85 },
        { name: 'canvas sneaker', left: width, top: height, minimumIou: 0.92 },
      ];

      const session = await BackgroundRemovalSession.create('u2netp');
      try {
        for (const fixture of fixtures) {
          const cutout = await sharp(fixturePath)
            .extract({ left: fixture.left, top: fixture.top, width, height })
            .png()
            .toBuffer();
          const background = Buffer.from(`
            <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stop-color="#1d4ed8"/>
                  <stop offset="0.5" stop-color="#f59e0b"/>
                  <stop offset="1" stop-color="#14532d"/>
                </linearGradient>
                <pattern id="p" width="48" height="48" patternUnits="userSpaceOnUse">
                  <rect width="48" height="48" fill="url(#g)"/>
                  <circle cx="12" cy="12" r="7" fill="#f8fafc" fill-opacity="0.55"/>
                  <path d="M0 40 L48 8" stroke="#111827" stroke-width="6" stroke-opacity="0.28"/>
                </pattern>
              </defs>
              <rect width="100%" height="100%" fill="url(#p)"/>
            </svg>
          `);
          const source = await sharp(background)
            .composite([{ input: cutout, left: 0, top: 0 }])
            .png()
            .toBuffer();

          const result = await session.remove(source);
          const expectedAlpha = await alphaChannel(cutout);
          const actualAlpha = await alphaChannel(result.bytes);
          const metrics = maskMetrics(actualAlpha, expectedAlpha);

          console.log(
            `${fixture.name}: IoU=${metrics.iou.toFixed(3)} precision=${metrics.precision.toFixed(3)} recall=${metrics.recall.toFixed(3)}`,
          );
          expect(metrics.iou).toBeGreaterThanOrEqual(fixture.minimumIou);
          expect(metrics.precision).toBeGreaterThanOrEqual(0.9);
          expect(metrics.recall).toBeGreaterThanOrEqual(fixture.minimumIou);
        }
      } finally {
        await session.release();
      }
    },
    180_000,
  );
});

async function alphaChannel(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const alpha = Buffer.allocUnsafe(info.width * info.height);
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    alpha[pixel] = data[pixel * info.channels + 3];
  }
  return alpha;
}

function maskMetrics(actual: Buffer, expected: Buffer): QualityMetrics {
  expect(actual.length).toBe(expected.length);
  let intersection = 0;
  let union = 0;
  let predicted = 0;
  let foreground = 0;

  for (let index = 0; index < actual.length; index += 1) {
    const actualForeground = actual[index] >= 32;
    const expectedForeground = expected[index] >= 32;
    if (actualForeground) predicted += 1;
    if (expectedForeground) foreground += 1;
    if (actualForeground && expectedForeground) intersection += 1;
    if (actualForeground || expectedForeground) union += 1;
  }

  return {
    iou: intersection / Math.max(1, union),
    precision: intersection / Math.max(1, predicted),
    recall: intersection / Math.max(1, foreground),
  };
}
