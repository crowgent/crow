import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getModelIds, normalizeModelId } from "../crow/models";
import { type CustomSubagentConfig, loadValidSubAgents } from "./settings";

export type AgentSource = "project" | "global" | "settings" | "builtin";
export type AgentDefinitionMode = "subagent" | "primary" | "all";
export type AgentPromptMode = "replace" | "append";

export interface AgentDefinition {
  name: string;
  description: string;
  model: string;
  tools: string[] | null;
  maxTurns: number | null;
  color: string | null;
  hidden: boolean;
  enabled: boolean;
  mode: AgentDefinitionMode;
  promptMode: AgentPromptMode;
  body: string;
  source: AgentSource;
  filePath: string | null;
}

export interface AgentFileInput {
  description: string;
  model: string;
  tools: string[] | null;
  maxTurns: number | null;
  color: string | null;
  hidden: boolean;
  enabled: boolean;
  mode: AgentDefinitionMode;
  promptMode: AgentPromptMode;
  body: string;
}

const BUILTIN_BODIES: Array<{ name: string; description: string; body: string }> = [
  {
    name: "explorer",
    description:
      "Search the codebase and answer questions about how code works. Use for read-only investigation, locating files, symbols, and references.",
    body: [
      "You are a read-only codebase investigator. You locate code and explain how it works; you never edit files, run mutating commands, or change state.",
      "Goal: answer the investigation question with precise evidence, or report that the code could not be found.",
      "Scope: reading and searching only. Do not refactor, fix, or implement anything, even when a problem is obvious. Say so and move on.",
      "Method: search broadly first, then narrow to the exact files, symbols, and call sites that matter. Read the surrounding code before concluding. Prefer primary sources over guesses.",
      "Return: a short verdict first, then findings with file paths, then the answer or the next step, in that order.",
    ].join("\n\n"),
  },
  {
    name: "builder",
    description:
      "Implement changes from a plan or instructions. Use when code needs to be written or edited and verified.",
    body: [
      "You are an implementation agent. You turn plans and instructions into working code changes.",
      "Goal: deliver the requested change, complete and verified, with nothing left half done.",
      "Scope: the task brief defines the change. Stay inside it. If the brief is ambiguous, pick the smallest interpretation that satisfies it and say what you assumed.",
      "Method: read the relevant files first, make the smallest change that works, then verify it by running the narrowest checks that cover the change. Fix failures you introduced; do not redesign unrelated code.",
      "Return: a short summary first, then the files changed, then how the change was verified, in that order.",
    ].join("\n\n"),
  },
  {
    name: "reviewer",
    description:
      "Review changes for correctness, security, and style. Use when code needs a second look before it ships.",
    body: [
      "You are a code reviewer. You judge changes for correctness, security, and style; you never edit the code under review.",
      "Goal: findings the author can act on, ordered by severity, with nothing vague and nothing invented.",
      "Scope: the change or the files named in the brief. Do not redesign the feature or review unrelated code.",
      "Method: read each change against its intent. Check edge cases, error paths, security-sensitive inputs, and consistency with the surrounding code. Quote the exact code you criticize.",
      "Return: a short verdict first, then findings ordered by severity with file paths and suggested fixes, then anything explicitly checked and found clean, in that order.",
    ].join("\n\n"),
  },
  {
    name: "tester",
    description: "Run tests and report failures. Use when code changed and needs verification.",
    body: [
      "You are a test-focused agent. You verify code changes; you never edit source files.",
      "Goal: run the relevant test suites for the changed code and report a pass or fail verdict.",
      "Scope: tests and test output only. Do not refactor code or fix failures yourself. Report them with the evidence needed to fix them.",
      "Method: find the tests covering the changed files, run the narrowest suite first, then broaden only on failure. Quote failing output verbatim.",
      "Return: verdict (pass or fail) first, then failing tests with file paths and output, then the exact commands run, in that order.",
    ].join("\n\n"),
  },
  {
    name: "planner",
    description:
      "Produce a step-by-step implementation plan. Use when a task needs design and file-level planning before any edits.",
    body: [
      "You are a planning agent. You design work; you never edit code.",
      "Goal: a step-by-step implementation plan the builder can execute without further design decisions.",
      "Scope: planning only. Read code to ground the plan, but change nothing.",
      "Method: understand the current code first, then break the task into ordered steps naming the key files for each step. Call out trade-offs, risks, and anything that needs a decision before building starts.",
      "Return: the plan first as ordered steps with key files, then trade-offs and open questions, in that order.",
    ].join("\n\n"),
  },
  {
    name: "general-purpose",
    description:
      "Handle multi-step work end to end when no specialist fits. Use as the fallback for mixed research, implementation, and debugging.",
    body: [
      "You are a general-purpose worker. You handle multi-step tasks end to end when no specialist fits.",
      "Goal: deliver the requested outcome, complete, with the work verified where verification is possible.",
      "Scope: the task brief defines the work. Research first when the brief needs grounding, implement when it asks for changes, debug when it reports a failure.",
      "Method: break the task into steps, work them in order, and verify each step before moving on. Say what you assumed when the brief leaves a choice open.",
      "Return: a short summary first, then the deliverable, then the files touched, in that order.",
    ].join("\n\n"),
  },
];

