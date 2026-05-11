/**
 * Ollama vision provider for the caption command.
 *
 * Sends images to a locally-running Ollama instance and returns
 * generated alt-text. Requires a multimodal model such as:
 *   moondream             (~1.7GB, fast, great for short alt-text)
 *   llava-llama3          (~5.5GB, solid all-rounder)
 *   llama3.2-vision:11b   (~8GB, best quality on screenshots/text-in-image)
 *   bakllava              (~4GB+, alternative LLaVA variant)
 *
 * Three quality safeguards before the response reaches WordPress:
 *   1. Pre-resize the image to <=1024px so smaller models don't blow
 *      their context budget on 4K screenshots and bigger models run
 *      faster (vision models don't need pixel-perfect input).
 *   2. Cap Ollama's output with `num_predict` so verbose models can't
 *      generate multi-paragraph essays as alt text.
 *   3. Post-process the response: strip leading meta-phrases ("The
 *      image shows…"), keep only the first paragraph, truncate cleanly
 *      at a word boundary if it's still too long.
 */

import type { CaptionOptions, CaptionResult } from './types.ts';

export const DEFAULT_OLLAMA_MODEL = 'moondream';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Vision models work fine on smaller inputs; pre-resize to this max edge. */
const MAX_IMAGE_EDGE = 1024;

/** Hard ceiling on Ollama-generated tokens to prevent verbose-model essays. */
const MAX_OUTPUT_TOKENS = 200;

/** Soft cap on the final caption length; truncate at a word boundary if exceeded. */
const MAX_CAPTION_CHARS = 240;

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

  // Build the prompt — append language instruction if specified.
  let prompt: string;
  if (options.prompt) {
    prompt = options.prompt;
  } else if (options.language) {
    prompt = `Write concise alt-text for this image in ${options.language}. Describe only what is visually present. Be factual and specific. Keep it under 125 characters. Respond with only the alt-text — no prefix, quotes, or explanation.`;
  } else {
    prompt = DEFAULT_PROMPT;
  }

  const start = Date.now();

  // Pre-resize to keep the Ollama request small. Vision models max out
  // perception around 1024px; larger inputs just waste compute and can
  // overflow smaller models' context windows (e.g. moondream returning
  // empty on 4K Mac screenshots).
  const downscaled = await downscaleForVision(imageBuffer);
  const b64 = downscaled.toString('base64');

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt,
      images: [b64],
      stream: false,
      // Hard cap on response length — defense against models that ignore
      // "keep it short" instructions in the prompt.
      options: { num_predict: MAX_OUTPUT_TOKENS },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as OllamaGenerateResponse;

  if (data.error) throw new Error(`Ollama error: ${data.error}`);
  if (!data.response || data.response.trim().length === 0) {
    throw new Error(
      'Ollama returned an empty response. The model may not be suited to this image — try a different --model.',
    );
  }

  return {
    caption: cleanCaption(data.response),
    model,
    durationMs: Date.now() - start,
  };
}

/**
 * Downscale the image to a max edge of 1024px before sending to Ollama.
 *
 * Vision models don't need pixel-perfect input — they typically resize
 * to 224/336/672/1024 internally. Sending the original 4K Mac screenshot
 * is pure waste and breaks tiny models. Returns the original bytes if
 * sharp isn't available (graceful degradation — captions still work,
 * just less reliably).
 */
async function downscaleForVision(imageBuffer: Buffer): Promise<Buffer> {
  try {
    const sharpMod = await import('sharp');
    const sharp = sharpMod.default;
    const meta = await sharp(imageBuffer).metadata();
    const maxEdge = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (maxEdge <= MAX_IMAGE_EDGE) return imageBuffer;
    return await sharp(imageBuffer)
      .resize({
        width: MAX_IMAGE_EDGE,
        height: MAX_IMAGE_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();
  } catch {
    // sharp not installed or processing failed — fall back to original.
    // Captions still work, just may be slower / more failure-prone.
    return imageBuffer;
  }
}

/**
 * Post-process a raw Ollama response into clean alt-text.
 *
 * Handles three common failure modes:
 *   - Verbose intros: "The image shows…", "Here is a description of…"
 *   - Multi-paragraph essays: keep only the first paragraph
 *   - Bulleted analyses: take everything up to the first list bullet
 *   - Surrounding quotes: strip them (some models wrap output in "…")
 *
 * Final pass truncates at a word boundary if still over MAX_CAPTION_CHARS.
 */
export function cleanCaption(raw: string): string {
  let s = raw.trim();

  // Strip leading/trailing quotes ("text" or 'text').
  s = s.replace(/^["']+|["']+$/g, '').trim();

  // Take only the first paragraph (split on blank line).
  const firstPara = s.split(/\n\s*\n/, 1)[0];
  if (firstPara) s = firstPara.trim();

  // Trim everything from the first list bullet onward (some models
  // append a bulleted analysis after the actual sentence).
  const bulletIdx = s.search(/\n\s*[*\-•]\s/);
  if (bulletIdx > 0) s = s.slice(0, bulletIdx).trim();

  // Strip common meta-phrase intros.
  const introPatterns: RegExp[] = [
    /^the image (shows|displays|depicts|features|contains)\s+/i,
    /^this image (shows|displays|depicts|is\s+of|is)\s+/i,
    /^here is a (short|brief|concise)?\s*(description|caption|alt[\s-]?text) of[^:.]*:?\s*/i,
    /^here'?s? a (short|brief|concise)?\s*(description|caption|alt[\s-]?text)[^:.]*:?\s*/i,
    /^the picture (shows|displays|depicts)\s+/i,
    /^(a |an )?(screenshot|photo|photograph|image|picture) of\s+/i,
    /^i (can )?see\s+/i,
    /^description:\s*/i,
    /^alt[\s-]?text:\s*/i,
    /^caption:\s*/i,
  ];
  for (const re of introPatterns) {
    if (re.test(s)) {
      s = s.replace(re, '');
      // Capitalize the new leading char.
      if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);
      break;
    }
  }

  // Truncate to a word boundary if still too long.
  if (s.length > MAX_CAPTION_CHARS) {
    const cutoff = s.lastIndexOf(' ', MAX_CAPTION_CHARS);
    s = `${s.slice(0, cutoff > 0 ? cutoff : MAX_CAPTION_CHARS)}…`;
  }

  return s.trim();
}
