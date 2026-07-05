/**
 * Background removal engine using ONNX Runtime + U2-Net.
 *
 * Takes an image buffer, runs it through the U2-Net salient object detection
 * model, and returns a PNG with the background removed (transparent alpha).
 *
 * The pipeline:
 *   1. Resize input to 320×320 (model's expected input size)
 *   2. Normalize pixel values to [0, 1] with per-channel mean/std
 *   3. Run inference through ONNX Runtime
 *   4. Extract the mask from the model output
 *   5. Resize mask back to original dimensions
 *   6. Apply mask as alpha channel to the original image
 *   7. Output as PNG (to preserve transparency)
 *
 * This is essentially what rembg does under the hood, reimplemented in
 * TypeScript with onnxruntime-node to avoid the AGPL-3.0 @imgly dependency.
 */

import type { ModelName } from './models.ts';
import { ensureModel } from './models.ts';

/** Input size expected by each model family. */
const MODEL_INPUT_SIZES: Record<string, number> = {
  u2net: 320,
  u2netp: 320,
  silueta: 320,
  'isnet-general-use': 1024,
  'birefnet-lite': 1024,
};

/** Models that use BiRefNet-style preprocessing (rescale only, sigmoid output). */
const BIREFNET_MODELS = new Set(['birefnet-lite']);

/** Normalization constants (ImageNet-style). */
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface RemoveBgOptions {
  /** Which model to use. Default: 'u2net'. */
  model?: ModelName;
  /** Whether to trim transparent borders from the output. Default: false. */
  trim?: boolean;
  /** Background color to use instead of transparency (hex, e.g. '#ffffff'). */
  backgroundColor?: string;
  /** Alpha matting threshold (0-255). Pixels above this are foreground. Default: 10. */
  alphaThreshold?: number;
  /** Progress callback for model download. */
  onProgress?: (message: string) => void;
}

export interface RemoveBgResult {
  /** Output image bytes (PNG with alpha channel). */
  bytes: Buffer;
  /** Original dimensions. */
  width: number;
  height: number;
  /** Model used. */
  model: ModelName;
  /** Inference time in milliseconds. */
  inferenceMs: number;
  /** Total processing time in milliseconds. */
  totalMs: number;
}

/**
 * Remove the background from an image.
 *
 * Returns a PNG buffer with the background replaced by transparency
 * (or a solid color if backgroundColor is specified).
 */
