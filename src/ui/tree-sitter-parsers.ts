import type { TreeSitterClient } from "@opentui/core";

interface ExtraParser {
  filetype: string;
  wasm: string;
  highlights: string[];
}

const NVIM_QUERIES = "https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/master/queries";
const GH = "https://github.com";

function nvim(lang: string): string {
  return `${NVIM_QUERIES}/${lang}/highlights.scm`;
}

function release(repo: string, tag: string, asset: string): string {
  return `${GH}/${repo}/releases/download/${tag}/${asset}`;
}

export const EXTRA_PARSERS: ExtraParser[] = [
  {
    filetype: "python",
    wasm: release("tree-sitter/tree-sitter-python", "v0.25.0", "tree-sitter-python.wasm"),
    highlights: ["https://github.com/tree-sitter/tree-sitter-python/raw/refs/heads/master/queries/highlights.scm"],
  },
  {
    filetype: "rust",
    wasm: release("tree-sitter/tree-sitter-rust", "v0.24.2", "tree-sitter-rust.wasm"),
    highlights: [nvim("rust")],
  },
  {
    filetype: "go",
    wasm: release("tree-sitter/tree-sitter-go", "v0.25.0", "tree-sitter-go.wasm"),
    highlights: [nvim("go")],
  },
  {
    filetype: "c",
    wasm: release("tree-sitter/tree-sitter-c", "v0.24.2", "tree-sitter-c.wasm"),
    highlights: [nvim("c")],
  },
  {
    filetype: "cpp",
    wasm: release("tree-sitter/tree-sitter-cpp", "v0.23.4", "tree-sitter-cpp.wasm"),
    highlights: [nvim("c"), nvim("cpp")],
  },
  {
    filetype: "csharp",
    wasm: release("tree-sitter/tree-sitter-c-sharp", "v0.23.5", "tree-sitter-c_sharp.wasm"),
    highlights: [nvim("c_sharp")],
  },
  {
    filetype: "java",
    wasm: release("tree-sitter/tree-sitter-java", "v0.23.5", "tree-sitter-java.wasm"),
    highlights: [nvim("java")],
  },
  {
    filetype: "bash",
    wasm: release("tree-sitter/tree-sitter-bash", "v0.25.1", "tree-sitter-bash.wasm"),
    highlights: [nvim("bash")],
  },
  {
    filetype: "json",
    wasm: release("tree-sitter/tree-sitter-json", "v0.24.8", "tree-sitter-json.wasm"),
    highlights: [nvim("json")],
  },
  {
    filetype: "html",
    wasm: release("tree-sitter/tree-sitter-html", "v0.23.2", "tree-sitter-html.wasm"),
    highlights: ["https://github.com/tree-sitter/tree-sitter-html/raw/refs/heads/master/queries/highlights.scm"],
  },
  {
    filetype: "css",
    wasm: release("tree-sitter/tree-sitter-css", "v0.25.0", "tree-sitter-css.wasm"),
    highlights: [nvim("css")],
  },
  {
    filetype: "yaml",
    wasm: release("tree-sitter-grammars/tree-sitter-yaml", "v0.7.2", "tree-sitter-yaml.wasm"),
    highlights: [nvim("yaml")],
  },
  {
    filetype: "toml",
    wasm: release("tree-sitter-grammars/tree-sitter-toml", "v0.7.0", "tree-sitter-toml.wasm"),
    highlights: [nvim("toml")],
  },
  {
    filetype: "ruby",
    wasm: release("tree-sitter/tree-sitter-ruby", "v0.23.1", "tree-sitter-ruby.wasm"),
    highlights: [nvim("ruby")],
  },
  {
    filetype: "php",
    wasm: release("tree-sitter/tree-sitter-php", "v0.25.1", "tree-sitter-php.wasm"),
    highlights: ["https://github.com/tree-sitter/tree-sitter-php/raw/refs/heads/master/queries/highlights.scm"],
  },
  {
    filetype: "swift",
    wasm: release("alex-pinkus/tree-sitter-swift", "0.7.3", "tree-sitter-swift.wasm"),
    highlights: ["https://github.com/alex-pinkus/tree-sitter-swift/raw/refs/tags/0.7.3/queries/highlights.scm"],
  },
  {
    filetype: "lua",
    wasm: release("tree-sitter-grammars/tree-sitter-lua", "v0.5.0", "tree-sitter-lua.wasm"),
    highlights: [nvim("lua")],
  },
  {
    filetype: "haskell",
    wasm: release("tree-sitter/tree-sitter-haskell", "v0.24.1", "tree-sitter-haskell.wasm"),
    highlights: [nvim("haskell")],
  },
  {
    filetype: "scala",
    wasm: release("tree-sitter/tree-sitter-scala", "v0.26.4", "tree-sitter-scala.wasm"),
    highlights: ["https://github.com/tree-sitter/tree-sitter-scala/raw/refs/heads/master/queries/highlights.scm"],
  },
  {
    filetype: "vue",
    wasm: release("anomalyco/tree-sitter-vue", "v0.1.2", "tree-sitter-vue.wasm"),
    highlights: [
      "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/html_tags/highlights.scm",
      "https://raw.githubusercontent.com/anomalyco/tree-sitter-vue/v0.1.2/queries/vue/highlights.scm",
    ],
  },
  {
    filetype: "hcl",
    wasm: release("tree-sitter-grammars/tree-sitter-hcl", "v1.2.0", "tree-sitter-hcl.wasm"),
    highlights: [nvim("hcl")],
  },
  {
    filetype: "julia",
    wasm: release("tree-sitter/tree-sitter-julia", "v0.23.1", "tree-sitter-julia.wasm"),
    highlights: [nvim("julia")],
  },
  {
    filetype: "ocaml",
    wasm: release("tree-sitter/tree-sitter-ocaml", "v0.24.2", "tree-sitter-ocaml.wasm"),
    highlights: [nvim("ocaml")],
  },
  {
    filetype: "clojure",
    wasm: release("anomalyco/tree-sitter-clojure", "v0.0.1", "tree-sitter-clojure.wasm"),
    highlights: [nvim("clojure")],
  },
  {
    filetype: "nix",
    wasm: "https://github.com/ast-grep/ast-grep.github.io/raw/40b84530640aa83a0d34a20a2b0623d7b8e5ea97/website/public/parsers/tree-sitter-nix.wasm",
    highlights: [nvim("nix")],
  },
  {
    filetype: "diff",
    wasm: release("tree-sitter-grammars/tree-sitter-diff", "v0.1.0", "tree-sitter-diff.wasm"),
    highlights: [
      "https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-diff/2520c3f934b3179bb540d23e0ef45f75304b5fed/queries/highlights.scm",
    ],
  },
  {
    filetype: "elixir",
    wasm: release("elixir-lang/tree-sitter-elixir", "v0.3.5", "tree-sitter-elixir.wasm"),
    highlights: [nvim("elixir")],
  },
  {
    filetype: "fsharp",
    wasm: release("ionide/tree-sitter-fsharp", "0.3.0", "tree-sitter-fsharp.wasm"),
    highlights: [nvim("fsharp")],
  },
  {
    filetype: "r",
    wasm: release("r-lib/tree-sitter-r", "v1.2.0", "tree-sitter-r.wasm"),
    highlights: [nvim("r")],
  },
  {
    filetype: "make",
    wasm: release("tree-sitter-grammars/tree-sitter-make", "v1.1.1", "tree-sitter-make.wasm"),
    highlights: [nvim("make")],
  },
  {
    filetype: "vim",
    wasm: release("tree-sitter-grammars/tree-sitter-vim", "v0.8.1", "tree-sitter-vim.wasm"),
    highlights: [nvim("vim")],
  },
  {
    filetype: "xml",
    wasm: release("tree-sitter-grammars/tree-sitter-xml", "v0.7.0", "tree-sitter-xml.wasm"),
    highlights: [nvim("xml")],
  },
  {
    filetype: "agda",
    wasm: release("tree-sitter/tree-sitter-agda", "v1.3.3", "tree-sitter-agda.wasm"),
    highlights: [nvim("agda")],
  },
];

let registered = false;

export function registerExtraParsers(client: TreeSitterClient): void {
  if (registered) return;
  registered = true;
  for (const parser of EXTRA_PARSERS) {
    try {
      client.addFiletypeParser({
        filetype: parser.filetype,
        wasm: parser.wasm,
        queries: { highlights: parser.highlights },
      });
    } catch {
      // A single bad entry must never break highlighting for the rest.
    }
  }
}

let preloadPromise: Promise<number> | null = null;
let preloadSettled = false;

export function isExtraParsersPreloadSettled(): boolean {
  return preloadSettled;
}

export function preloadExtraParsers(client: TreeSitterClient): Promise<number> {
  if (!preloadPromise) {
    preloadPromise = (async () => {
      registerExtraParsers(client);
      const results = await Promise.allSettled(EXTRA_PARSERS.map((parser) => client.preloadParser(parser.filetype)));
      preloadSettled = true;
      return results.filter((result) => result.status === "fulfilled" && result.value === true).length;
    })();
  }
  return preloadPromise;
}
