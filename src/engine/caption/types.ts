export interface CaptionResult {
  caption: string;
  model: string;
  durationMs: number;
}

export interface CaptionOptions {
  model?: string;
  prompt?: string;
  ollamaUrl?: string;
}
