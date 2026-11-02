import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCommand, resolveShell, SHELL_OUTPUT_MAX_LINES, ShellService } from "../../src/tools/shell";

const tempDirs: string[] = [];
const services: ShellService[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeService(): ShellService {
  const service = new ShellService(makeTempDir("crow-shell-svc-"));
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.cleanup();
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveShell", () => {
  it("returns an existing executable shell", () => {
    const shell = resolveShell();
    expect(fs.existsSync(shell)).toBe(true);
  });
});

describe("classifyCommand", () => {
  it("extracts one resource per pipeline segment", () => {
    expect(classifyCommand("git status && npm test | grep pass")).toEqual({
      kind: "scanned",
      commands: ["git", "npm", "grep"],
    });
  });

  it("skips env assignments and wrappers", () => {
    expect(classifyCommand("FOO=1 sudo apt update")).toEqual({
      kind: "scanned",
      commands: ["apt"],
    });
  });

  it("does not split on quoted separators", () => {
    expect(classifyCommand("echo 'a && b'")).toEqual({
      kind: "scanned",
      commands: ["echo"],
    });
  });

  it("marks substitution and heredoc as opaque", () => {
    expect(classifyCommand("echo $(whoami)").kind).toBe("opaque");
    expect(classifyCommand("echo `whoami`").kind).toBe("opaque");
    expect(classifyCommand("cat <<EOF\nhi\nEOF").kind).toBe("opaque");
  });
});

describe("ShellService", () => {
  it("runs a foreground command with exit code and file output", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run("echo shell-ok && pwd", { cwd: dir });
    expect(info.status).toBe("running");
    const result = await service.result(info.id);
    expect(result.info.status).toBe("exited");
    expect(result.info.exit).toBe(0);
    expect(result.output).toBe(`shell-ok\n${dir}`);
    expect(result.truncated).toBe(false);
    expect(fs.existsSync(result.info.file)).toBe(true);
    const page = await service.output(info.id, 0, 5);
    expect(page.output).toBe("shell");
    expect(page.size).toBeGreaterThan(5);
  });

  it("reports a nonzero exit", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run("exit 3", { cwd: dir });
    const result = await service.result(info.id);
    expect(result.info.status).toBe("exited");
    expect(result.info.exit).toBe(3);
  });

  it("times out a long command", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run("sleep 30", { cwd: dir, timeout: 100 });
    const result = await service.result(info.id);
    expect(result.info.status).toBe("timeout");
  });

  it("rejects a missing workdir", async () => {
    const service = makeService();
    await expect(service.run("pwd", { cwd: "/tmp/crow-does-not-exist-xyz" })).rejects.toThrow("does not exist");
  });

  it("truncates long output to a tail with a notice", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run(`seq 1 ${SHELL_OUTPUT_MAX_LINES + 500}`, { cwd: dir });
    const result = await service.result(info.id);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(SHELL_OUTPUT_MAX_LINES + 500);
    expect(result.shownFrom).toBe(501);
    expect(result.shownTo).toBe(SHELL_OUTPUT_MAX_LINES + 500);
    expect(result.output).toContain("full output saved to");
    expect(result.output).toContain(`\n${SHELL_OUTPUT_MAX_LINES + 500}\n\n[showing lines`);
  });

  it("fires onExit when a background command completes", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const events: Array<{ id: string; status: string }> = [];
    const info = await service.run("echo bg-done", {
      cwd: dir,
      onExit: (event) => {
        events.push({ id: event.info.id, status: event.info.status });
      },
    });
    await service.wait(info.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual([{ id: info.id, status: "exited" }]);
  });

  it("lists running shells and removes finished ones", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run("sleep 30", { cwd: dir });
    expect(service.list().map((item) => item.id)).toContain(info.id);
    await service.remove(info.id);
    expect(service.get(info.id)).toBeUndefined();
    expect(service.list()).toEqual([]);
    expect(fs.existsSync(info.file)).toBe(false);
  });
});
