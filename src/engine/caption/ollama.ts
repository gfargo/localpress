/**
 * Ollama vision provider for the caption command.
 *
 * Sends images to a locally-running Ollama instance and returns
 * generated alt-text. Requires a multimodal model such as:
 *   moondream  (~1.7GB, fast, great for alt-text)
 *   llava      (~4GB+, higher quality)
 *   bakllava   (~4GB+, alternative LLaVA variant)
 */

import type { CaptionOptions, CaptionResult } from './types.ts';

export const DEFAULT_OLLAMA_MODEL = 'moondream';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

const DEFAULT_PROMPT =
  'Write concise alt-text for this image. Describe only what is visually present. ' +
  'Be factual and specific. Keep it under 125 characters. ' +
  'Respond with only the alt-text — no prefix, quotes, or explanation.';

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  error?: string;
}

interface OllamaTagsResponse {
  models: Array<{ name: string; size: number; modified_at: string }>;
}

export async function isOllamaAvailable(baseUrl = DEFAULT_OLLAMA_URL): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listOllamaModels(
  baseUrl = DEFAULT_OLLAMA_URL,
): Promise<Array<{ name: string; size: number }>> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) throw new Error(`Ollama /api/tags returned ${res.status}`);
  const data = (await res.json()) as OllamaTagsResponse;
  return data.models.map((m) => ({ name: m.name, size: m.size }));
}

export async function generateCaption(
  imageBuffer: Buffer,
  options: CaptionOptions = {},
): Promise<CaptionResult> {
  const baseUrl = options.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const prompt = options.prompt ?? DEFAULT_PROMPT;

  const start = Date.now();
  const b64 = imageBuffer.toString('base64');

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, images: [b64], stream: false }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as OllamaGenerateResponse;

  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  if (!data.response) throw new Error('Ollama returned an empty response');

  return {
    caption: data.response.trim(),
    model,
    durationMs: Date.now() - start,
  };
}
