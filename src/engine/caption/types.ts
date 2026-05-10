export interface CaptionResult {
  caption: string;
  model: string;
  durationMs: number;
}

export interface CaptionOptions {
  model?: string;
  prompt?: string;
  ollamaUrl?: string;
  /** Generate alt text in this language (e.g. "Spanish", "French", "Japanese"). */
  language?: string;
}
