import { describe, expect, it, vi } from "vitest";
import { withPermissionGate } from "../../src/crow/permission-gate";
import type { PermissionEffect } from "../../src/crow/permissions";

function gatedTools(
  evaluate: (action: string, resource: string) => PermissionEffect,
  resolve?: (request: { action: string; resource: string }) => Promise<"allow" | "deny">,
) {
  const run = vi.fn(async (input: { command: string }) => ({ success: true, output: `ran ${input.command}` }));
  const tools = withPermissionGate(
    {
      bash: { description: "bash", inputSchema: {}, execute: run },
      read_file: {
        description: "read",
        inputSchema: {},
        execute: async () => ({ success: true, output: "content" }),
      },
    } as never,
    { evaluate, resolve },
  ) as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
  return { tools, run };
}

describe("withPermissionGate", () => {
  it("runs allowed tools and leaves ungated tools alone", async () => {
    const { tools, run } = gatedTools(() => "allow");
    const result = (await tools.bash.execute({ command: "ls" }, {})) as { output: string };
    expect(result.output).toBe("ran ls");
    expect(run).toHaveBeenCalledTimes(1);
    const read = (await tools.read_file.execute({ path: "a.txt" }, {})) as { output: string };
    expect(read.output).toBe("content");
  });

  it("blocks denied tools without running them", async () => {
    const { tools, run } = gatedTools(() => "deny");
    const result = (await tools.bash.execute({ command: "rm -rf /" }, {})) as {
      success: boolean;
      output: string;
    };
    expect(result.success).toBe(false);
    expect(result.output).toContain("Permission denied by rule");
    expect(run).not.toHaveBeenCalled();
  });

  it("denies asks without a resolver for unattended sessions", async () => {
    const { tools, run } = gatedTools(() => "ask");
    const result = (await tools.bash.execute({ command: "ls" }, {})) as {
      success: boolean;
      output: string;
    };
    expect(result.success).toBe(false);
    expect(result.output).toContain("unattended");
    expect(run).not.toHaveBeenCalled();
  });

  it("asks the resolver when present and honors its answer", async () => {
    const seen: { action: string; resource: string }[] = [];
    const { tools, run } = gatedTools(
      () => "ask",
      async (request) => {
        seen.push(request);
        return request.resource === "ls" ? "allow" : "deny";
      },
    );
    const ok = (await tools.bash.execute({ command: "ls" }, {})) as { output: string };
    expect(ok.output).toBe("ran ls");
    const no = (await tools.bash.execute({ command: "rm -rf /" }, {})) as {
      success: boolean;
      output: string;
    };
    expect(no.success).toBe(false);
    expect(no.output).toContain("Permission denied by user");
    expect(seen).toEqual([
      { action: "bash", resource: "ls", toolName: "bash" },
      { action: "bash", resource: "rm -rf /", toolName: "bash" },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
