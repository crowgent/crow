import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalOpenaiKey = process.env.OPENAI_API_KEY;
const originalDeepseekKey = process.env.DEEPSEEK_API_KEY;
let home = "";

async function loadSettings() {
  vi.resetModules();
  return await import("../../src/utils/settings");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crow-auth-test-"));
  process.env.HOME = home;
  delete process.env.OPENAI_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
});

afterEach(() => {
  process.env.HOME = originalHome;
  if (originalOpenaiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenaiKey;
  if (originalDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalDeepseekKey;
  fs.rmSync(home, { recursive: true, force: true });
  vi.resetModules();
});

describe("provider keys in auth.json", () => {
  it("saves and reads back a key in the opencode-shaped auth file", async () => {
    const settings = await loadSettings();
    settings.saveProviderApiKey("openai", "sk-test-openai");
    settings.saveProviderApiKey("my-custom", "sk-test-custom");
    expect(settings.getProviderApiKey("openai")).toBe("sk-test-openai");
    expect(settings.getProviderApiKey("my-custom")).toBe("sk-test-custom");
    const authPath = path.join(home, ".crow", "auth.json");
    const stored = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    expect(stored).toEqual({
      openai: { type: "api", key: "sk-test-openai" },
      "my-custom": { type: "api", key: "sk-test-custom" },
    });
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
    const settingsPath = path.join(home, ".crow", "user-settings.json");
    if (fs.existsSync(settingsPath)) {
      expect(JSON.parse(fs.readFileSync(settingsPath, "utf-8")).providerApiKeys).toBeUndefined();
    }
  });

  it("prefers the saved key over the environment key, and falls back to env", async () => {
    const settings = await loadSettings();
    process.env.OPENAI_API_KEY = "sk-env-openai";
    expect(settings.getProviderApiKey("openai")).toBe("sk-env-openai");
    settings.saveProviderApiKey("openai", "sk-saved-openai");
    expect(settings.getProviderApiKey("openai")).toBe("sk-saved-openai");
  });

  it("migrates legacy keys from user-settings.json once and keeps other settings", async () => {
    const crowDir = path.join(home, ".crow");
    fs.mkdirSync(crowDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(crowDir, "user-settings.json"),
      JSON.stringify({ providerId: "deepseek", providerApiKeys: { deepseek: "sk-legacy-deepseek" } }),
      { mode: 0o600 },
    );
    const settings = await loadSettings();
    expect(settings.getProviderApiKey("deepseek")).toBe("sk-legacy-deepseek");
    const auth = JSON.parse(fs.readFileSync(path.join(crowDir, "auth.json"), "utf-8"));
    expect(auth).toEqual({ deepseek: { type: "api", key: "sk-legacy-deepseek" } });
    const userSettings = JSON.parse(fs.readFileSync(path.join(crowDir, "user-settings.json"), "utf-8"));
    expect(userSettings.providerApiKeys).toBeUndefined();
    expect(userSettings.providerId).toBe("deepseek");
  });

  it("ignores a malformed auth file instead of crashing", async () => {
    const crowDir = path.join(home, ".crow");
    fs.mkdirSync(crowDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(crowDir, "auth.json"), "{not json", { mode: 0o600 });
    const settings = await loadSettings();
    expect(settings.getProviderApiKey("openai")).toBeUndefined();
    process.env.DEEPSEEK_API_KEY = "sk-env-deepseek";
    expect(settings.getProviderApiKey("deepseek")).toBe("sk-env-deepseek");
  });
});
