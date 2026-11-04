import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AgentDefinition,
  builtinAgentDefinitions,
  deleteAgentFile,
  findAgentDefinition,
  isDelegatable,
  mergeAgentDefinitions,
  parseAgentFile,
  serializeAgentFile,
  writeAgentFile,
} from "../../src/utils/agent-files";

function definition(partial: Partial<AgentDefinition> & { name: string }): AgentDefinition {
  return {
    description: "",
    model: "inherit",
    tools: null,
    maxTurns: null,
    color: null,
    hidden: false,
    enabled: true,
    mode: "subagent",
    promptMode: "replace",
    body: "Body.",
    source: "builtin",
    filePath: null,
    ...partial,
  };
}

describe("parseAgentFile", () => {
  it("parses full frontmatter and body", () => {
    const parsed = parseAgentFile(
      `---
name: tester
description: Run tests and report failures. Use when code changed.
model: inherit
tools: read, grep, bash
max_turns: 30
color: teal
---
You verify code changes.`,
      "fallback",
    );
    expect(parsed).toMatchObject({
      name: "tester",
      description: "Run tests and report failures. Use when code changed.",
      model: "inherit",
      tools: ["read", "grep", "bash"],
      maxTurns: 30,
      color: "teal",
      body: "You verify code changes.",
    });
  });

  it("parses block-list tools and bracket tools", () => {
    const block = parseAgentFile("---\nname: a\ntools:\n  - read\n  - grep\n---\nBody.", "a");
    expect(block?.tools).toEqual(["read", "grep"]);
    const bracket = parseAgentFile('---\nname: a\ntools: ["read", "bash"]\n---\nBody.', "a");
    expect(bracket?.tools).toEqual(["read", "bash"]);
  });

  it("falls back to the filename when name is omitted and rejects bad names", () => {
    expect(parseAgentFile("---\ndescription: Hi.\n---\nBody.", "from-file")?.name).toBe("from-file");
    expect(parseAgentFile("---\nname: bad:name\n---\nBody.", "fallback")).toBeNull();
    expect(parseAgentFile("---\nname: ok\n---\n", "fallback")).toBeNull();
  });

  it("loads files without frontmatter and disabled stubs", () => {
    const plain = parseAgentFile("Just a body, no frontmatter.", "plain");
    expect(plain).toMatchObject({ name: "plain", description: "", body: "Just a body, no frontmatter." });
    const stub = parseAgentFile("---\nname: explorer\nenabled: false\n---\n", "explorer");
    expect(stub).toMatchObject({ name: "explorer", enabled: false, body: "" });
  });

  it("falls back to inherit for unknown models and bad turn caps", () => {
    const parsed = parseAgentFile("---\nname: a\nmodel: no-such-model\nmax_turns: -3\n---\nBody.", "a");
    expect(parsed).toMatchObject({ model: "inherit", maxTurns: null });
  });
});

describe("serializeAgentFile", () => {
  it("round-trips through the parser", () => {
    const serialized = serializeAgentFile("tester", {
      description: "Run tests.",
      model: "inherit",
      tools: ["read", "bash"],
      maxTurns: 12,
      color: null,
      hidden: false,
      enabled: true,
      mode: "subagent",
      promptMode: "replace",
      body: "You verify code changes.",
    });
    const parsed = parseAgentFile(serialized, "tester");
    expect(parsed).toMatchObject({
      name: "tester",
      description: "Run tests.",
      tools: ["read", "bash"],
      maxTurns: 12,
      body: "You verify code changes.",
    });
  });
});

describe("mergeAgentDefinitions", () => {
  it("applies project over global over settings over builtin", () => {
    const merged = mergeAgentDefinitions([
      [definition({ name: "tester", body: "Builtin." })],
      [definition({ name: "tester", body: "Settings.", source: "settings" })],
      [definition({ name: "tester", body: "Global.", source: "global" })],
      [definition({ name: "tester", body: "Project.", source: "project" })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ body: "Project.", source: "project" });
  });

  it("lets a disabled stub shadow a builtin", () => {
    const merged = mergeAgentDefinitions([
      builtinAgentDefinitions(),
      [definition({ name: "explorer", enabled: false, body: "", source: "project" })],
    ]);
    const explorer = findAgentDefinition(merged, "explorer");
    expect(explorer?.enabled).toBe(false);
    expect(isDelegatable(explorer as AgentDefinition)).toBe(false);
  });

  it("excludes hidden, disabled, and primary agents from delegation", () => {
    const merged = mergeAgentDefinitions([
      [
        definition({ name: "shown" }),
        definition({ name: "hid", hidden: true }),
        definition({ name: "off", enabled: false }),
        definition({ name: "main", mode: "primary" }),
      ],
    ]);
    expect(findAgentDefinition(merged, "hid")).toBeDefined();
    expect(isDelegatable(findAgentDefinition(merged, "shown") as AgentDefinition)).toBe(true);
    expect(isDelegatable(findAgentDefinition(merged, "hid") as AgentDefinition)).toBe(false);
    expect(isDelegatable(findAgentDefinition(merged, "off") as AgentDefinition)).toBe(false);
    expect(isDelegatable(findAgentDefinition(merged, "main") as AgentDefinition)).toBe(false);
  });

  it("ships the six defaults", () => {
    const names = builtinAgentDefinitions()
      .map((item) => item.name)
      .sort();
    expect(names).toEqual(["builder", "explorer", "general-purpose", "planner", "reviewer", "tester"]);
  });

  it("deletes a written agent file and ignores a missing one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-agent-delete-"));
    const cwd = path.join(dir, "proj");
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentFile("project", cwd, "temp-agent", {
      description: "",
      model: "inherit",
      tools: null,
      maxTurns: null,
      color: null,
      hidden: false,
      enabled: true,
      mode: "subagent",
      promptMode: "replace",
      body: "Do things.",
    });
    expect(fs.existsSync(path.join(cwd, ".crow", "agents", "temp-agent.md"))).toBe(true);
    deleteAgentFile("project", cwd, "temp-agent");
    expect(fs.existsSync(path.join(cwd, ".crow", "agents", "temp-agent.md"))).toBe(false);
    expect(() => deleteAgentFile("project", cwd, "temp-agent")).not.toThrow();
  });
});