function parseBool(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const lower = value.trim().toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  return null;
}

function parseTools(value: string | undefined, block: string[]): string[] | null {
  if (block.length > 0) {
    const tools = block.map((item) => item.trim().toLowerCase()).filter((item) => item.length > 0);
    return tools.length > 0 ? tools : null;
  }
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const tools = inner
    .split(",")
    .map((item) =>
      item
        .trim()
        .toLowerCase()
        .replace(/^["']|["']$/g, ""),
    )
    .filter((item) => item.length > 0);
  return tools.length > 0 ? tools : null;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: null, body: normalized };
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: null, body: normalized };
  const after = normalized.slice(end + 4);
  const body = after.startsWith("\n") ? after.slice(1) : after;
  return { frontmatter: normalized.slice(4, end), body };
}

export function parseAgentFile(content: string, fallbackName: string): AgentDefinition | null {
  const { frontmatter, body } = splitFrontmatter(content);
  const trimmedBody = body.trim();
  const fields = new Map<string, string>();
  const lists = new Map<string, string[]>();
  if (frontmatter !== null) {
    let currentList: string | null = null;
    for (const rawLine of frontmatter.split("\n")) {
      const line = rawLine.trimEnd();
      const listMatch = line.match(/^\s+-\s+(.+)$/);
      if (listMatch && currentList) {
        lists.get(currentList)?.push(listMatch[1].trim());
        continue;
      }
      currentList = null;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
      if (!match) continue;
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (value === "") {
        currentList = key;
        lists.set(key, []);
        continue;
      }
      fields.set(key, stripQuotes(value));
    }
  }

  const name = stripQuotes(fields.get("name") ?? "").trim() || fallbackName.trim();
  if (!name || name.includes(":")) return null;
  const enabled = parseBool(fields.get("enabled")) ?? true;
  if (!enabled) {
    return {
      name,
      description: stripQuotes(fields.get("description") ?? ""),
      model: "inherit",
      tools: null,
      maxTurns: null,
      color: null,
      hidden: parseBool(fields.get("hidden")) ?? false,
      enabled: false,
      mode: "subagent",
      promptMode: "replace",
      body: "",
      source: "builtin",
      filePath: null,
    };
  }
  if (!trimmedBody) return null;

  const validModels = new Set(getModelIds());
  const rawModel = stripQuotes(fields.get("model") ?? "").trim();
  const normalizedModel = rawModel ? normalizeModelId(rawModel) : "";
  const model =
    normalizedModel === "inherit" || validModels.has(normalizedModel) ? normalizedModel || "inherit" : "inherit";
  const rawMaxTurns = Number.parseInt(fields.get("max_turns") ?? "", 10);
  const modeRaw = (fields.get("mode") ?? "").trim().toLowerCase();
  const promptModeRaw = (fields.get("prompt_mode") ?? "").trim().toLowerCase();
  return {
    name,
    description: stripQuotes(fields.get("description") ?? ""),
    model,
    tools: parseTools(fields.get("tools"), lists.get("tools") ?? []),
    maxTurns: Number.isFinite(rawMaxTurns) && rawMaxTurns > 0 ? rawMaxTurns : null,
    color: stripQuotes(fields.get("color") ?? "") || null,
    hidden: parseBool(fields.get("hidden")) ?? false,
    enabled: true,
    mode: modeRaw === "primary" || modeRaw === "all" ? modeRaw : "subagent",
    promptMode: promptModeRaw === "append" ? "append" : "replace",
    body: trimmedBody,
    source: "builtin",
    filePath: null,
  };
}

function readAgentFiles(dir: string, source: AgentSource): AgentDefinition[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".md") && !name.startsWith("."));
  } catch {
    return [];
  }
  names.sort();
  const definitions: AgentDefinition[] = [];
  for (const fileName of names) {
    const filePath = path.join(dir, fileName);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseAgentFile(content, fileName.slice(0, -3));
    if (!parsed) continue;
    definitions.push({ ...parsed, source, filePath });
  }
  return definitions;
}

