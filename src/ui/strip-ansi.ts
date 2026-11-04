const ANSI_PATTERN = new RegExp(
  [
    "\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
    "\\x1b\\[[0-9;?]*[ -/]*[@-~]",
    "\\x1b\\[[0-9;?]*[ -/]*$",
    "\\x1b\\][^\\x07\\x1b]*$",
    "\\x1b[\\x30-\\x7e]",
    "\\x1b",
  ].join("|"),
  "g",
);

export function stripAnsiForDisplay(content: string): string {
  return content.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
}
