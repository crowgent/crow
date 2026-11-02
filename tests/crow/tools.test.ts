import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTools } from "../../src/crow/tools";
import { BashTool } from "../../src/tools/bash";
import { ShellService } from "../../src/tools/shell";

function createScheduleToolSet(overrides?: {
  getDaemonStatus?: () => Promise<{ running: boolean; pid: number | null }>;
  startDaemon?: () => Promise<{
    status: { running: boolean; pid: number | null };
    pid: number | null;
    alreadyRunning: boolean;
  }>;
  stopDaemon?: () => Promise<{
    status: { running: boolean; pid: number | null };
    pid: number | null;
    wasRunning: boolean;
  }>;
}) {
  const scheduleManager = {
    getDaemonStatus: overrides?.getDaemonStatus ?? vi.fn(async () => ({ running: false, pid: null })),
    startDaemon:
      overrides?.startDaemon ??
      vi.fn(async () => ({ status: { running: true, pid: 1234 }, pid: 1234, alreadyRunning: false })),
    stopDaemon:
      overrides?.stopDaemon ??
      vi.fn(async () => ({ status: { running: false, pid: null }, pid: 1234, wasRunning: true })),
  };

  const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
    scheduleManager: scheduleManager as never,
  });

  return {
    tools: tools as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown> }>,
    scheduleManager,
  };
}

