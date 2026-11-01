import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkills } from "./skills";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(root: string, name: string, description: string): void {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

function writeRawSkill(root: string, name: string, content: string): void {
  const dir = path.join(root, ".agents", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("discoverSkills", () => {
  it("discovers project skills from parent directories up to the git root", () => {
    const repoRoot = makeTempDir("grok-skills-root-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Host browser smoke testing");

    const skills = discoverSkills(nested);
    expect(skills.map((skill) => skill.name)).toContain("agent-browser");
    expect(skills.find((skill) => skill.name === "agent-browser")?.scope).toBe("project");
  });

  it("lets nearer project skills override parent project skills", () => {
    const repoRoot = makeTempDir("grok-skills-override-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const nested = path.join(repoRoot, "tmp", "app");
    fs.mkdirSync(nested, { recursive: true });

    writeSkill(repoRoot, "agent-browser", "Root browser skill");
    writeSkill(path.join(repoRoot, "tmp"), "agent-browser", "Nested browser skill");

    const skills = discoverSkills(nested);
    expect(skills.find((skill) => skill.name === "agent-browser")?.description).toBe("Nested browser skill");
  });

  it("folds > descriptions with spaces, not newlines", () => {
    const repoRoot = makeTempDir("grok-skills-folded-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeRawSkill(
      repoRoot,
      "folded",
      "---\nname: folded\ndescription: >\n  First line\n  second line\n\n  Para two\n---\n\n# folded\n",
    );

    const skills = discoverSkills(repoRoot);
    expect(skills.find((skill) => skill.name === "folded")?.description).toBe("First line second line\n\nPara two");
  });

  it("keeps literal | descriptions on separate lines", () => {
    const repoRoot = makeTempDir("grok-skills-literal-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeRawSkill(
      repoRoot,
      "lit",
      "---\nname: lit\ndescription: |\n  Line one\n  Line two\nallowed-tools: Read\n---\n\n# lit\n",
    );

    const skills = discoverSkills(repoRoot);
    expect(skills.find((skill) => skill.name === "lit")?.description).toBe("Line one\nLine two");
  });

  it("discovers symlinked skill directories", () => {
    const repoRoot = makeTempDir("grok-skills-link-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    const external = makeTempDir("grok-skills-ext-");
    fs.writeFileSync(
      path.join(external, "SKILL.md"),
      "---\nname: extlinked\ndescription: External linked skill\n---\n\n# ext\n",
      "utf8",
    );
    const skillsRoot = path.join(repoRoot, ".agents", "skills");
    fs.mkdirSync(skillsRoot, { recursive: true });
    fs.symlinkSync(external, path.join(skillsRoot, "extlinked"), "dir");

    const skills = discoverSkills(repoRoot);
    expect(skills.find((skill) => skill.name === "extlinked")?.description).toBe("External linked skill");
  });

  it("does not drop SKILL.md files without frontmatter", () => {
    const repoRoot = makeTempDir("grok-skills-nofm-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeRawSkill(repoRoot, "plain-skill", "# Plain Skill\n\nDoes plain stuff.\n");

    const skills = discoverSkills(repoRoot);
    const skill = skills.find((s) => s.name === "plain-skill");
    expect(skill?.description).toBe("Does plain stuff.");
  });

  it("falls back to the directory name when frontmatter has no name", () => {
    const repoRoot = makeTempDir("grok-skills-noname-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeRawSkill(repoRoot, "dir-named", "---\ndescription: Only a description\n---\n\n# body\n");

    const skills = discoverSkills(repoRoot);
    expect(skills.find((s) => s.name === "dir-named")?.description).toBe("Only a description");
  });

  it("unescapes quoted values and strips unquoted inline comments", () => {
    const repoRoot = makeTempDir("grok-skills-quotes-");
    fs.mkdirSync(path.join(repoRoot, ".git"));
    writeRawSkill(
      repoRoot,
      "quoted",
      '---\nname: quoted\ndescription: "A \\"quoted\\" thing" # trailing\n---\n\n# q\n',
    );
    writeRawSkill(
      repoRoot,
      "commented",
      "---\nname: commented # the name\ndescription: Plain desc # trailing comment\n---\n\n# c\n",
    );

    const skills = discoverSkills(repoRoot);
    expect(skills.find((s) => s.name === "quoted")?.description).toBe('A "quoted" thing');
    expect(skills.find((s) => s.name === "commented")?.description).toBe("Plain desc");
  });
});
