import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { findGitRoot } from "./git-root";

export type SkillScope = "project" | "user";

export interface DiscoveredSkill {
  name: string;
  description: string;
  skillMdPath: string;
  rootDir: string;
  scope: SkillScope;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1).replace(/\\(.)/g, (_m, ch: string) => (ch === "n" ? "\n" : ch === "t" ? "\t" : ch));
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** Parse a single-line frontmatter scalar: quoted values keep their content, unquoted values drop a trailing ` # comment`. */
function parseScalar(rest: string): string {
  const t = rest.trim();
  if (t.startsWith('"')) {
    // A quoted value may be followed by a ` # comment`; find its closing quote.
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "\\") {
        i++;
        continue;
      }
      if (t[i] === '"') return stripQuotes(t.slice(0, i + 1));
    }
    return stripQuotes(t);
  }
  if (t.startsWith("'")) {
    for (let i = 1; i < t.length; i++) {
      if (t[i] === "'" && t[i + 1] === "'") {
        i++;
        continue;
      }
      if (t[i] === "'") return stripQuotes(t.slice(0, i + 1));
    }
    return stripQuotes(t);
  }
  return t.replace(/\s+#.*$/, "").trim();
}

/** Minimal YAML frontmatter key extraction for flat `key: value` and optional `|` / `>` blocks after description. */
function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const lines = raw.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameM = line.match(/^name:\s*(.*)$/);
    if (nameM) {
      out.name = parseScalar(nameM[1]);
      continue;
    }
    const descM = line.match(/^description:\s*(.*)$/);
    if (descM) {
      const rest = descM[1].trim();
      if (/^[|>][+-]?$/.test(rest)) {
        const folded = rest.startsWith(">");
        i++;
        const block: { text: string; indent: number; blank: boolean }[] = [];
        while (i < lines.length) {
          const L = lines[i];
          if (L.match(/^[a-zA-Z0-9_-]+:\s/) && !/^\s/.test(L)) break;
          if (/^\s/.test(L) || (block.length > 0 && L === "")) {
            const indent = L.match(/^\s*/)?.[0].length ?? 0;
            block.push({ text: L.replace(/^\s+/, ""), indent, blank: L.trim() === "" });
            i++;
          } else {
            break;
          }
        }
        i--;
        if (folded) {
          // YAML folding: a single newline between plain lines becomes a space;
          // blank lines and more-indented lines keep a newline.
          const baseIndent = block.find((b) => !b.blank)?.indent ?? 0;
          let joined = "";
          block.forEach((b, idx) => {
            if (idx === 0) {
              joined = b.text;
              return;
            }
            const prev = block[idx - 1];
            if (prev.blank || b.blank || b.indent > baseIndent || prev.indent > baseIndent) {
              joined += `\n${b.text}`;
            } else {
              joined += ` ${b.text}`;
            }
          });
          out.description = joined.trim();
        } else {
          out.description = block
            .map((b) => b.text)
            .join("\n")
            .trim();
        }
      } else {
        out.description = parseScalar(rest);
      }
    }
  }
  return out;
}

function extractFrontmatter(fileContent: string): { frontmatter: string; body: string; ok: boolean } {
  const trimmed = fileContent.trimStart();
  if (!trimmed.startsWith("---")) return { frontmatter: "", body: fileContent, ok: false };
  const afterFirst = trimmed.slice(3).split(/\r?\n/);
  const restLines = afterFirst.slice(1);
  const end = restLines.findIndex((l) => l.trim() === "---");
  if (end < 0) return { frontmatter: "", body: fileContent, ok: false };
  return {
    frontmatter: restLines.slice(0, end).join("\n"),
    body: restLines.slice(end + 1).join("\n"),
    ok: true,
  };
}

