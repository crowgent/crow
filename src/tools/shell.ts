import { randomBytes } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import { type ChildProcess, spawn } from "child_process";
import { createWriteStream } from "fs";
import os from "os";
import path from "path";

export const SHELL_OUTPUT_MAX_BYTES = 50_000;
export const SHELL_OUTPUT_MAX_LINES = 2000;
const EXITED_LIMIT = 25;
const FORCE_KILL_MS = 3000;

export type ShellStatus = "running" | "exited" | "timeout" | "killed";

export interface ShellInfo {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  file: string;
  pid?: number;
  status: ShellStatus;
  exit?: number;
  signal?: string;
  startedAt: number;
  completedAt?: number;
}

export interface ShellResult {
  info: ShellInfo;
  output: string;
  truncated: boolean;
  totalLines: number;
  shownFrom: number;
  shownTo: number;
}

export interface ShellExitEvent {
  info: ShellInfo;
  result: ShellResult;
}

export interface ShellRunOptions {
  cwd: string;
  timeout?: number;
  sessionId?: string;
  onExit?: (event: ShellExitEvent) => void;
}

export interface ShellOutputPage {
  output: string;
  cursor: number;
  size: number;
  truncated: boolean;
}

export type CommandClassification = { kind: "scanned"; commands: string[] } | { kind: "opaque" };

const COMPATIBLE_SHELLS = new Set(["bash", "dash", "ksh", "sh", "zsh"]);
const COMMAND_WRAPPERS = new Set(["sudo", "command", "time", "nice", "env"]);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function resolveShell(): string {
  const envShell = process.env.SHELL;
  if (envShell) {
    const name = path.basename(envShell).toLowerCase();
    if (COMPATIBLE_SHELLS.has(name)) {
      if (path.isAbsolute(envShell) && isExecutableFile(envShell)) return envShell;
      const found = findOnPath(envShell);
      if (found) return found;
    }
  }
  return findOnPath("bash") ?? "/bin/sh";
}

export function shellArgs(command: string): string[] {
  return ["-c", command];
}

