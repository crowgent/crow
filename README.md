# Crow

```
 ██████╗██████╗  ██████╗ ██╗    ██╗
██╔════╝██╔══██╗██╔═══██╗██║    ██║
██║     ██████╔╝██║   ██║██║ █╗ ██║
██║     ██╔══██╗██║   ██║██║███╗██║
╚██████╗██║  ██║╚██████╔╝╚███╔███╔╝
 ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝
```

Crow is an open-source AI coding agent for the terminal, built with Bun and OpenTUI.

The terminal UI is plain and static on purpose: no animations, no spinners, no flashing
indicators. The home screen shows a large Crow logo, and pending work is shown with a
static marker instead of a moving spinner.

## Features

- 30 built-in OpenAI-compatible providers, plus your own custom provider
- Provider picker in the TUI: `/connect` (alias `/login`) asks for the provider's API key and saves it
- `/models` lists only the models of the provider you selected in `/connect`. If no provider
  is selected, it tells you so instead of guessing
- Custom provider wizard: provider id, display name, base URL, API key, first model id,
  first model name, with a live `/models` fetch after the key step and a manual fallback
- Skills, MCP servers, sub-agents, scheduled runs, sandbox modes, and session recaps
- Headless mode for scripts: `crow --prompt "..."`

## Requirements

- [Bun](https://bun.sh) (the working runtime for this repo)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash
```

This installs the latest release binary. When a directory already on PATH is
writable (for example `/usr/local/bin`), the binary goes there so `crow`
works immediately in the current shell with no manual export. An install that
already lives in `~/.crow/bin` moves there on re-run (the old binary and its
PATH line are cleaned up). Otherwise the binary goes to `~/.crow/bin` and the
installer adds that directory to your shell config.

## Install from source

```sh
git clone https://github.com/crowgent/crow.git
cd crow
bun install
bun run build
bun dist/index.js
```

For development, run it directly without building:

```sh
bun run src/index.ts
```

## Usage

Open the TUI:

```sh
crow
```

The TUI opens directly, without asking for an API key first. If no provider is selected,
the footer shows "No provider selected". Run `/connect`, pick a provider, enter its API
key, and you are ready. Use `/models` to change the model for that provider.

Start with a specific provider:

```sh
crow --provider deepseek
```

List models:

```sh
crow models
crow models --provider cerebras
```

Run one prompt without opening the TUI:

```sh
crow --prompt "Explain this repo in one paragraph"
```

## Providers

Built-in providers, each with its own base URL, key environment variable, and static
model list (live `/models` fetch corrects the list when a provider is connected):

| Provider | Provider |
| --- | --- |
| openai | gemini |
| deepseek | qwen |
| moonshot | zhipu |
| groq | together |
| openrouter | mistral |
| minimax | stepfun |
| cerebras | fireworks |
| deepinfra | nebius |
| sambanova | perplexity |
| cohere | venice |
| alibaba | moonshot-cn |
| zai | minimax-cn |
| stepfun-ai | opencode |
| opencode-go | nvidia |
| baseten | digitalocean |

Any other OpenAI-compatible API works through the custom provider wizard in `/connect`.
Anthropic is not a direct provider (its API is not OpenAI-compatible); Claude models are
reachable through OpenRouter.

## Configuration

Keys and the selected provider are saved to `~/.crow/user-settings.json`.
Environment variables:

| Variable | Purpose |
| --- | --- |
| `CROW_PROVIDER` | Provider id to use, for example `deepseek` |
| `CROW_MODEL` | Model id override |
| `CROW_MAX_TOKENS` | Max tokens override |

See `.env.example` for the per-provider key variables.

## TUI commands

| Command | What it does |
| --- | --- |
| `/connect` (`/login`) | Choose a provider and enter its API key |
| `/models` | Select a model for the selected provider |
| `/help` | Show available commands |
| `/skills` | Manage skills |
| `/mcp` | Manage MCP servers |
| `/agents` | Manage custom sub-agents |
| `/schedule` | View scheduled runs |
| `/sandbox` | Select shell sandbox mode |
| `/btw` | Ask a side question without interrupting |
| `/new` | Start a new session |
| `/exit` | Quit the CLI |

## Development

```sh
bun run typecheck
bunx vitest run
bun run build
bun run lint
```

## License

MIT. See [LICENSE](LICENSE).
