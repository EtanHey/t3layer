import { describe, expect, test } from "bun:test";
import { createConfig } from "../src/config";

const VALID_CONFIG = {
  baseUrl: "http://127.0.0.1:3773",
  provider: "claudeAgent",
  model: "claude-fable-5",
  effort: "high",
  contextWindow: "1m",
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;

describe("createConfig", () => {
  test.each(["claude-fable-5", "claude-opus-5"] as const)(
    "accepts the explicit %s experiment configuration",
    (model) => {
      const input = { ...VALID_CONFIG, model };
      const config = createConfig(input);

      expect(config).toEqual(input);
      expect(Object.isFrozen(config)).toBe(true);
    },
  );

  test.each([
    "baseUrl",
    "provider",
    "model",
    "effort",
    "contextWindow",
    "runtimeMode",
    "interactionMode",
  ] as const)("rejects a missing %s", (field) => {
    const input: Record<string, unknown> = { ...VALID_CONFIG };
    delete input[field];

    expect(() => createConfig(input)).toThrow(`${field} is required`);
  });

  test.each([
    [
      "baseUrl",
      "http://127.0.0.1:3774",
      "baseUrl must be http://127.0.0.1:3773",
    ],
    ["provider", "claudeDesktop", "provider must be claudeAgent"],
    ["effort", "medium", "effort must be high"],
    ["contextWindow", "200k", "contextWindow must be 1m"],
    ["runtimeMode", "approval-required", "runtimeMode must be full-access"],
    ["interactionMode", "plan", "interactionMode must be default"],
  ] as const)("rejects invalid %s", (field, value, message) => {
    expect(() =>
      createConfig({
        ...VALID_CONFIG,
        [field]: value,
      }),
    ).toThrow(message);
  });

  test.each(["claude-sonnet-4-5", "claude-opus-4-1", "fable", "opus"])(
    "rejects unsupported model %s",
    (model) => {
      expect(() =>
        createConfig({
          ...VALID_CONFIG,
          model,
        }),
      ).toThrow("model must be claude-fable-5 or claude-opus-5");
    },
  );

  test.each([
    "defaultModel",
    "persistedModel",
    "fallbackModel",
    "unknown",
  ] as const)(
    "rejects unknown field %s even with a valid explicit model",
    (field) => {
      expect(() =>
        createConfig({
          ...VALID_CONFIG,
          [field]: "claude-fable-5",
        }),
      ).toThrow(`unknown configuration field: ${field}`);
    },
  );
});
