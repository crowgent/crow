import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCommand, resolveShell, SHELL_OUTPUT_MAX_LINES, ShellService, shellArgs } from "../../src/tools/shell";

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
    expect(fs.readFileSync(result.info.file, "utf8")).toBe(`shell-ok\n${dir}\n`);
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

  it("stops a running shell with a kill signal", async () => {
    const service = makeService();
    const dir = makeTempDir("crow-shell-run-");
    const info = await service.run("sleep 30", { cwd: dir });
    service.stop(info.id);
    const result = await service.result(info.id);
    expect(result.info.status).toBe("killed");
    expect(result.info.signal).toBe("SIGTERM");
  });
});

describe("shell selection", () => {
  it("uses PowerShell arguments for pwsh", () => {
    expect(shellArgs("pwsh", "Get-ChildItem")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-ChildItem",
    ]);
    expect(shellArgs("/usr/bin/powershell", "ls")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "ls",
    ]);
    expect(shellArgs("cmd", "dir")).toEqual(["/c", "dir"]);
    expect(shellArgs("/bin/bash", "ls")).toEqual(["-c", "ls"]);
  });

  it("prefers a configured shell over $SHELL", async () => {
    const bin = makeTempDir("crow-shell-bin-");
    const link = path.join(bin, "myshell");
    fs.symlinkSync("/bin/bash", link);
    const previous = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      expect(resolveShell(link)).toBe(link);
      const service = new ShellService(makeTempDir("crow-shell-svc-"), link);
      services.push(service);
      const dir = makeTempDir("crow-shell-run-");
      const info = await service.run("echo configured-ok", { cwd: dir });
      expect(info.shell).toBe(link);
      const result = await service.result(info.id);
      expect(result.info.exit).toBe(0);
      expect(result.output).toBe("configured-ok");
    } finally {
      if (previous === undefined) delete process.env.SHELL;
      else process.env.SHELL = previous;
    }
  });

  it("never resolves a denied shell, even when configured", () => {
    const bin = makeTempDir("crow-shell-bin-");
    const fake = path.join(bin, "fish");
    fs.writeFileSync(fake, "#!/bin/sh\necho fake\n");
    fs.chmodSync(fake, 0o755);
    expect(resolveShell(fake)).not.toBe(fake);
    expect(resolveShell("fish")).not.toBe("fish");
  });
});
