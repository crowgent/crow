import { describe, expect, it, vi } from "vitest";
import {
  BUILTIN_PROVIDERS,
  createCustomProviderId,
  fetchProviderModels,
  findProvider,
  getAllModelIds,
  getAllProviders,
  normalizeBaseUrl,
  parseModelsResponse,
} from "../../src/utils/providers";

describe("providers", () => {
  it("lists built-in providers without a grok provider", () => {
    const ids = BUILTIN_PROVIDERS.map((provider) => provider.id);
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("qwen");
    expect(ids).toContain("openrouter");
    expect(ids).toContain("cerebras");
    expect(ids).toContain("fireworks");
    expect(ids).toContain("deepinfra");
    expect(ids).toContain("nebius");
    expect(ids).toContain("sambanova");
    expect(ids).toContain("perplexity");
    expect(ids).toContain("cohere");
    expect(ids).toContain("venice");
    expect(ids).toContain("alibaba");
    expect(ids).toContain("moonshot-cn");
    expect(ids).toContain("zai");
    expect(ids).toContain("minimax-cn");
    expect(ids).toContain("stepfun-ai");
    expect(ids).toContain("opencode");
    expect(ids).toContain("opencode-go");
    expect(ids).toContain("nvidia");
    expect(ids).toContain("baseten");
    expect(ids).toContain("digitalocean");
    expect(ids).not.toContain("xai");
    expect(ids).not.toContain("grok");
    expect(ids).not.toContain("xiaomi");
  });

  it("uses custom model display names when provided", () => {
    const custom = {
      id: "custom-router",
      name: "My Router",
      baseUrl: "https://example.com/v1",
      models: ["model-a"],
      modelNames: { "model-a": "Model A" },
    };
    expect(getAllProviders([custom]).find((provider) => provider.id === "custom-router")?.models).toEqual([
      { id: "model-a", name: "Model A" },
    ]);
  });

  it("includes custom providers alongside built-ins", () => {
    const providers = getAllProviders([
      { id: "custom-local", name: "Local", baseUrl: "http://localhost:1234/v1", models: ["local-model"] },
    ]);
    expect(
      findProvider("custom-local", [
        { id: "custom-local", name: "Local", baseUrl: "http://localhost:1234/v1", models: ["local-model"] },
      ])?.baseUrl,
    ).toBe("http://localhost:1234/v1");
    expect(
      getAllModelIds([
        { id: "custom-local", name: "Local", baseUrl: "http://localhost:1234/v1", models: ["local-model"] },
      ]),
    ).toContain("local-model");
    expect(providers.map((provider) => provider.id)).toContain("custom-local");
  });

  it("normalizes base urls and custom provider ids", () => {
    expect(normalizeBaseUrl("https://example.com/v1/")).toBe("https://example.com/v1");
    expect(createCustomProviderId("My Local LLM")).toBe("custom-my-local-llm");
  });

  it("parses a models endpoint response", () => {
    expect(
      parseModelsResponse({ data: [{ id: "b-model" }, { id: "a-model" }, { id: "b-model" }, { id: "" }] }),
    ).toEqual(["a-model", "b-model"]);
    expect(parseModelsResponse({})).toEqual([]);
  });

  it("fetches models from a provider base url", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "fetched-1" }, { id: "fetched-2" }] }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const models = await fetchProviderModels("https://example.com/v1/", "key-123");
      expect(models).toEqual(["fetched-1", "fetched-2"]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://example.com/v1/models",
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer key-123" }) }),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
