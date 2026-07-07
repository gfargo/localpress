/**
 * What kind of text we're asking the vision model to generate.
 *
 * - 'alt': concise single-sentence alt text (existing caption behavior)
 * - 'title': short noun phrase suitable for WP `post_title` (3-7 words)
 * - 'description': 2-3 sentences for galleries / SEO
 * - 'classify': single label — screenshot | photo | illustration | diagram
 * - 'tags': comma-separated short tags (3-6 items)
 */
export type VisionKind = 'alt' | 'title' | 'description' | 'classify' | 'tags';

export interface CaptionResult {
  caption: string;
  model: string;
  durationMs: number;
}

export interface CaptionOptions {
  /** What to generate. Defaults to 'alt' to preserve existing behavior. */
  kind?: VisionKind;
  model?: string;
  /** Fallback model to try when the primary model returns garbage. */
  fallbackModel?: string;
  prompt?: string;
  ollamaUrl?: string;
  /** Generate output in this language (alt/title/description only; e.g. "Spanish"). */
  language?: string;
}