export function classifyCommand(command: string): CommandClassification {
  const segments: string[] = [];
  let current = "";
  let single = false;
  let double = false;
  let i = 0;
  const push = () => {
    segments.push(current);
    current = "";
  };
  while (i < command.length) {
    const ch = command[i];
    if (single) {
      current += ch;
      if (ch === "'") single = false;
      i++;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 2;
        continue;
      }
      current += ch;
      i++;
      continue;
    }
    if (ch === "'") {
      single = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      double = !double;
      current += ch;
      i++;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") return { kind: "opaque" };
    if (ch === "`") return { kind: "opaque" };
    if (ch === "<" && command[i + 1] === "<") return { kind: "opaque" };
    if (ch === "(" || ch === ")") return { kind: "opaque" };
    if (!double) {
      if (ch === "\n" || ch === ";") {
        push();
        i++;
        continue;
      }
      if (ch === "&") {
        push();
        i += command[i + 1] === "&" ? 2 : 1;
        continue;
      }
      if (ch === "|") {
        push();
        i += command[i + 1] === "&" ? 2 : 1;
        continue;
      }
    }
    current += ch;
    i++;
  }
  if (single || double) return { kind: "opaque" };
  push();
  const commands: string[] = [];
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let idx = 0;
    while (idx < tokens.length && (ENV_ASSIGN.test(tokens[idx]) || COMMAND_WRAPPERS.has(tokens[idx]))) idx++;
    if (idx < tokens.length) {
      const name = tokens[idx].replace(/^['"]|['"]$/g, "");
      if (name) commands.push(name);
    }
  }
  return { kind: "scanned", commands };
}

interface ActiveShell {
  info: ShellInfo;
  child: ChildProcess;
  done: Promise<ShellInfo>;
  resolveDone: (info: ShellInfo) => void;
  size: number;
  newlines: number;
  settled: boolean;
  timedOut: boolean;
  timeoutTimer?: NodeJS.Timeout;
  forceKillTimer?: NodeJS.Timeout;
  lastResult?: ShellResult;
  onExit?: (event: ShellExitEvent) => void;
}

export class ShellService {
  private shells = new Map<string, ActiveShell>();
  private exitOrder: string[] = [];
  private dirReady: Promise<void> | null = null;

  constructor(private outputDir: string = path.join(os.homedir(), ".crow", "shell-outputs")) {}

  private ensureDir(): Promise<void> {
    if (!this.dirReady) {
      this.dirReady = mkdir(this.outputDir, { recursive: true }).then(() => {});
    }
    return this.dirReady;
  }

  async run(command: string, options: ShellRunOptions): Promise<ShellInfo> {
    const cwd = path.resolve(options.cwd);
    const dirInfo = await stat(cwd).catch(() => null);
    if (!dirInfo) throw new Error(`Working directory does not exist: ${cwd}`);
    if (!dirInfo.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`);
    await this.ensureDir();
    const shell = resolveShell();
    const id = randomBytes(6).toString("hex");
    const file = path.join(this.outputDir, `sh_${id}.out`);
    const info: ShellInfo = {
      id,
      command,
      cwd,
      shell,
      file,
      status: "running",
      startedAt: Date.now(),
    };
    let resolveDone!: (value: ShellInfo) => void;
    const done = new Promise<ShellInfo>((resolve) => {
      resolveDone = resolve;
    });
    const child = spawn(shell, shellArgs(command), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        TERM: "xterm-256color",
        AGENT: "1",
        CROW: "1",
        AI_AGENT: "crow",
        ...(options.sessionId ? { CROW_SESSION_ID: options.sessionId } : {}),
      },
    });
    info.pid = child.pid;
    const active: ActiveShell = {
      info,
      child,
      done,
      resolveDone,
      size: 0,
      newlines: 0,
      settled: false,
      timedOut: false,
      onExit: options.onExit,
    };
    this.shells.set(id, active);
    const stream = createWriteStream(file);
    const onData = (chunk: Buffer) => {
      stream.write(chunk);
      active.size += chunk.length;
      for (let index = chunk.indexOf(10); index !== -1; index = chunk.indexOf(10, index + 1)) {
        active.newlines++;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timeout = options.timeout ?? 0;
    if (timeout > 0) {
      active.timeoutTimer = setTimeout(() => this.applyTimeout(id), timeout);
      active.timeoutTimer.unref?.();
    }
    const finalize = async (status: ShellStatus, exit: number | undefined, signal: string | undefined) => {
      if (active.settled) return;
      active.settled = true;
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
      info.status = status;
      info.exit = exit;
      info.signal = signal;
      info.completedAt = Date.now();
      active.lastResult = this.tailResult(active);
      active.resolveDone(info);
      this.exitOrder.push(id);
      while (this.exitOrder.length > EXITED_LIMIT) {
        const oldest = this.exitOrder.shift();
        if (!oldest) break;
        const old = this.shells.get(oldest);
        if (old && old !== active && old.info.status !== "running") {
          this.shells.delete(oldest);
          unlink(old.info.file).catch(() => {});
        }
      }
      if (active.onExit && active.lastResult) {
        try {
          active.onExit({ info, result: active.lastResult });
        } catch {
          /* notification must never break the shell result */
        }
      }
    };
    child.on("close", (code, signal) => {
      if (active.timedOut) {
        void finalize("timeout", undefined, undefined);
      } else if (signal) {
        void finalize("killed", undefined, signal);
      } else {
        void finalize("exited", code ?? undefined, undefined);
      }
    });
    child.on("error", () => {
      void finalize("killed", undefined, undefined);
    });
    return info;
  }

  async wait(id: string): Promise<ShellInfo> {
    const entry = this.shells.get(id);
    if (!entry) throw new Error(`Unknown shell: ${id}`);
    return entry.done;
  }

  get(id: string): ShellInfo | undefined {
    return this.shells.get(id)?.info;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].filter((entry) => entry.info.status === "running").map((entry) => entry.info);
  }

  async result(id: string): Promise<ShellResult> {
    await this.wait(id);
    const entry = this.shells.get(id);
    if (!entry) throw new Error(`Unknown shell: ${id}`);
    return entry.lastResult ?? this.tailResult(entry);
  }

  async output(id: string, cursor = 0, limit = 65_536): Promise<ShellOutputPage> {
    const entry = this.shells.get(id);
    if (!entry) throw new Error(`Unknown shell: ${id}`);
    let data: Buffer;
    try {
      data = await readFile(entry.info.file);
    } catch {
      return { output: "", cursor, size: entry.size, truncated: false };
    }
    const start = Math.max(0, cursor);
    if (start >= data.length) {
      return { output: "", cursor: data.length, size: data.length, truncated: false };
    }
    const end = Math.min(data.length, start + limit);
    return { output: data.subarray(start, end).toString("utf8"), cursor: end, size: data.length, truncated: false };
  }

  stop(id: string): void {
    const entry = this.shells.get(id);
    if (!entry || entry.info.status !== "running") return;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      return;
    }
    entry.forceKillTimer = setTimeout(() => {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, FORCE_KILL_MS);
    entry.forceKillTimer.unref?.();
  }

  async remove(id: string): Promise<void> {
    const entry = this.shells.get(id);
    if (!entry) throw new Error(`Unknown shell: ${id}`);
    if (entry.info.status === "running") {
      this.stop(id);
      await entry.done;
    }
    this.shells.delete(id);
    this.exitOrder = this.exitOrder.filter((item) => item !== id);
    await unlink(entry.info.file).catch(() => {});
  }

  async cleanup(): Promise<void> {
    for (const entry of [...this.shells.values()]) {
      if (entry.info.status === "running") {
        try {
          entry.child.kill("SIGKILL");
        } catch {
          /* already exited */
        }
      }
      await unlink(entry.info.file).catch(() => {});
    }
    this.shells.clear();
    this.exitOrder = [];
  }

  private applyTimeout(id: string): void {
    const entry = this.shells.get(id);
    if (!entry || entry.settled) return;
    entry.timedOut = true;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      return;
    }
    entry.forceKillTimer = setTimeout(() => {
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, FORCE_KILL_MS);
    entry.forceKillTimer.unref?.();
  }

  private tailResult(entry: ActiveShell): ShellResult {
    const info = entry.info;
    let totalLines = entry.newlines;
    let text = "";
    let truncated = false;
    try {
      const data = readFileSync(entry.info.file);
      if (data.length > 0 && data[data.length - 1] !== 10) totalLines += 1;
      const tailStart = Math.max(0, data.length - SHELL_OUTPUT_MAX_BYTES);
      const tail = data.subarray(tailStart).toString("utf8");
      let lines = tail.split("\n");
      if (tail.endsWith("\n")) lines.pop();
      truncated = data.length > SHELL_OUTPUT_MAX_BYTES || lines.length > SHELL_OUTPUT_MAX_LINES;
      if (lines.length > SHELL_OUTPUT_MAX_LINES) lines = lines.slice(-SHELL_OUTPUT_MAX_LINES);
      text = lines.join("\n");
    } catch {
      text = "";
      truncated = false;
      totalLines = 0;
    }
    const shownLines = text ? text.split("\n").length : 0;
    const shownTo = totalLines;
    const shownFrom = text ? totalLines - shownLines + 1 : 0;
    const notice = truncated
      ? `\n\n[showing lines ${shownFrom}-${shownTo} of ${totalLines}; full output saved to ${info.file}]`
      : "";
    return {
      info,
      output: `${text || "(no output)"}${notice}`,
      truncated,
      totalLines,
      shownFrom,
      shownTo,
    };
  }
}
