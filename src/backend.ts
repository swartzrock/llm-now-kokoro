export type InferenceBackend = "native" | "wasm";

export interface PreparedRuntime {
  cleanup(): Promise<void>;
}
