import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SNAPSHOT_ROOT = path.join(os.homedir(), ".crow", "snapshots");
const IGNORED = new Set([".git", "node_modules", ".DS_Store"]);

export interface SnapshotMeta {
  id: string;
  name: string;
  sourceCwd: string;
  createdAt: string;
}

function snapshotDir(id: string): string {
  return path.join(SNAPSHOT_ROOT, id);
}

function isIgnored(src: string, root: string): boolean {
  const relative = path.relative(root, src);
  if (!relative) return false;
  return relative.split(path.sep).some((part) => IGNORED.has(part));
}

export async function createSnapshot(cwd: string, name?: string): Promise<SnapshotMeta> {
  const id = randomUUID().replace(/-/g, "").slice(0, 12);
  const meta: SnapshotMeta = {
    id,
    name: name?.trim() || id,
    sourceCwd: cwd,
    createdAt: new Date().toISOString(),
  };
  const dir = snapshotDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(cwd, dir, {
    recursive: true,
    filter: (src) => src !== SNAPSHOT_ROOT && !src.startsWith(`${SNAPSHOT_ROOT}${path.sep}`) && !isIgnored(src, cwd),
  });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
  return meta;
}

export async function listSnapshots(): Promise<SnapshotMeta[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(SNAPSHOT_ROOT);
  } catch {
    return [];
  }
  const snapshots: SnapshotMeta[] = [];
  for (const entry of entries) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(SNAPSHOT_ROOT, entry, "meta.json"), "utf8")) as SnapshotMeta;
      snapshots.push(meta);
    } catch {}
  }
  snapshots.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return snapshots;
}

export async function revertSnapshot(id: string): Promise<{ success: boolean; output: string }> {
  const dir = snapshotDir(id);
  let meta: SnapshotMeta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(dir, "meta.json"), "utf8")) as SnapshotMeta;
  } catch {
    return { success: false, output: `Snapshot "${id}" was not found.` };
  }
  await fs.cp(dir, meta.sourceCwd, {
    recursive: true,
    filter: (src) => path.basename(src) !== "meta.json" && !isIgnored(src, dir),
  });
  return {
    success: true,
    output: `Snapshot "${meta.name}" restored over ${meta.sourceCwd}. Files created after the snapshot were left untouched.`,
  };
}
