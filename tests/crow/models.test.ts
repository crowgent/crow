import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  getEffectiveReasoningEffort,
  getModelInfo,
  getModelsForProvider,
  getSupportedReasoningEfforts,
  normalizeModelId,
} from "../../src/crow/models";

describe("models", () => {
  it("keeps the default model on a built-in provider model", () => {
    expect(DEFAULT_MODEL).toBe("gpt-5");
  });

  it("trims model ids without rewriting provider ids", () => {
    expect(normalizeModelId("  gpt-5  ")).toBe("gpt-5");
    expect(normalizeModelId("openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    expect(normalizeModelId("deepseek-chat")).toBe("deepseek-chat");
  });

  it("returns model metadata for built-in models", () => {
    expect(getModelInfo("gpt-5")?.id).toBe("gpt-5");
    expect(getModelInfo("gpt-5")?.provider).toBe("openai");
    expect(getModelInfo("deepseek-reasoner")?.provider).toBe("deepseek");
  });

  it("lists models per provider", () => {
    expect(getModelsForProvider("openai").map((model) => model.id)).toContain("gpt-5");
    expect(getModelsForProvider("deepseek").map((model) => model.id)).toEqual(["deepseek-chat", "deepseek-reasoner"]);
  });

  it("reports no supported reasoning-effort levels", () => {
    expect(getSupportedReasoningEfforts("gpt-5")).toEqual([]);
    expect(getSupportedReasoningEfforts("deepseek-reasoner")).toEqual([]);
  });

  it("resolves no effective reasoning effort", () => {
    expect(getEffectiveReasoningEffort("gpt-5")).toBeUndefined();
    expect(getEffectiveReasoningEffort("gpt-5", "high")).toBeUndefined();
  });
});
