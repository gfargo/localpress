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
import { DEFAULT_MODEL, ensureModel, isModelName, listAvailableModels } from './models.ts';
import type { OnnxInferenceSession, OnnxRuntime } from './onnx-types.ts';

/** Input size expected by each model family. */
const MODEL_INPUT_SIZES: Record<string, number> = {
  u2net: 320,
  u2netp: 320,
  silueta: 320,
  'isnet-general-use': 1024,
  'birefnet-lite': 1024,
};

/** Models that use fixed /255 input rescaling and sigmoid output activation. */
const BIREFNET_MODELS = new Set(['birefnet-lite']);
const ISNET_MODELS = new Set(['isnet-general-use']);

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

export type RemoveBgProcessOptions = Omit<RemoveBgOptions, 'model' | 'onProgress'>;

/**
 * Reusable model session for batches and interactive previews.
 *
 * ONNX Runtime permits concurrent `run()` calls on a CPU inference session,
 * so callers can share one loaded model across bounded workers without
 * multiplying the model's memory footprint.
 */
export class BackgroundRemovalSession {
  private released = false;

  private constructor(
    readonly model: ModelName,
    private readonly ort: OnnxRuntime,
    private readonly session: OnnxInferenceSession,
  ) {}

  static async create(
    requestedModel: string = DEFAULT_MODEL,
    onProgress?: (message: string) => void,
  ): Promise<BackgroundRemovalSession> {
    const model = resolveModelName(requestedModel);
    const modelPath = await ensureModel(model, onProgress);
    const ort = (await import('onnxruntime-node')) as OnnxRuntime;
    const session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
    });
    return new BackgroundRemovalSession(model, ort, session);
  }

  async remove(imageBytes: Buffer, options: RemoveBgProcessOptions = {}): Promise<RemoveBgResult> {
    if (this.released) {
      throw new Error(`Background-removal session for '${this.model}' has already been released.`);
    }
    return processBackgroundWithSession(imageBytes, this.model, options, this.ort, this.session);
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await this.session.release();
  }
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
  const modelName = resolveModelName(options.model ?? DEFAULT_MODEL);
  validateAlphaThreshold(options.alphaThreshold ?? 10);
  const processor = await BackgroundRemovalSession.create(modelName, options.onProgress);
  try {
    const result = await processor.remove(imageBytes, options);
    return { ...result, totalMs: Date.now() - totalStart };
  } finally {
    await processor.release();
  }
}

