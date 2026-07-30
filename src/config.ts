export interface ConfigInput {
  readonly baseUrl?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly effort?: unknown;
  readonly contextWindow?: unknown;
  readonly runtimeMode?: unknown;
  readonly [key: string]: unknown;
}

export interface ExperimentConfig {
  readonly baseUrl: "http://127.0.0.1:3773";
  readonly provider: "claudeAgent";
  readonly model: "claude-fable-5" | "claude-opus-5";
  readonly effort: "high";
  readonly contextWindow: "1m";
  readonly runtimeMode: "full-access";
}

export function createConfig(input: ConfigInput): ExperimentConfig {
  const allowedFields = new Set([
    "baseUrl",
    "provider",
    "model",
    "effort",
    "contextWindow",
    "runtimeMode",
  ]);

  for (const field of Object.keys(input)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`unknown configuration field: ${field}`);
    }
  }

  if (input.baseUrl === undefined) {
    throw new TypeError("baseUrl is required");
  }
  if (input.baseUrl !== "http://127.0.0.1:3773") {
    throw new TypeError("baseUrl must be http://127.0.0.1:3773");
  }

  if (input.provider === undefined) {
    throw new TypeError("provider is required");
  }
  if (input.provider !== "claudeAgent") {
    throw new TypeError("provider must be claudeAgent");
  }

  if (input.model === undefined) {
    throw new TypeError("model is required");
  }
  if (input.model !== "claude-fable-5" && input.model !== "claude-opus-5") {
    throw new TypeError("model must be claude-fable-5 or claude-opus-5");
  }

  if (input.effort === undefined) {
    throw new TypeError("effort is required");
  }
  if (input.effort !== "high") {
    throw new TypeError("effort must be high");
  }

  if (input.contextWindow === undefined) {
    throw new TypeError("contextWindow is required");
  }
  if (input.contextWindow !== "1m") {
    throw new TypeError("contextWindow must be 1m");
  }

  if (input.runtimeMode === undefined) {
    throw new TypeError("runtimeMode is required");
  }
  if (input.runtimeMode !== "full-access") {
    throw new TypeError("runtimeMode must be full-access");
  }

  return Object.freeze({
    baseUrl: input.baseUrl,
    provider: input.provider,
    model: input.model,
    effort: input.effort,
    contextWindow: input.contextWindow,
    runtimeMode: input.runtimeMode,
  });
}
