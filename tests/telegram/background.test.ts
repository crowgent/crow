import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getTelegramBridgePidPath,
  isTelegramBridgeRunning,
  readTelegramBridgePid,
  removeTelegramBridgePid,
  stopDetachedTelegramBridge,
  writeTelegramBridgePid,
} from "../../src/telegram/background";

describe("telegram bridge pid file", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "crow-bridge-"));
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("writes and reads back a live pid", () => {
    writeTelegramBridgePid(process.pid);
    expect(readTelegramBridgePid()).toBe(process.pid);
    expect(isTelegramBridgeRunning()).toBe(true);
  });

  it("treats a dead pid as not running and cleans up", async () => {
    const child = spawn("true");
    const deadPid = child.pid;
    await new Promise((resolve) => child.on("exit", resolve));
    expect(deadPid).not.toBeNull();
    writeTelegramBridgePid(deadPid as number);
    expect(isTelegramBridgeRunning()).toBe(false);
    expect(fs.existsSync(getTelegramBridgePidPath())).toBe(false);
  });

  it("treats garbage pid content as not running and cleans up", () => {
    fs.mkdirSync(path.dirname(getTelegramBridgePidPath()), { recursive: true });
    fs.writeFileSync(getTelegramBridgePidPath(), "not-a-pid\n", "utf8");
    expect(readTelegramBridgePid()).toBeNull();
    expect(fs.existsSync(getTelegramBridgePidPath())).toBe(false);
  });

  it("stops a live process and removes the pid file", async () => {
    const child = spawn("sleep", ["30"]);
    expect(child.pid).not.toBeNull();
    writeTelegramBridgePid(child.pid as number);
    expect(await stopDetachedTelegramBridge()).toBe(true);
    expect(() => process.kill(child.pid as number, 0)).toThrow();
    expect(fs.existsSync(getTelegramBridgePidPath())).toBe(false);
  });

  it("returns false when nothing is running", async () => {
    removeTelegramBridgePid();
    expect(await stopDetachedTelegramBridge()).toBe(false);
  });
});