export function builtinAgentDefinitions(): AgentDefinition[] {
  return BUILTIN_BODIES.map((builtin) => ({
    name: builtin.name,
    description: builtin.description,
    model: "inherit",
    tools: null,
    maxTurns: null,
    color: null,
    hidden: false,
    enabled: true,
    mode: "subagent" as const,
    promptMode: "replace" as const,
    body: builtin.body,
    source: "builtin" as const,
    filePath: null,
  }));
}

export function mergeAgentDefinitions(layers: AgentDefinition[][]): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const layer of layers) {
    for (const definition of layer) {
      byName.set(definition.name.toLowerCase(), definition);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function settingsToDefinitions(customs: CustomSubagentConfig[]): AgentDefinition[] {
  return customs.map((custom) => ({
    name: custom.name,
    description: "",
    model: custom.model,
    tools: null,
    maxTurns: null,
    color: null,
    hidden: false,
    enabled: true,
    mode: "subagent" as const,
    promptMode: "replace" as const,
    body: custom.instruction,
    source: "settings" as const,
    filePath: null,
  }));
}

export function loadAgentDefinitions(cwd: string): AgentDefinition[] {
  let settings: CustomSubagentConfig[] = [];
  try {
    settings = loadValidSubAgents();
  } catch {
    settings = [];
  }
  const globalDir = path.join(os.homedir(), ".crow", "agents");
  const projectDir = path.join(cwd, ".crow", "agents");
  return mergeAgentDefinitions([
    builtinAgentDefinitions(),
    settingsToDefinitions(settings),
    readAgentFiles(globalDir, "global"),
    readAgentFiles(projectDir, "project"),
  ]);
}

export function findAgentDefinition(definitions: AgentDefinition[], name: string): AgentDefinition | undefined {
  return (
    definitions.find((item) => item.name === name) ??
    definitions.find((item) => item.name.toLowerCase() === name.toLowerCase())
  );
}

export function isDelegatable(definition: AgentDefinition): boolean {
  return definition.enabled && !definition.hidden && definition.mode !== "primary";
}

export function delegatableAgentNames(definitions: AgentDefinition[]): string[] {
  return definitions.filter(isDelegatable).map((definition) => definition.name);
}

export function agentFileDir(scope: "project" | "global", cwd: string): string {
  return scope === "project" ? path.join(cwd, ".crow", "agents") : path.join(os.homedir(), ".crow", "agents");
}

export function agentFilePath(scope: "project" | "global", cwd: string, name: string): string {
  return path.join(agentFileDir(scope, cwd), `${name}.md`);
}

export function serializeAgentFile(name: string, input: AgentFileInput): string {
  const lines: string[] = ["---", `name: ${name}`];
  if (input.description) lines.push(`description: ${input.description}`);
  if (input.model && input.model !== "inherit") lines.push(`model: ${input.model}`);
  if (input.tools && input.tools.length > 0) lines.push(`tools: ${input.tools.join(", ")}`);
  if (input.maxTurns !== null) lines.push(`max_turns: ${input.maxTurns}`);
  if (input.color) lines.push(`color: ${input.color}`);
  if (input.hidden) lines.push("hidden: true");
  if (!input.enabled) lines.push("enabled: false");
  if (input.mode !== "subagent") lines.push(`mode: ${input.mode}`);
  if (input.promptMode !== "replace") lines.push(`prompt_mode: ${input.promptMode}`);
  lines.push("---", "");
  lines.push(input.body.trim());
  return `${lines.join("\n")}\n`;
}

export function writeAgentFile(scope: "project" | "global", cwd: string, name: string, input: AgentFileInput): string {
  const dir = agentFileDir(scope, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  fs.writeFileSync(filePath, serializeAgentFile(name, input), "utf-8");
  return filePath;
}

export function disableBuiltinAgent(scope: "project" | "global", cwd: string, name: string): string {
  return writeAgentFile(scope, cwd, name, {
    description: "",
    model: "inherit",
    tools: null,
    maxTurns: null,
    color: null,
    hidden: false,
    enabled: false,
    mode: "subagent",
    promptMode: "replace",
    body: "",
  });
}

export function deleteAgentFile(scope: "project" | "global", cwd: string, name: string): void {
  try {
    fs.unlinkSync(agentFilePath(scope, cwd, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
