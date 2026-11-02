import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type PermissionEffect = "allow" | "deny" | "ask";
export type PermissionDecision = "allow" | "deny";

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

export interface PermissionRequest {
  action: string;
  resource: string;
  toolName: string;
}

export type PermissionResolver = (request: PermissionRequest) => Promise<PermissionDecision>;

export function matchGlob(pattern: string, value: string): boolean {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[+^${}()|[\]\\.]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  re += "$";
  return new RegExp(re).test(value);
}

export const DEFAULT_ALLOW_ACTIONS: ReadonlySet<string> = new Set(["shell", "bash"]);

export const DEFAULT_ALLOW_RULES: PermissionRule[] = [
  { action: "shell", resource: "*", effect: "allow" },
  { action: "bash", resource: "*", effect: "allow" },
];

export function evaluatePermission(rules: PermissionRule[], action: string, resource: string): PermissionEffect {
  let effect: PermissionEffect | null = null;
  for (const rule of rules) {
    if (rule.action !== "*" && rule.action !== action) continue;
    if (!matchGlob(rule.resource, resource)) continue;
    effect = rule.effect;
  }
  if (effect !== null) return effect;
  return DEFAULT_ALLOW_ACTIONS.has(action) ? "allow" : "ask";
}

export function defaultPermissionsPath(): string {
  return path.join(os.homedir(), ".crow", "permissions.json");
}

export function loadPermissionRules(filePath: string = defaultPermissionsPath()): PermissionRule[] {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return [];
    const rules = (parsed as { rules?: unknown }).rules;
    if (!Array.isArray(rules)) return [];
    return rules.filter(
      (rule): rule is PermissionRule =>
        !!rule &&
        typeof rule === "object" &&
        typeof (rule as PermissionRule).action === "string" &&
        typeof (rule as PermissionRule).resource === "string" &&
        ((rule as PermissionRule).effect === "allow" ||
          (rule as PermissionRule).effect === "deny" ||
          (rule as PermissionRule).effect === "ask"),
    );
  } catch {
    return [];
  }
}

export function savePermissionRules(rules: PermissionRule[], filePath: string = defaultPermissionsPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ rules }, null, 2));
}

export class PermissionStore {
  private rules: PermissionRule[];

  constructor(private filePath: string = defaultPermissionsPath()) {
    this.rules = loadPermissionRules(filePath);
    if (!fs.existsSync(filePath)) {
      try {
        this.rules = [...DEFAULT_ALLOW_RULES];
        savePermissionRules(this.rules, filePath);
      } catch {
        this.rules = loadPermissionRules(filePath);
      }
    }
  }

  evaluate(action: string, resource: string): PermissionEffect {
    return evaluatePermission(this.rules, action, resource);
  }

  addRule(rule: PermissionRule): void {
    this.rules = [...this.rules, rule];
    savePermissionRules(this.rules, this.filePath);
  }

  getRules(): PermissionRule[] {
    return [...this.rules];
  }
}