describe("schedule daemon tools", () => {
  it("describes bash sandbox constraints when shuru mode is enabled", () => {
    const tools = createTools(new BashTool("/tmp", { sandboxMode: "shuru" }), {} as never, "agent");
    const bashTool = tools.bash as { description?: string };

    expect(bashTool.description).toContain("Shuru sandbox");
    expect(bashTool.description).toContain("do not persist back to the host");
  });

  it("reflects network enabled in sandbox tool description", () => {
    const tools = createTools(
      new BashTool("/tmp", { sandboxMode: "shuru", sandboxSettings: { allowNet: true } }),
      {} as never,
      "agent",
    );
    const bashTool = tools.bash as { description?: string };
    expect(bashTool.description).toContain("network access is enabled");
  });

  it("reflects restricted hosts in sandbox tool description", () => {
    const tools = createTools(
      new BashTool("/tmp", {
        sandboxMode: "shuru",
        sandboxSettings: { allowNet: true, allowedHosts: ["api.openai.com"] },
      }),
      {} as never,
      "agent",
    );
    const bashTool = tools.bash as { description?: string };
    expect(bashTool.description).toContain("network is restricted to: api.openai.com");
  });

  it("mentions host-side browser automation when enabled", () => {
    const tools = createTools(
      new BashTool("/tmp", {
        sandboxMode: "shuru",
        sandboxSettings: { allowNet: true, hostBrowserCommandsOnHost: true },
      }),
      {} as never,
      "agent",
    );
    const bashTool = tools.bash as { description?: string };
    expect(bashTool.description).toContain("agent-browser run on the host");
  });

  it("routes verify requests through the subagent tool", async () => {
    const runSubagent = vi.fn(async () => ({ success: true, output: "verified" }));
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      runSubagent,
      subagents: [],
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }>;

    const taskTool = tools.subagent;
    expect(taskTool.description).toContain("`verify`");

    const result = (await taskTool.execute(
      {
        agent: "verify",
        description: "Run local verification",
        prompt: "Verify the current workspace.",
      },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(runSubagent).toHaveBeenCalledWith(
      {
        agent: "verify",
        description: "Run local verification",
        prompt: "Verify the current workspace.",
      },
      undefined,
    );
    expect(result).toEqual({ success: true, output: "verified" });
  });

  it("routes verify-detect requests through the subagent tool", async () => {
    const runSubagent = vi.fn(async () => ({ success: true, output: "recipe" }));
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      runSubagent,
      subagents: [],
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }>;

    const taskTool = tools.subagent;
    expect(taskTool.description).toContain("`verify-detect`");

    const result = (await taskTool.execute(
      {
        agent: "verify-detect",
        description: "Detect verification recipe",
        prompt: "Inspect the repository and return a VerifyRecipe JSON object.",
      },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(runSubagent).toHaveBeenCalledWith(
      {
        agent: "verify-detect",
        description: "Detect verification recipe",
        prompt: "Inspect the repository and return a VerifyRecipe JSON object.",
      },
      undefined,
    );
    expect(result).toEqual({ success: true, output: "recipe" });
  });

  it("routes verify-manifest requests through the subagent tool", async () => {
    const runSubagent = vi.fn(async () => ({ success: true, output: "manifest written" }));
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      runSubagent,
      subagents: [],
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }>;

    const taskTool = tools.subagent;
    expect(taskTool.description).toContain("`verify-manifest`");

    const result = (await taskTool.execute(
      {
        agent: "verify-manifest",
        description: "Create verify manifest",
        prompt: "Inspect the repository and write .crow/environment.json.",
      },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(runSubagent).toHaveBeenCalledWith(
      {
        agent: "verify-manifest",
        description: "Create verify manifest",
        prompt: "Inspect the repository and write .crow/environment.json.",
      },
      undefined,
    );
    expect(result).toEqual({ success: true, output: "manifest written" });
  });

  it("exposes computer tools and routes computer requests through the subagent tool", async () => {
    const runSubagent = vi.fn(async () => ({ success: true, output: "computer-ready" }));
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      runSubagent,
      subagents: [],
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }>;

    expect(tools).toHaveProperty("computer_screenshot");
    expect(tools).toHaveProperty("computer_snapshot");
    expect(tools).toHaveProperty("computer_click");
    expect(tools).toHaveProperty("computer_mouse_move");
    expect(tools).toHaveProperty("computer_type");
    expect(tools).toHaveProperty("computer_press");
    expect(tools).toHaveProperty("computer_scroll");
    expect(tools).toHaveProperty("computer_launch");
    expect(tools).toHaveProperty("computer_list_windows");
    expect(tools).toHaveProperty("computer_focus_window");
    expect(tools).toHaveProperty("computer_wait");
    expect(tools).toHaveProperty("computer_get");

    const taskTool = tools.subagent;
    expect(taskTool.description).toContain("`computer`");

    const result = (await taskTool.execute(
      {
        agent: "computer",
        description: "Drive the host desktop",
        prompt: "Take a screenshot and click the requested target.",
      },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(runSubagent).toHaveBeenCalledWith(
      {
        agent: "computer",
        description: "Drive the host desktop",
        prompt: "Take a screenshot and click the requested target.",
      },
      undefined,
    );
    expect(result).toEqual({ success: true, output: "computer-ready" });
  });

  it("reports daemon status", async () => {
    const { tools } = createScheduleToolSet({
      getDaemonStatus: async () => ({ running: true, pid: 4321 }),
    });

    const result = (await tools.schedule_daemon_status.execute({}, {})) as { success: boolean; output: string };

    expect(result.success).toBe(true);
    expect(result.output).toContain("Daemon status: running");
    expect(result.output).toContain("4321");
  });

  it("formats daemon start output for a fresh start", async () => {
    const { tools } = createScheduleToolSet({
      startDaemon: async () => ({ status: { running: true, pid: 5555 }, pid: 5555, alreadyRunning: false }),
    });

    const result = (await tools.schedule_daemon_start.execute({}, {})) as { success: boolean; output: string };

    expect(result.success).toBe(true);
    expect(result.output).toBe("Schedule daemon started (pid 5555).");
  });

  it("formats daemon start output when already running", async () => {
    const { tools } = createScheduleToolSet({
      startDaemon: async () => ({ status: { running: true, pid: 7777 }, pid: 7777, alreadyRunning: true }),
    });

    const result = (await tools.schedule_daemon_start.execute({}, {})) as { success: boolean; output: string };

    expect(result.success).toBe(true);
    expect(result.output).toBe("Schedule daemon already running (pid 7777).");
  });

  it("passes model, sessionID, and background through the subagent tool", async () => {
    const runSubagent = vi.fn(async () => ({ success: true, output: "done" }));
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      runSubagent,
      subagents: [],
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown>; description?: string }>;

    expect(tools).toHaveProperty("subagent");
    expect(tools).not.toHaveProperty("task");
    expect(tools).not.toHaveProperty("delegate");
    expect(tools.subagent.description).toContain("child session");

    const result = (await tools.subagent.execute(
      {
        agent: "explore",
        description: "Follow up research",
        prompt: "Continue the earlier research.",
        model: "xai/grok-4.7",
        sessionID: "abc123def456",
        background: true,
      },
      { abortSignal: undefined },
    )) as { success: boolean; output: string };

    expect(runSubagent).toHaveBeenCalledWith(
      {
        agent: "explore",
        description: "Follow up research",
        prompt: "Continue the earlier research.",
        model: "xai/grok-4.7",
        sessionID: "abc123def456",
        background: true,
      },
      undefined,
    );
    expect(result).toEqual({ success: true, output: "done" });
  });
});

describe("shell tool", () => {
  it("exposes a shell with background streaming", () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent");
    const shellTool = tools.shell as { description?: string };

    expect(shellTool.description).toContain("Execute a shell command and return its output");
    expect(shellTool.description).toContain("shell ID");
    expect(shellTool.description).toContain("stream output to a file");
  });

  it("runs a command in the given workdir", async () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      shell: new ShellService(await mkdtemp(join(tmpdir(), "crow-shell-out-"))),
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown> }>;
    const dir = await mkdtemp(join(tmpdir(), "crow-shell-test-"));

    try {
      const result = (await tools.shell.execute({ command: "pwd", workdir: dir }, {})) as {
        success: boolean;
        output: string;
        exit: number;
        shellId: string;
      };
      expect(result.success).toBe(true);
      expect(result.output).toBe(dir);
      expect(result.exit).toBe(0);
      expect(typeof result.shellId).toBe("string");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a shell ID and log file for background commands", async () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      shell: new ShellService(await mkdtemp(join(tmpdir(), "crow-shell-out-"))),
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown> }>;
    const result = (await tools.shell.execute({ command: "echo shell-bg-ok", background: true }, {})) as {
      success: boolean;
      output: string;
    };
    expect(result.success).toBe(true);
    expect(result.output).toContain("shell ID");
    expect(result.output).toContain("streaming to");
    expect(result.output).toContain("notified");
  });

  it("reports a nonzero exit with its code", async () => {
    const tools = createTools(new BashTool("/tmp"), {} as never, "agent", {
      shell: new ShellService(await mkdtemp(join(tmpdir(), "crow-shell-out-"))),
    }) as Record<string, { execute: (input: unknown, context?: unknown) => Promise<unknown> }>;
    const result = (await tools.shell.execute({ command: "exit 3" }, {})) as {
      success: boolean;
      output: string;
      exit: number;
    };
    expect(result.success).toBe(false);
    expect(result.exit).toBe(3);
    expect(result.output).toContain("Exited with code 3");
  });
});
