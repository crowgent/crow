export interface SlashMenuItem {
  id: string;
  label: string;
  description: string;
  aliases?: string[];
}

export const SLASH_MENU_ITEMS: SlashMenuItem[] = [
  { id: "exit", label: "exit", description: "Quit the CLI", aliases: ["quit", "q"] },
  { id: "remote-control", label: "remote-control", description: "Remote control" },
  { id: "disconnect", label: "disconnect", description: "Disconnect Telegram bridge" },
  { id: "agents", label: "agents", description: "Manage custom sub-agents" },
  { id: "schedule", label: "schedule", description: "View scheduled runs" },
  { id: "mcp", label: "mcp", description: "Manage MCP servers" },
  { id: "sandbox", label: "sandbox", description: "Select shell sandbox mode" },
  { id: "connect", label: "connect", description: "Choose a provider and enter its API key", aliases: ["login"] },
  { id: "env", label: "env", description: "View and update stored provider keys" },
  {
    id: "models",
    label: "models",
    description: "Select a model for the selected provider",
    aliases: ["model", "mode"],
  },
  {
    id: "effort",
    label: "effort",
    description: "Set the thinking effort for the current model",
    aliases: ["thinking"],
  },
  { id: "recaps", label: "recaps", description: "Turn session recaps on/off", aliases: ["recap", "summary"] },
  { id: "new", label: "new session", description: "Start a new session" },
  { id: "session", label: "session", description: "Switch to an old session" },
  { id: "commit-push", label: "commit & push", description: "Commit and push" },
  { id: "commit-pr", label: "commit & pr", description: "Commit and open PR" },
  { id: "review", label: "review", description: "Review recent changes" },
  { id: "verify", label: "verify", description: "Run local verification" },
  { id: "skills", label: "skills", description: "Manage skills" },
  { id: "btw", label: "btw", description: "Ask a side question without interrupting" },
  { id: "update", label: "update", description: "Update crow to the latest version" },
  { id: "clear", label: "clear", description: "Clear the conversation" },
  { id: "fork", label: "fork", description: "Fork the current session" },
  { id: "transfer", label: "transfer", description: "Move the session to another directory" },
  { id: "budget", label: "budget", description: "Set the session token budget" },
];

export function filterSlashMenuItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  const normalized = normalizeSlashSearchQuery(query);
  if (!normalized) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreSlashMenuItem(item, normalized) }))
    .filter((entry) => entry.score !== Number.POSITIVE_INFINITY)
    .sort(
      (a, b) =>
        a.score - b.score ||
        (isExactSlashCommand(a.item, normalized) ? 0 : 1) - (isExactSlashCommand(b.item, normalized) ? 0 : 1) ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
}

function isExactSlashCommand(item: SlashMenuItem, query: string): boolean {
  return item.id.toLowerCase() === query || item.label.toLowerCase() === query;
}

function normalizeSlashSearchQuery(query: string): string {
  return query.trim().replace(/^\/+/, "").toLowerCase();
}

function scoreSlashMenuItem(item: SlashMenuItem, query: string): number {
  const nameFields = [item.id, item.label].flatMap(tokenizeSearchText);
  const aliasFields = (item.aliases ?? []).flatMap(tokenizeSearchText);
  const descriptionFields = tokenizeSearchText(item.description);

  const nameScore = scoreFields(nameFields, query, 0);
  const aliasScore = scoreFields(aliasFields, query, 1);
  const descriptionScore = scoreFields(descriptionFields, query, 3);
  return Math.min(nameScore, aliasScore, descriptionScore);
}

function scoreFields(fields: string[], query: string, offset: number): number {
  for (const field of fields) {
    if (field === query || `/${field}` === query) return offset;
  }
  for (const field of fields) {
    if (field.startsWith(query) || `/${field}`.startsWith(query)) return offset + 1;
  }
  for (const field of fields) {
    if (field.includes(query) || `/${field}`.includes(query)) return offset + 2;
  }
  return Number.POSITIVE_INFINITY;
}

function tokenizeSearchText(value: string): string[] {
  const normalized = value.toLowerCase();
  const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return [normalized, ...tokens];
}
