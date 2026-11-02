import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolExecutionOptions, ToolSet } from "ai";
import type { ToolResult } from "../types/index";

export const MAX_TOOL_OUTPUT_LINES = 2000;
export const MAX_TOOL_OUTPUT_BYTES = 50_000;

export function truncateToolOutput(
  output: string,
  options?: { sessionId?: string; toolCallId?: string; outDir?: string },
): { text: string; truncated: boolean; filePath?: string } {
  const totalLines = output.split("\n").length;
  const totalBytes = Buffer.byteLength(output, "utf8");
  if (totalLines <= MAX_TOOL_OUTPUT_LINES && totalBytes <= MAX_TOOL_OUTPUT_BYTES) {
    return { text: output, truncated: false };
  }

  let kept = output;
  if (totalLines > MAX_TOOL_OUTPUT_LINES) {
    kept = output.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES).join("\n");
  }
  if (Buffer.byteLength(kept, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    kept = Buffer.from(kept, "utf8").subarray(0, MAX_TOOL_OUTPUT_BYTES).toString("utf8");
  }
  const keptLines = kept.split("\n").length;
  const keptBytes = Buffer.byteLength(kept, "utf8");

  let filePath: string | undefined;
  try {
    const outDir = options?.outDir ?? path.join(os.homedir(), ".crow", "tool-outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const safeSession = (options?.sessionId ?? "session").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeCall = (options?.toolCallId ?? `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, "_");
    filePath = path.join(outDir, `${safeSession}-${safeCall}.txt`);
    fs.writeFileSync(filePath, output);
  } catch {
    filePath = undefined;
  }

  const filePart = filePath ? ` Full output saved to ${filePath}.` : "";
  return {
    text:
      `${kept}\n\n[Output truncated to the first ${keptLines} lines / ${keptBytes} bytes ` +
      `of ${totalLines} lines / ${totalBytes} bytes.${filePart}]`,
    truncated: true,
    filePath,
  };
}

export function withToolOutputCap(tools: ToolSet, sessionId?: string, outDir?: string): ToolSet {
  const capped: ToolSet = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== "function") {
      capped[name] = tool;
      continue;
    }
    const originalExecute = tool.execute.bind(tool);
    capped[name] = {
      ...tool,
      execute: (async (input: never, executeOptions: ToolExecutionOptions) => {
        const result = (await originalExecute(input, executeOptions)) as unknown;
        if (
          result &&
          typeof result === "object" &&
          "output" in result &&
          typeof (result as ToolResult).output === "string"
        ) {
          const typed = result as ToolResult;
          const truncated = truncateToolOutput(typed.output as string, {
            sessionId,
            toolCallId: executeOptions?.toolCallId,
            outDir,
          });
          if (truncated.truncated) {
            return { ...typed, output: truncated.text };
          }
        }
        return result;
      }) as typeof tool.execute,
    };
  }
  return capped;
}
