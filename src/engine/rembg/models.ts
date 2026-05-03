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

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from '../../cli/utils/config.ts';

export type ModelName = 'u2net' | 'u2netp' | 'silueta' | 'isnet-general-use' | 'birefnet-lite';

interface ModelInfo {
  name: ModelName;
  url: string;
  filename: string;
  sizeApprox: string;
  license: string;
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
  },
  u2netp: {
    name: 'u2netp',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    filename: 'u2netp.onnx',
    sizeApprox: '~4.7 MB',
    license: 'Apache-2.0',
  },
  silueta: {
    name: 'silueta',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/silueta.onnx',
    filename: 'silueta.onnx',
    sizeApprox: '~44 MB',
    license: 'Apache-2.0',
  },
  'isnet-general-use': {
    name: 'isnet-general-use',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx',
    filename: 'isnet-general-use.onnx',
    sizeApprox: '~176 MB',
    license: 'Apache-2.0',
  },
  'birefnet-lite': {
    name: 'birefnet-lite',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
    filename: 'birefnet-lite.onnx',
    sizeApprox: '~224 MB',
    license: 'MIT',
  },
};

export const DEFAULT_MODEL: ModelName = 'u2net';

export function getModelInfo(name: ModelName): ModelInfo {
  return MODEL_REGISTRY[name];
}

export function listAvailableModels(): ModelInfo[] {
  return Object.values(MODEL_REGISTRY);
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
  return existsSync(getModelPath(name));
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

  if (existsSync(modelPath)) {
    onProgress?.(`Model '${name}' found in cache.`);
    return modelPath;
  }

  const info = MODEL_REGISTRY[name];
  const modelsDir = getModelsDir();
  mkdirSync(modelsDir, { recursive: true });

  onProgress?.(`Downloading model '${name}' (${info.sizeApprox})...`);
  onProgress?.(`  Source: ${info.url}`);
  onProgress?.(`  License: ${info.license}`);

  const response = await fetch(info.url);
  if (!response.ok) {
    throw new Error(
      `Failed to download model '${name}': ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Failed to get response body reader.');
  }

  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.length;

    if (contentLength > 0) {
      const pct = ((downloaded / contentLength) * 100).toFixed(0);
      const mb = (downloaded / (1024 * 1024)).toFixed(1);
      onProgress?.(`  Progress: ${mb} MB (${pct}%)`);
    }
  }

  // Concatenate chunks and write to disk.
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  await Bun.write(modelPath, buffer);
  onProgress?.(`  ✓ Model saved to ${modelPath} (${(totalLength / (1024 * 1024)).toFixed(1)} MB)`);

  return modelPath;
}
