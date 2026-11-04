import { getTreeSitterClient, RGBA, SyntaxStyle, type TreeSitterClient } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "./theme";
import { isExtraParsersPreloadSettled, preloadExtraParsers } from "./tree-sitter-parsers";

const CODE_LANG_ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  py3: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  "c++": "cpp",
  h: "c",
  cs: "csharp",
  "c#": "csharp",
  rb: "ruby",
  yml: "yaml",
  hs: "haskell",
  udiff: "diff",
  patch: "diff",
  makefile: "make",
};

function normalizeCodeFenceLanguages(content: string): string {
  return content.replace(/^```([A-Za-z0-9_+-]+)\s*$/gm, (match, lang) => {
    const mapped = CODE_LANG_ALIASES[lang.toLowerCase()];
    return mapped ? `\`\`\`${mapped}` : match;
  });
}

let sharedClient: TreeSitterClient | null = null;
let sharedInit: Promise<TreeSitterClient | null> | null = null;

function loadTreeSitter(): Promise<TreeSitterClient | null> {
  if (sharedClient) return Promise.resolve(sharedClient);
  if (!sharedInit) {
    sharedInit = (async () => {
      try {
        const client = getTreeSitterClient();
        await client.initialize();
        sharedClient = client;
        return client;
      } catch {
        return null;
      }
    })();
  }
  return sharedInit;
}

function buildSyntaxStyle(t: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(t.text) },
    "markup.heading": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.heading.1": { fg: RGBA.fromHex(t.mdHeading), bold: true, underline: true },
    "markup.heading.2": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.heading.3": { fg: RGBA.fromHex(t.mdHeading), bold: true },
    "markup.bold": { fg: RGBA.fromHex(t.mdBold), bold: true },
    "markup.strong": { fg: RGBA.fromHex(t.mdBold), bold: true },
    "markup.italic": { fg: RGBA.fromHex(t.mdItalic), italic: true },
    "markup.strikethrough": { fg: RGBA.fromHex(t.textMuted), dim: true },
    "markup.raw": { fg: RGBA.fromHex(t.mdCode) },
    "markup.raw.block": { fg: RGBA.fromHex(t.mdCodeBlockFg), bg: RGBA.fromHex(t.mdCodeBlockBg) },
    "markup.link": { fg: RGBA.fromHex(t.mdLink), underline: true },
    "markup.link.label": { fg: RGBA.fromHex(t.mdLinkText) },
    "markup.link.url": { fg: RGBA.fromHex(t.mdLink) },
    "markup.list": { fg: RGBA.fromHex(t.mdListBullet) },
    "markup.quote": { fg: RGBA.fromHex(t.mdItalic), italic: true },
    "markup.separator": { fg: RGBA.fromHex(t.mdHr) },
    code: { fg: RGBA.fromHex(t.mdCodeBlockFg), bg: RGBA.fromHex(t.mdCodeBlockBg) },
    keyword: { fg: RGBA.fromHex(t.codeKeyword) },
    string: { fg: RGBA.fromHex(t.codeString) },
    comment: { fg: RGBA.fromHex(t.codeComment), italic: true },
    number: { fg: RGBA.fromHex(t.codeNumber) },
    function: { fg: RGBA.fromHex(t.codeFunction) },
    type: { fg: RGBA.fromHex(t.codeType) },
    variable: { fg: RGBA.fromHex(t.text) },
    operator: { fg: RGBA.fromHex(t.codeOperator) },
    property: { fg: RGBA.fromHex(t.codeProperty) },
    punctuation: { fg: RGBA.fromHex(t.codePunctuation) },
    "punctuation.delimiter": { fg: RGBA.fromHex(t.codePunctuation) },
    "punctuation.bracket": { fg: RGBA.fromHex(t.codePunctuation) },
    "punctuation.special": { fg: RGBA.fromHex(t.codePunctuation) },
    constant: { fg: RGBA.fromHex(t.codeNumber) },
    constructor: { fg: RGBA.fromHex(t.codeFunction) },
    tag: { fg: RGBA.fromHex(t.codeKeyword) },
    attribute: { fg: RGBA.fromHex(t.codeProperty) },
  });
}

const TABLE_OPTIONS = {
  widthMode: "full" as const,
  columnFitter: "balanced" as const,
  wrapMode: "word" as const,
  cellPadding: 1,
  borders: true,
  outerBorder: true,
  borderStyle: "rounded" as const,
  borderColor: "#333333",
};

export function Markdown({ content, t, streaming }: { content: string; t: Theme; streaming?: boolean }) {
  const syntaxStyle = useMemo(() => buildSyntaxStyle(t), [t]);
  const normalizedContent = useMemo(() => normalizeCodeFenceLanguages(content), [content]);
  const [tsClient, setTsClient] = useState<TreeSitterClient | null>(() => sharedClient);
  const [parserGen, setParserGen] = useState(0);
  const preloadDoneAtMount = useRef(isExtraParsersPreloadSettled()).current;

  useEffect(() => {
    let live = true;
    if (!tsClient) {
      loadTreeSitter().then((client) => {
        if (live) setTsClient(client);
      });
    } else if (!preloadDoneAtMount) {
      preloadExtraParsers(tsClient).then((count) => {
        if (live && count > 0) setParserGen((gen) => gen + 1);
      });
    }
    return () => {
      live = false;
    };
  }, [tsClient, preloadDoneAtMount]);

  return (
    <markdown
      key={tsClient ? `ts-${parserGen}` : "plain"}
      content={normalizedContent}
      syntaxStyle={syntaxStyle}
      conceal={true}
      treeSitterClient={tsClient ?? undefined}
      streaming={streaming ?? false}
      // @ts-expect-error MarkdownProps omits inherited Renderable.selectable; needed for TUI text selection
      selectable={true}
      tableOptions={TABLE_OPTIONS}
      flexShrink={0}
    />
  );
}
