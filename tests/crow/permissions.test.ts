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
  it("defaults to ask with no matching rule", () => {
    expect(evaluatePermission([], "bash", "ls")).toBe("ask");
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

  it("store appends rules and persists them", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crow-perm-"));
    const file = path.join(dir, "permissions.json");
    const store = new PermissionStore(file);
    expect(store.evaluate("bash", "ls")).toBe("ask");
    store.addRule({ action: "bash", resource: "ls", effect: "allow" });
    expect(store.evaluate("bash", "ls")).toBe("allow");
    expect(loadPermissionRules(file)).toEqual([{ action: "bash", resource: "ls", effect: "allow" }]);
  });
});