export async function removeBackground(
  imageBytes: Buffer,
  options: RemoveBgOptions = {},
): Promise<RemoveBgResult> {
  const totalStart = Date.now();
  const modelName = options.model ?? 'u2net';
  const alphaThreshold = options.alphaThreshold ?? 10;
  const modelInputSize = MODEL_INPUT_SIZES[modelName] ?? 320;

  // 1. Ensure the model is downloaded.
  const modelPath = await ensureModel(modelName, options.onProgress);

  // 2. Lazy-load dependencies.
  const { loadSharp } = await import('../image/sharp-loader.ts');
  const sharp = await loadSharp();
  // onnxruntime-node is loaded dynamically — it has native binaries that
  // may not be present at typecheck time or in all environments.
  const ort = (await import('onnxruntime-node')) as import('./onnx-types.ts').OnnxRuntime;

  // 3. Load and prepare the input image.
  const inputImage = sharp(imageBytes);
  const metadata = await inputImage.metadata();
  const origWidth = metadata.width ?? 0;
  const origHeight = metadata.height ?? 0;

  // Resize to model input size and extract raw RGB pixels.
  const resizedBuffer = await sharp(imageBytes)
    .resize(modelInputSize, modelInputSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 4. Normalize pixels into a Float32Array in NCHW format.
  //    Shape: [1, 3, inputSize, inputSize]
  const pixelCount = modelInputSize * modelInputSize;
  const inputTensor = new Float32Array(3 * pixelCount);
  const isBiRefNet = BIREFNET_MODELS.has(modelName);

  for (let i = 0; i < pixelCount; i++) {
    const r = resizedBuffer[i * 3] / 255.0;
    const g = resizedBuffer[i * 3 + 1] / 255.0;
    const b = resizedBuffer[i * 3 + 2] / 255.0;

    if (isBiRefNet) {
      // BiRefNet: simple rescale to [0, 1], then ImageNet normalize.
      inputTensor[i] = (r - MEAN[0]) / STD[0];
      inputTensor[pixelCount + i] = (g - MEAN[1]) / STD[1];
      inputTensor[2 * pixelCount + i] = (b - MEAN[2]) / STD[2];
    } else {
      inputTensor[i] = (r - MEAN[0]) / STD[0]; // R channel
      inputTensor[pixelCount + i] = (g - MEAN[1]) / STD[1]; // G channel
      inputTensor[2 * pixelCount + i] = (b - MEAN[2]) / STD[2]; // B channel
    }
  }

  // 5. Run inference.
  const inferenceStart = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
  });

  const feeds: Record<string, unknown> = {
    [session.inputNames[0]]: new ort.Tensor('float32', inputTensor, [
      1,
      3,
      modelInputSize,
      modelInputSize,
    ]),
  };

  const results = await session.run(feeds);
  const inferenceMs = Date.now() - inferenceStart;

  // 6. Extract the mask from the first output.
  const outputName = session.outputNames[0];
  const outputTensor = results[outputName];
  const outputData = outputTensor.data as Float32Array;

  const maskBuffer = Buffer.alloc(pixelCount);

  if (isBiRefNet) {
    // BiRefNet: output needs sigmoid activation, then scale to [0, 255].
    for (let i = 0; i < pixelCount; i++) {
      const sigmoid = 1 / (1 + Math.exp(-outputData[i]));
      const val = sigmoid * 255;
      maskBuffer[i] = val > alphaThreshold ? Math.round(val) : 0;
    }
  } else {
    // U2-Net / ISNet: normalize output range to [0, 255].
    let minVal = Number.POSITIVE_INFINITY;
    let maxVal = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < outputData.length; i++) {
      if (outputData[i] < minVal) minVal = outputData[i];
      if (outputData[i] > maxVal) maxVal = outputData[i];
    }
    const range = maxVal - minVal || 1;
    for (let i = 0; i < pixelCount; i++) {
      const normalized = ((outputData[i] - minVal) / range) * 255;
      maskBuffer[i] = normalized > alphaThreshold ? Math.round(normalized) : 0;
    }
  }

  await session.release();

  // 7. Resize mask back to original dimensions.
  const fullMask = await sharp(maskBuffer, {
    raw: { width: modelInputSize, height: modelInputSize, channels: 1 },
  })
    .resize(origWidth, origHeight, { fit: 'fill' })
    .raw()
    .toBuffer();

  // 8. Composite: apply mask as alpha channel to the original image.
  const outputPipeline = sharp(imageBytes).ensureAlpha();

  // Extract raw RGBA pixels.
  const rgbaBuffer = await outputPipeline.raw().toBuffer();

  // Apply the mask to the alpha channel.
  for (let i = 0; i < origWidth * origHeight; i++) {
    rgbaBuffer[i * 4 + 3] = fullMask[i]; // Set alpha from mask.
  }

  // Build the output image.
  let output = sharp(rgbaBuffer, {
    raw: { width: origWidth, height: origHeight, channels: 4 },
  });

  // Apply background color if specified.
  if (options.backgroundColor) {
    const bgColor = parseHexColor(options.backgroundColor);
    output = output.flatten({ background: bgColor });
  }

  // Trim transparent borders if requested.
  if (options.trim) {
    output = output.trim();
  }

  const outputBuffer = await output.png().toBuffer();

  return {
    bytes: outputBuffer,
    width: origWidth,
    height: origHeight,
    model: modelName,
    inferenceMs,
    totalMs: Date.now() - totalStart,
  };
}

// -- Helpers ------------------------------------------------------------------

export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const stripped = hex.replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(stripped)) {
    throw new Error(`Invalid hex color "${hex}". Use 3 or 6 hex digits, e.g. #fff or #ffffff.`);
  }
  const clean =
    stripped.length === 3
      ? stripped
          .split('')
          .map((c) => c + c)
          .join('')
      : stripped;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}
