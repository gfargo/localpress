/**
 * Background-removal quality regression gate (localpress#336).
 *
 * This suite used to exercise only `u2netp` while `DEFAULT_MODEL` was `u2net`,
 * so it passed green while the model users actually got by default failed the
 * very floors this file defines. Every model is now measured, and each carries
 * its own floors — including the two that are genuinely weak on portraits, so
 * that weakness is recorded by the suite instead of hidden from it.
 *
 * Run it before a background-removal release:
 *
 *   bun run test:quality
 *
 * Models are downloaded on first use (~620 MB for the full set) and cached in
 * the localpress config dir. To limit the sweep while iterating:
 *
 *   LOCALPRESS_QUALITY_MODELS=u2netp,isnet-general-use bun run test:quality
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import sharp from 'sharp';
import { DEFAULT_MODEL, type ModelName } from '../../src/engine/rembg/models.ts';
import { BackgroundRemovalSession } from '../../src/engine/rembg/remove-bg.ts';

const runQualityTest = process.env.LOCALPRESS_RUN_MODEL_QUALITY === '1' ? test : test.skip;
const fixturePath = join(
  import.meta.dir,
  '..',
  'fixtures',
  'remove-bg',
  'photorealistic-cutouts.png',
);

/** Quadrant of the checked-in fixture, with the alpha it should recover. */
interface Subject {
  name: string;
  quadrant: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

const SUBJECTS: Subject[] = [
  { name: 'curly-hair portrait', quadrant: 'top-left' },
  { name: 'long-haired dog', quadrant: 'top-right' },
  { name: 'clear glass', quadrant: 'bottom-left' },
  { name: 'canvas sneaker', quadrant: 'bottom-right' },
];

/**
 * Per-model IoU floors, set ~0.02–0.03 below measured values.
 *
 * ONNX CPU inference is deterministic, so these are stable run to run; the
 * margin is there to absorb codec/library drift, not model nondeterminism.
 *
 * `knownWeakness` documents a floor that is deliberately low because the model
 * genuinely fails that subject. It is asserted like any other floor — the point
 * is that a regression still trips the gate — but it is printed loudly so the
 * number is never mistaken for an endorsement.
 */
interface ModelExpectation {
  floors: Record<string, number>;
  knownWeakness?: Record<string, string>;
}

const EXPECTATIONS: Record<ModelName, ModelExpectation> = {
  'isnet-general-use': {
    floors: {
      'curly-hair portrait': 0.89,
      'long-haired dog': 0.93,
      'clear glass': 0.95,
      'canvas sneaker': 0.96,
    },
  },
  'birefnet-lite': {
    floors: {
      'curly-hair portrait': 0.87,
      'long-haired dog': 0.91,
      'clear glass': 0.97,
      'canvas sneaker': 0.97,
    },
  },
  u2netp: {
    floors: {
      'curly-hair portrait': 0.88,
      'long-haired dog': 0.93,
      'clear glass': 0.89,
      'canvas sneaker': 0.94,
    },
  },
  u2net: {
    floors: {
      'curly-hair portrait': 0.75,
      'long-haired dog': 0.93,
      'clear glass': 0.95,
      'canvas sneaker': 0.95,
    },
    knownWeakness: {
      'curly-hair portrait':
        'drops the low-contrast cream sweater and cuts the subject off at the neck (recall ~0.78)',
    },
  },
  silueta: {
    floors: {
      'curly-hair portrait': 0.71,
      'long-haired dog': 0.93,
      'clear glass': 0.95,
      'canvas sneaker': 0.95,
    },
    knownWeakness: {
      'curly-hair portrait':
        'drops the low-contrast cream sweater even more aggressively than u2net (recall ~0.73)',
    },
  },
};

/** Precision floor shared by every model — none of them should bleed background in. */
const PRECISION_FLOOR = 0.9;

function selectedModels(): ModelName[] {
  const requested = process.env.LOCALPRESS_QUALITY_MODELS?.trim();
  const all = Object.keys(EXPECTATIONS) as ModelName[];
  if (!requested) return all;
  const names = requested.split(',').map((n) => n.trim());
  const unknown = names.filter((n) => !all.includes(n as ModelName));
  if (unknown.length > 0) {
    throw new Error(
      `LOCALPRESS_QUALITY_MODELS names unknown model(s): ${unknown.join(', ')}. Known: ${all.join(', ')}`,
    );
  }
  return names as ModelName[];
}

interface QualityMetrics {
  iou: number;
  precision: number;
  recall: number;
}

describe('background-removal photorealistic quality', () => {
  for (const model of selectedModels()) {
    const expectation = EXPECTATIONS[model];

    runQualityTest(
      `${model} keeps foreground masks within its quality floor`,
      async () => {
        const metadata = await sharp(fixturePath).metadata();
        const width = Math.floor((metadata.width ?? 0) / 2);
        const height = Math.floor((metadata.height ?? 0) / 2);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);

        const session = await BackgroundRemovalSession.create(model);
        try {
          for (const subject of SUBJECTS) {
            const { left, top } = quadrantOrigin(subject.quadrant, width, height);
            const cutout = await sharp(fixturePath)
              .extract({ left, top, width, height })
              .png()
              .toBuffer();
            const source = await sharp(busyBackground(width, height))
              .composite([{ input: cutout, left: 0, top: 0 }])
              .png()
              .toBuffer();

            const result = await session.remove(source);
            const metrics = maskMetrics(
              await alphaChannel(result.bytes),
              await alphaChannel(cutout),
            );

            const floor = expectation.floors[subject.name];
            if (floor === undefined) {
              throw new Error(`No floor defined for ${model} / ${subject.name}`);
            }
            const weakness = expectation.knownWeakness?.[subject.name];

            console.log(
              `${model} · ${subject.name}: IoU=${metrics.iou.toFixed(3)} ` +
                `precision=${metrics.precision.toFixed(3)} recall=${metrics.recall.toFixed(3)} ` +
                `(floor ${floor.toFixed(2)})${weakness ? `  ⚠ KNOWN WEAKNESS: ${weakness}` : ''}`,
            );

            expect(metrics.iou).toBeGreaterThanOrEqual(floor);
            expect(metrics.precision).toBeGreaterThanOrEqual(PRECISION_FLOOR);
            expect(metrics.recall).toBeGreaterThanOrEqual(floor);
          }
        } finally {
          await session.release();
        }
      },
      600_000,
    );
  }

  /**
   * The default is what the overwhelming majority of runs actually use, so it
   * is held to a stricter, explicit bar: no known weaknesses, and a portrait
   * floor that `u2net` and `silueta` cannot meet. This is the assertion that
   * would have caught the original bug.
   */
  test('the default model has no known weaknesses and clears the portrait bar', () => {
    const expectation = EXPECTATIONS[DEFAULT_MODEL];

    expect(expectation).toBeDefined();
    expect(expectation.knownWeakness).toBeUndefined();
    expect(expectation.floors['curly-hair portrait']).toBeGreaterThanOrEqual(0.85);
  });
});

function quadrantOrigin(
  quadrant: Subject['quadrant'],
  width: number,
  height: number,
): { left: number; top: number } {
  switch (quadrant) {
    case 'top-left':
      return { left: 0, top: 0 };
    case 'top-right':
      return { left: width, top: 0 };
    case 'bottom-left':
      return { left: 0, top: height };
    case 'bottom-right':
      return { left: width, top: height };
  }
}

/** A deliberately busy, high-contrast background so a lazy matte can't score well. */
function busyBackground(width: number, height: number): Buffer {
  return Buffer.from(`
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
}

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
