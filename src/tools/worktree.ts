import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  bare: boolean;
}

async function runGit(cwd: string, args: string[]): Promise<{ success: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, timeout: 30_000 });
    const output = (stdout || stderr || "").trim();
    return { success: true, output: output || "Done." };
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? ((error as { stderr?: unknown }).stderr as string | undefined) || error.message
        : String(error);
    return { success: false, output: message.trim() || "Git command failed." };
  }
}

export async function listWorktrees(cwd: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  if (!result.success) return result;
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of result.output.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null, bare: false };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare" && current) {
      current.bare = true;
    }
  }
  if (entries.length === 0) return { success: true, output: "No worktrees." };
  return {
    success: true,
    output: entries
      .map((entry) => `${entry.path}${entry.branch ? ` (${entry.branch})` : ""}${entry.bare ? " [bare]" : ""}`)
      .join("\n"),
  };
}

export async function createWorktree(
  cwd: string,
  path: string,
  branch?: string,
): Promise<{ success: boolean; output: string }> {
  const args = ["worktree", "add", path];
  if (branch) args.push("-b", branch);
  const result = await runGit(cwd, args);
  if (!result.success) return result;
  return { success: true, output: `Worktree created at ${path}${branch ? ` on branch ${branch}` : ""}.` };
}

export async function removeWorktree(cwd: string, path: string): Promise<{ success: boolean; output: string }> {
  const result = await runGit(cwd, ["worktree", "remove", "--force", path]);
  if (!result.success) return result;
  return { success: true, output: `Worktree removed: ${path}.` };
}
