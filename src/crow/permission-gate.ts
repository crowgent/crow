import type { ToolExecutionOptions, ToolSet } from "ai";
import { classifyCommand } from "../tools/shell";
import type { PermissionEffect, PermissionResolver } from "./permissions";

export interface PermissionGateOptions {
  evaluate: (action: string, resource: string) => PermissionEffect;
  resolve?: PermissionResolver;
}

type ResourceExtractor = (input: Record<string, unknown>) => string;

function stringField(field: string): ResourceExtractor {
  return (input) => {
    const value = input[field];
    return typeof value === "string" ? value : "";
  };
}

function jsonInput(input: Record<string, unknown>): string {
  return JSON.stringify(input);
}

export const GATED_TOOLS: Record<string, ResourceExtractor> = {
  bash: stringField("command"),
  shell: (input) => {
    const command = stringField("command")(input);
    const classified = classifyCommand(command);
    return classified.kind === "scanned" && classified.commands.length > 0 ? classified.commands.join(", ") : command;
  },
  process_stop: (input) => String(input.id ?? ""),
  write_file: stringField("path"),
  edit_file: stringField("path"),
  subagent: stringField("agent"),
  schedule_create: stringField("name"),
  schedule_remove: stringField("id"),
  schedule_daemon_start: () => "",
  schedule_daemon_stop: () => "",
  telegram_send_file: stringField("path"),
  snapshot_revert: stringField("id"),
  worktree_remove: stringField("path"),
  computer_click: jsonInput,
  computer_type: jsonInput,
  computer_press: jsonInput,
  computer_mouse_move: jsonInput,
  computer_scroll: jsonInput,
  computer_launch: jsonInput,
};

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    promise.then(resolve, reject);
  });
}

export function withPermissionGate(tools: ToolSet, options: PermissionGateOptions): ToolSet {
  const gated: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    const extract = GATED_TOOLS[name];
    if (!tool || typeof tool.execute !== "function" || !extract) {
      gated[name] = tool;
      continue;
    }
    const originalExecute = tool.execute.bind(tool);
    gated[name] = {
      ...tool,
      execute: (async (input: never, executeOptions: ToolExecutionOptions) => {
        const record = (input ?? {}) as Record<string, unknown>;
        const resource = extract(record);
        const effect = options.evaluate(name, resource);
        if (effect === "allow") {
          return originalExecute(input, executeOptions);
        }
        if (effect === "deny") {
          return { success: false, output: `Permission denied by rule: ${name} ${resource}` };
        }
        if (!options.resolve) {
          return {
            success: false,
            output: `Permission denied: ${name} ${resource} requires approval, but this session cannot ask (unattended). Add an allow rule to ~/.crow/permissions.json to permit it.`,
          };
        }
        const decision = await raceWithAbort(
          options.resolve({ action: name, resource, toolName: name }),
          executeOptions?.abortSignal,
        );
        if (decision === "allow") {
          return originalExecute(input, executeOptions);
        }
        return { success: false, output: `Permission denied by user: ${name} ${resource}` };
      }) as typeof tool.execute,
    };
  }
  return gated;
}
