import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { truncateToolOutput, withToolOutputCap } from "../../src/crow/tool-output-cap";

describe("truncateToolOutput", () => {
  it("leaves small output untouched", () => {
    const result = truncateToolOutput("hello\nworld");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("hello\nworld");
    expect(result.filePath).toBeUndefined();
  });

  it("truncates long output to the first lines and keeps the full text in a file", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-cap-"));
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i}`);
    const result = truncateToolOutput(lines.join("\n"), { sessionId: "s1", toolCallId: "c1", outDir });
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith("line 0\nline 1")).toBe(true);
    expect(result.text).toContain("line 1999");
    expect(result.text).not.toContain("line 2000\n");
    expect(result.text).toContain("Full output saved to");
    expect(result.filePath).toBeDefined();
    expect(fs.readFileSync(result.filePath as string, "utf8")).toBe(lines.join("\n"));
  });

  it("truncates a single oversized line by bytes", () => {
    const result = truncateToolOutput("x".repeat(60_000));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(50_000 + 200);
    expect(result.text).toContain("Output truncated");
  });
});

describe("withToolOutputCap", () => {
  type AnyTool = { execute: (input: unknown, options: unknown) => Promise<unknown> };
  function cappedTools(defs: Record<string, unknown>, sessionId: string, outDir: string): Record<string, AnyTool> {
    return withToolOutputCap(defs as never, sessionId, outDir) as unknown as Record<string, AnyTool>;
  }

  it("truncates tool results with a large output field", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-cap-wrap-"));
    const tools = cappedTools(
      {
        big: {
          description: "big",
          inputSchema: {},
          execute: async () => ({ success: true, output: "y".repeat(60_000) }),
        },
      },
      "sess",
      outDir,
    );
    const result = (await tools.big.execute(undefined, undefined)) as { output: string };
    expect(result.output).toContain("Output truncated");
    expect(result.output.length).toBeLessThan(60_000);
    const files = fs.readdirSync(outDir);
    expect(files.length).toBe(1);
    expect(fs.readFileSync(path.join(outDir, files[0]), "utf8")).toBe("y".repeat(60_000));
  });

  it("passes through results without a string output", async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-cap-wrap-"));
    const tools = cappedTools(
      {
        plain: {
          description: "plain",
          inputSchema: {},
          execute: async () => ({ success: true }),
        },
      },
      "sess",
      outDir,
    );
    const result = await tools.plain.execute(undefined, undefined);
    expect(result).toEqual({ success: true });
  });
});
