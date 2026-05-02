/**
 * Minimal type declarations for onnxruntime-node.
 *
 * We use dynamic import() for onnxruntime-node so it's only loaded when
 * the remove-bg command is actually invoked. These types let us write
 * type-safe code without requiring the package to be installed at
 * typecheck time.
 */

export interface OnnxTensor {
  readonly data: Float32Array | Int32Array | Uint8Array;
  readonly dims: readonly number[];
  readonly type: string;
}

export interface OnnxInferenceSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OnnxTensor>>;
  release(): Promise<void>;
}

export interface OnnxSessionOptions {
  executionProviders?: string[];
}

export interface OnnxRuntime {
  InferenceSession: {
    create(path: string, options?: OnnxSessionOptions): Promise<OnnxInferenceSession>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}
