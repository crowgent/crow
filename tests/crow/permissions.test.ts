import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatePermission,
  loadPermissionRules,
  matchGlob,
  PermissionStore,
  savePermissionRules,
} from "../../src/crow/permissions";

describe("matchGlob", () => {
  it("matches exact strings and wildcards", () => {
    expect(matchGlob("bash", "bash")).toBe(true);
    expect(matchGlob("bash", "edit_file")).toBe(false);
    expect(matchGlob("*", "anything")).toBe(true);
    expect(matchGlob("*.ts", "src/index.ts")).toBe(true);
    expect(matchGlob("*.ts", "src/index.js")).toBe(false);
    expect(matchGlob("src/*", "src/index.ts")).toBe(true);
    expect(matchGlob("rm -rf *", "rm -rf /tmp/x")).toBe(true);
    expect(matchGlob("rm -rf *", "rm /tmp/x")).toBe(false);
  });
});

describe("evaluatePermission", () => {
  it("defaults shell and bash to allow with no matching rule", () => {
    expect(evaluatePermission([], "bash", "ls")).toBe("allow");
    expect(evaluatePermission([], "shell", "ls")).toBe("allow");
  });

  it("defaults other tools to ask with no matching rule", () => {
    expect(evaluatePermission([], "edit_file", "a.txt")).toBe("ask");
    expect(evaluatePermission([], "write_file", "a.txt")).toBe("ask");
  });

  it("lets an explicit rule override the shell default", () => {
    const rules = [{ action: "shell", resource: "*", effect: "deny" as const }];
    expect(evaluatePermission(rules, "shell", "ls")).toBe("deny");
    expect(evaluatePermission(rules, "bash", "ls")).toBe("allow");
  });

  it("applies the last matching rule", () => {
    const rules = [
      { action: "bash", resource: "*", effect: "allow" as const },
      { action: "bash", resource: "rm *", effect: "deny" as const },
    ];
    expect(evaluatePermission(rules, "bash", "ls")).toBe("allow");
    expect(evaluatePermission(rules, "bash", "rm -rf /")).toBe("deny");
    expect(evaluatePermission(rules, "edit_file", "a.txt")).toBe("ask");
  });

  it("supports wildcard actions", () => {
    const rules = [{ action: "*", resource: "*", effect: "deny" as const }];
    expect(evaluatePermission(rules, "bash", "ls")).toBe("deny");
  });
});

describe("permission file roundtrip", () => {
  it("saves and loads rules, tolerates corrupt files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-perm-"));
    const file = path.join(dir, "permissions.json");
    savePermissionRules([{ action: "bash", resource: "ls", effect: "allow" }], file);
    expect(loadPermissionRules(file)).toEqual([{ action: "bash", resource: "ls", effect: "allow" }]);
    fs.writeFileSync(file, "{not json");
    expect(loadPermissionRules(file)).toEqual([]);
    expect(loadPermissionRules(path.join(dir, "missing.json"))).toEqual([]);
  });

  it("store seeds shell defaults and appends rules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-perm-"));
    const file = path.join(dir, "permissions.json");
    const store = new PermissionStore(file);
    expect(store.evaluate("bash", "ls")).toBe("allow");
    expect(store.evaluate("edit_file", "a.txt")).toBe("ask");
    store.addRule({ action: "bash", resource: "ls", effect: "allow" });
    expect(store.evaluate("bash", "ls")).toBe("allow");
    expect(loadPermissionRules(file)).toEqual([
      { action: "shell", resource: "*", effect: "allow" },
      { action: "bash", resource: "*", effect: "allow" },
      { action: "bash", resource: "ls", effect: "allow" },
    ]);
  });
});
