import { beforeEach, describe, expect, it } from "vitest";
import type { AgentMode } from "../types/index";
import { getCurrentModel, parseSubAgentsRawList } from "./settings";

describe("parseSubAgentsRawList", () => {
  it("returns empty for non-array or missing", () => {
    expect(parseSubAgentsRawList(undefined)).toEqual([]);
    expect(parseSubAgentsRawList(null)).toEqual([]);
    expect(parseSubAgentsRawList({})).toEqual([]);
  });

  it("keeps valid entries with known model ids", () => {
    expect(parseSubAgentsRawList([{ name: "docs", model: "gpt-5", instruction: "Focus on documentation." }])).toEqual([
      { name: "docs", model: "gpt-5", instruction: "Focus on documentation." },
    ]);
  });

  it("keeps provider model ids as given", () => {
    expect(
      parseSubAgentsRawList([{ name: "research", model: "deepseek-reasoner", instruction: "Focus on research." }]),
    ).toEqual([{ name: "research", model: "deepseek-reasoner", instruction: "Focus on research." }]);
  });

  it("skips unknown models", () => {
    expect(parseSubAgentsRawList([{ name: "bad", model: "not-a-real-model", instruction: "x" }])).toEqual([]);
  });

  it("skips reserved and empty names", () => {
    expect(
      parseSubAgentsRawList([
        { name: "general", model: "gpt-5", instruction: "x" },
        { name: "Explore", model: "gpt-5", instruction: "x" },
        { name: "vision", model: "gpt-5", instruction: "x" },
        { name: "Verify", model: "gpt-5", instruction: "x" },
        { name: "computer", model: "gpt-5", instruction: "x" },
        { name: "", model: "gpt-5", instruction: "x" },
        { name: "  ", model: "gpt-5", instruction: "x" },
      ]),
    ).toEqual([]);
  });

  it("dedupes by case-insensitive name with first entry winning", () => {
    expect(
      parseSubAgentsRawList([
        { name: "Docs", model: "gpt-5", instruction: "first" },
        { name: "docs", model: "gpt-5-mini", instruction: "second" },
      ]),
    ).toEqual([{ name: "Docs", model: "gpt-5", instruction: "first" }]);
  });

  it("ignores non-object rows", () => {
    expect(parseSubAgentsRawList([null, "x", { name: "ok", model: "gpt-5", instruction: "" }])).toEqual([
      { name: "ok", model: "gpt-5", instruction: "" },
    ]);
  });
});

describe("getCurrentModel with modeModels", () => {
  beforeEach(() => {
    delete process.env.CROW_MODEL;
  });

  it("returns a string model id", () => {
    const result = getCurrentModel("agent" as AgentMode);
    expect(typeof result).toBe("string");
  });

  it("respects CROW_MODEL environment variable over modeModels", () => {
    process.env.CROW_MODEL = "gpt-5-test";

    const result = getCurrentModel("agent" as AgentMode);
    expect(result).toBe("gpt-5-test");
  });
});
