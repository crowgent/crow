import { createOpenAI } from "@ai-sdk/openai";
import type { generateText } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateRecap, generateTitle, resolveModelRuntime } from "./client";

const mockGenerateText = vi.hoisted(() => vi.fn());

vi.mock("ai", () => {
  return {
    generateText: mockGenerateText,
  };
});

describe("client", () => {
  const mockProvider = createOpenAI({
    apiKey: "test-key",
    baseURL: "https://api.openai.com/v1",
  });

  describe("generateRecap", () => {
    beforeEach(() => {
      mockGenerateText.mockReset();
    });

    it("generates a normalized recap with the recap prompt contract", async () => {
      const signal = new AbortController().signal;
      mockGenerateText.mockResolvedValue({
        text: ' "Wrapped up the parser fix. Next step is wiring the new recap banner." ',
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      } as Awaited<ReturnType<typeof generateText>>);

      const result = await generateRecap(mockProvider, "transcript body", signal, "gpt-5");

      expect(result).toEqual({
        recap: "Wrapped up the parser fix. Next step is wiring the new recap banner.",
        modelId: "gpt-5",
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      });
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          abortSignal: signal,
          maxOutputTokens: 120,
          prompt: "transcript body",
          system: expect.stringContaining("Maximum 3 sentences total"),
        }),
      );
    });

    it("returns an empty recap when generation fails", async () => {
      mockGenerateText.mockRejectedValue(new Error("boom"));

      const result = await generateRecap(mockProvider, "transcript body", undefined, "gpt-5");

      expect(result).toEqual({
        recap: "",
        modelId: "gpt-5",
      });
    });
  });

  describe("generateTitle", () => {
    beforeEach(() => {
      mockGenerateText.mockReset();
    });

    it("returns a trimmed title for the selected model", async () => {
      mockGenerateText.mockResolvedValue({
        text: "Parser fix",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      } as Awaited<ReturnType<typeof generateText>>);

      const result = await generateTitle(mockProvider, "Fix the parser", "deepseek-chat");

      expect(result).toEqual({
        title: "Parser fix",
        modelId: "deepseek-chat",
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
    });
  });

  describe("resolveModelRuntime", () => {
    it("keeps provider model ids as given", () => {
      const runtime = resolveModelRuntime(mockProvider, "gpt-5");
      expect(runtime.modelId).toBe("gpt-5");
      expect(runtime.providerOptions).toBeUndefined();
    });

    it("trims model ids", () => {
      const runtime = resolveModelRuntime(mockProvider, "  deepseek-chat  ");
      expect(runtime.modelId).toBe("deepseek-chat");
    });

    it("returns model info for known models", () => {
      const runtime = resolveModelRuntime(mockProvider, "gpt-5");
      expect(runtime.modelInfo?.id).toBe("gpt-5");
      expect(runtime.modelInfo?.provider).toBe("openai");
    });
  });
});
