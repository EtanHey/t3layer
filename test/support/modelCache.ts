import { join } from "node:path";

import {
  createStockT3NativeRuntime as createRuntime,
  type StockT3NativeRuntimeOptions,
} from "../../src/nativeRuntime";

const fixtureDirectory = join(import.meta.dir, "..", "fixtures", "model-caches");

// Intentionally shadows the production factory so unit tests use fixture caches.
// Tests of the real default cache path must import directly from ../../src/nativeRuntime.
export function createStockT3NativeRuntime(options: StockT3NativeRuntimeOptions) {
  return createRuntime({ ...options, modelCacheDirectory: fixtureDirectory });
}