export async function processBackgroundWithSession(
  imageBytes: Buffer,
  modelName: ModelName,
  options: RemoveBgProcessOptions,
  ort: OnnxRuntime,
  session: OnnxInferenceSession,
): Promise<RemoveBgResult> {
  const totalStart = Date.now();
  const alphaThreshold = validateAlphaThreshold(options.alphaThreshold ?? 10);
  const modelInputSize = MODEL_INPUT_SIZES[modelName] ?? 320;

  // 1. Lazy-load image processing (cached by the loader after the first call).
  const { loadSharp } = await import('../image/sharp-loader.ts');
  const sharp = await loadSharp();

  // 2. Load and prepare the input image.
  //    EXIF-oriented photos (e.g. portrait iPhone JPEGs stored landscape with
  //    orientation 6) must be normalized before we compute dimensions or take
  //    raw pixels, otherwise the mask ends up rotated relative to the output.
  const inputImage = sharp(imageBytes);
  const metadata = await inputImage.metadata();
  const { width: origWidth, height: origHeight } = getOrientedDimensions(metadata);
  if (origWidth <= 0 || origHeight <= 0) {
    throw new Error('Could not determine valid image dimensions for background removal.');
  }

  // Resize to model input size and extract raw RGB pixels.
  const resizedBuffer = await sharp(imageBytes)
    .rotate()
    .resize(modelInputSize, modelInputSize, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer();

  // 3. Normalize pixels into a Float32Array in NCHW format.
  //    Shape: [1, 3, inputSize, inputSize]
  const pixelCount = modelInputSize * modelInputSize;
  const isBiRefNet = BIREFNET_MODELS.has(modelName);
  const inputTensor = normalizeRgbPixels(resizedBuffer, modelName);

  // 4. Run inference using the reusable session.
  const inferenceStart = Date.now();
  const outputName = session.outputNames[0];
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

  // 5. Extract the mask from the first output.
  const outputTensor = results[outputName];
  if (!outputTensor) {
    throw new Error(`Model '${modelName}' did not return its expected output '${outputName}'.`);
  }
  const outputData = outputTensor.data as Float32Array;
  if (outputData.length < pixelCount) {
    throw new Error(
      `Model '${modelName}' returned an undersized mask (${outputData.length} values; expected at least ${pixelCount}).`,
    );
  }

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

  // 6. Resize mask back to original dimensions.
  const fullMask = await resizeAlphaMask(maskBuffer, modelInputSize, origWidth, origHeight);

  // 7. Composite: apply mask as alpha channel to the original image.
  const outputPipeline = sharp(imageBytes).rotate().ensureAlpha();

  // Extract raw RGBA pixels.
  const rgbaBuffer = await outputPipeline.raw().toBuffer();

  // Combine the mask with any transparency already present in the source.
  // Replacing alpha outright can make transparent pixels opaque again.
  applyAlphaMask(rgbaBuffer, fullMask);

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

export function resolveModelName(requestedModel: string): ModelName {
  if (!isModelName(requestedModel)) {
    throw new Error(
      `Unknown background-removal model '${requestedModel}'. Available: ${listAvailableModels()
        .map((model) => model.name)
        .join(', ')}`,
    );
  }
  return requestedModel;
}

/**
 * EXIF orientations 5-8 rotate the image 90°/270°, swapping width and height
 * once `.rotate()` normalizes pixels; 2-4 are flips/180° and don't swap.
 */
export function getOrientedDimensions(metadata: {
  width?: number;
  height?: number;
  orientation?: number;
}): { width: number; height: number } {
  const orientation = metadata.orientation ?? 1;
  const swapDims = orientation >= 5;
  return {
    width: swapDims ? (metadata.height ?? 0) : (metadata.width ?? 0),
    height: swapDims ? (metadata.width ?? 0) : (metadata.height ?? 0),
  };
}

/** Combine an 8-bit segmentation mask with an existing RGBA alpha channel. */
export function applyAlphaMask(rgbaBuffer: Buffer, maskBuffer: Buffer): void {
  if (rgbaBuffer.length !== maskBuffer.length * 4) {
    throw new Error(
      `Alpha mask size mismatch: ${maskBuffer.length} mask pixels for ${rgbaBuffer.length / 4} RGBA pixels.`,
    );
  }

  for (let i = 0; i < maskBuffer.length; i++) {
    const alphaOffset = i * 4 + 3;
    rgbaBuffer[alphaOffset] = Math.round((rgbaBuffer[alphaOffset] * maskBuffer[i]) / 255);
  }
}

/** Resize a square model mask while preserving one byte per output pixel. */
export async function resizeAlphaMask(
  maskBuffer: Buffer,
  inputSize: number,
  outputWidth: number,
  outputHeight: number,
): Promise<Buffer> {
  if (maskBuffer.length !== inputSize * inputSize) {
    throw new Error(
      `Model mask size mismatch: ${maskBuffer.length} values for a ${inputSize}x${inputSize} mask.`,
    );
  }

  const { loadSharp } = await import('../image/sharp-loader.ts');
  const sharp = await loadSharp();
  const resized = await sharp(maskBuffer, {
    raw: { width: inputSize, height: inputSize, channels: 1 },
  })
    .resize(outputWidth, outputHeight, { fit: 'fill' })
    // Sharp expands a resized single-channel raw image to RGB unless the
    // pipeline is explicitly returned to grayscale. Without this, the
    // compositor reads interleaved RGB bytes as successive mask pixels.
    .greyscale()
    .raw()
    .toBuffer();

  if (resized.length !== outputWidth * outputHeight) {
    throw new Error(
      `Resized alpha mask has ${resized.length} values; expected ${outputWidth * outputHeight}.`,
    );
  }
  return resized;
}

export function validateAlphaThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error(`Invalid alpha threshold '${value}'. Use a number from 0 to 255.`);
  }
  return value;
}

/** Convert interleaved RGB bytes to the model-specific NCHW float tensor. */
export function normalizeRgbPixels(rgbBuffer: Buffer, modelName: ModelName): Float32Array {
  if (rgbBuffer.length === 0 || rgbBuffer.length % 3 !== 0) {
    throw new Error(`Invalid RGB input length ${rgbBuffer.length}; expected complete RGB pixels.`);
  }

  const pixelCount = rgbBuffer.length / 3;
  const tensor = new Float32Array(rgbBuffer.length);
  const isBiRefNet = BIREFNET_MODELS.has(modelName);
  const isIsNet = ISNET_MODELS.has(modelName);
  const mean = isIsNet ? [0.5, 0.5, 0.5] : MEAN;
  const std = isIsNet ? [1, 1, 1] : STD;

  // The U2-Net/ISNet reference pipeline scales by the brightest input value.
  // The ONNX-community BiRefNet export specifies a fixed /255 rescale.
  let divisor = 255;
  if (!isBiRefNet) {
    let maxValue = 0;
    for (const value of rgbBuffer) {
      if (value > maxValue) maxValue = value;
    }
    divisor = Math.max(maxValue, 1e-6);
  }

  for (let i = 0; i < pixelCount; i++) {
    tensor[i] = (rgbBuffer[i * 3] / divisor - mean[0]) / std[0];
    tensor[pixelCount + i] = (rgbBuffer[i * 3 + 1] / divisor - mean[1]) / std[1];
    tensor[2 * pixelCount + i] = (rgbBuffer[i * 3 + 2] / divisor - mean[2]) / std[2];
  }
  return tensor;
}

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