/** Fallback description for SKILL.md files without usable frontmatter: first body paragraph, else first heading. */
function fallbackDescription(body: string): string {
  let firstHeading = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (!firstHeading) firstHeading = heading[1].trim();
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ") || line.startsWith("```")) continue;
    return line;
  }
  return firstHeading;
}

function loadSkillFromDir(rootDir: string, scope: SkillScope): DiscoveredSkill | null {
  const skillMdPath = path.join(rootDir, "SKILL.md");
  try {
    if (!fs.existsSync(skillMdPath) || !fs.statSync(skillMdPath).isFile()) return null;
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const { frontmatter, body, ok } = extractFrontmatter(content);
    const meta = ok ? parseSkillFrontmatter(frontmatter) : {};
    // A missing name/description used to drop the skill silently. Fall back to
    // the directory name and the body text so a usable SKILL.md still shows up.
    const name = meta.name?.trim() || path.basename(rootDir);
    const description = meta.description?.trim() || fallbackDescription(body);
    if (!name || !description) return null;
    return {
      name,
      description,
      skillMdPath: path.resolve(skillMdPath),
      rootDir: path.resolve(rootDir),
      scope,
    };
  } catch {
    return null;
  }
}

function listSkillDirectories(skillsRoot: string): string[] {
  try {
    if (!fs.existsSync(skillsRoot) || !fs.statSync(skillsRoot).isDirectory()) return [];
    const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      // statSync (not Dirent.isDirectory) so symlinked skill directories count.
      const full = path.join(skillsRoot, e.name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      dirs.push(full);
    }
    return dirs.sort();
  } catch {
    return [];
  }
}

function listProjectSkillRoots(projectRoot: string): string[] {
  const start = path.resolve(projectRoot);
  const gitRoot = findGitRoot(start);
  const roots: string[] = [];
  let current = start;

  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    if (gitRoot ? current === gitRoot : path.dirname(current) === current) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return roots.reverse();
}

/**
 * Discover Agent Skills under ~/.agents/skills and from <projectRoot> upward through
 * parent directories to the git root. The nearest project-level skill overrides
 * user-level and higher-level project skills with the same `name` (frontmatter).
 */
export function discoverSkills(projectRoot: string): DiscoveredSkill[] {
  const userRoot = path.join(os.homedir(), ".agents", "skills");

  const byName = new Map<string, DiscoveredSkill>();

  for (const dir of listSkillDirectories(userRoot)) {
    const s = loadSkillFromDir(dir, "user");
    if (s) byName.set(s.name, s);
  }
  for (const skillsRoot of listProjectSkillRoots(projectRoot)) {
    for (const dir of listSkillDirectories(skillsRoot)) {
      const s = loadSkillFromDir(dir, "project");
      if (s) byName.set(s.name, s);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SKILLS_INSTRUCTIONS = `AGENT SKILLS (optional):
The following <available_skills> list specialized workflows. Use them when they might help the user's request — not only on exact keyword matches.
If a skill's description fits the task or could improve consistency, read that skill's instructions first using read_file with the path from <location>, then follow the SKILL.md body.
Paths inside a skill (scripts/, references/, assets/) are relative to the skill directory (the folder containing SKILL.md); prefer absolute paths in tool calls.`;

/** OpenCode-style XML catalog plus activation instructions for read_file. Returns null if no skills. */
export function formatSkillsForPrompt(skills: DiscoveredSkill[]): string | null {
  if (skills.length === 0) return null;
  const parts = skills.map(
    (s) =>
      `  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.skillMdPath)}</location>\n  </skill>`,
  );
  return `${SKILLS_INSTRUCTIONS}\n\n<available_skills>\n${parts.join("\n")}\n</available_skills>`;
}

/** Plain-text listing for /skills slash command in the TUI. */
export function formatSkillsForChat(skills: DiscoveredSkill[], projectRoot: string): string {
  if (skills.length === 0) {
    return [
      "No Agent Skills found.",
      "",
      `Add skills under ${path.join(projectRoot, ".agents", "skills", "<name>", "SKILL.md")} or ~/.agents/skills/<name>/SKILL.md`,
      "Install manually or use scripts such as skills.sh; see https://agentskills.io",
    ].join("\n");
  }
  const lines = [
    `Agent Skills (${skills.length})`,
    "",
    ...skills.map((s) => `- ${s.name} [${s.scope}]\n  ${s.description.replace(/\n/g, "\n  ")}\n  ${s.skillMdPath}`),
  ];
  return lines.join("\n");
}
