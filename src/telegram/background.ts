import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

export function getTelegramBridgePidPath(): string {
  return path.join(os.homedir(), ".crow", "telegram-bridge.pid");
}

export function readTelegramBridgePid(): number | null {
  try {
    const raw = fs.readFileSync(getTelegramBridgePidPath(), "utf8").trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      fs.rmSync(getTelegramBridgePidPath(), { force: true });
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

export function writeTelegramBridgePid(pid: number): void {
  fs.mkdirSync(path.dirname(getTelegramBridgePidPath()), { recursive: true });
  fs.writeFileSync(getTelegramBridgePidPath(), `${pid}\n`, "utf8");
}

export function removeTelegramBridgePid(): void {
  fs.rmSync(getTelegramBridgePidPath(), { force: true });
}

export function isTelegramBridgeRunning(): boolean {
  const pid = readTelegramBridgePid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    removeTelegramBridgePid();
    return false;
  }
}

export function spawnDetachedTelegramBridge(): number | null {
  const runningPid = readTelegramBridgePid();
  if (runningPid !== null) {
    try {
      process.kill(runningPid, 0);
      return runningPid;
    } catch {
      removeTelegramBridgePid();
    }
  }
  const script = process.argv[1];
  const args = script?.endsWith(".js") ? [script, "telegram-bridge"] : ["telegram-bridge"];
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", cwd: process.cwd() });
    child.unref();
    if (!child.pid) return null;
    writeTelegramBridgePid(child.pid);
    return child.pid;
  } catch {
    return null;
  }
}

export async function stopDetachedTelegramBridge(): Promise<boolean> {
  const pid = readTelegramBridgePid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
  } catch {
    removeTelegramBridgePid();
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removeTelegramBridgePid();
    return false;
  }
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      removeTelegramBridgePid();
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
  removeTelegramBridgePid();
  return true;
}
