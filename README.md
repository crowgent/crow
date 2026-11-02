<p align="center">
  <img src="assets/crow.jpeg" alt="Crow" width="100%">
</p>

<p align="center">
  <a href="https://github.com/crowgent/crow/releases"><img src="https://img.shields.io/github/v/release/crowgent/crow" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/crowgent/crow" alt="License"></a>
  <a href="https://github.com/crowgent/crow/releases"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey" alt="Platform"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-black" alt="Bun"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/language-TypeScript-blue" alt="TypeScript"></a>
</p>

# Crow

Crow is a lightweight, minimal AI coding agent for the terminal. Connect any
OpenAI-compatible provider, or add your own, and code without the bloat.

## Features

- **207 built-in OpenAI-compatible providers**, plus a native xai provider with
  grok models, plus your own custom provider through the `/connect` wizard
- **Custom provider models, all of them**: `/connect` offers two choices —
  fetch every model from the base URL (all of them are saved, you pick the
  default) or enter one model id manually. `/model` shows every model for the
  provider, not just the one you entered
- **Keys saved one way only**: through `/connect` into `~/.crow/auth.json`
  (mode 600). Nothing is written to env files
- **Subagents**: one `.md` file per agent, a `/agents` panel, `/agents assign`
  for direct dispatch, and `/<name>` to call an agent by name. Foreground runs
  persist as child sessions; background runs are detached and keep working
  after the TUI closes
- **Shell tool**: runs in the configured shell (`shell` in settings, then
  `$SHELL`, then bash, then sh; PowerShell arguments for pwsh), verifies
  permissions before spawning, captures output to a file and returns a bounded
  tail, notifies when background commands finish, and stops the shell when the
  turn is aborted. The legacy `bash` tool is kept for persistent-cwd work and
  background process management
- **Durable agent loop**: retries with backoff, a graceful step cap, a tool
  output cap with full output saved to files, a permission system
  (allow/deny/ask, with shell and bash allowed by default), crash recovery
  that marks interrupted turns, a durable inbox, and a per-session token budget
- **Working tools**: todo lists, URL fetching, multiple-choice questions,
  git worktrees, snapshots, image generation, session forking (`/fork`),
  session transfer (`/transfer`), and budget control (`/budget`)
- **TUI**: title-only header, a Thought line with reasoning, a single-row dot
  spinner while processing, and wrapping list navigation
- **Telegram headless bridge**: run the agent from Telegram with rich message
  drafts, plus headless `--prompt` mode for scripts

## Requirements

- [Bun](https://bun.sh) (the working runtime for this repo)
- A provider API key, entered through `/connect` in the TUI

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash
```

This installs the latest release binary. When a directory already on PATH is
writable (for example `/usr/local/bin`), the binary goes there so `crow`
works immediately in the current shell with no manual export. Otherwise the
binary goes to `~/.crow/bin` and the installer adds that directory to your
shell config.

To reinstall, remove the old binaries and run the installer again. Never
delete `~/.crow` — it holds your providers, keys, permissions, and sessions.
After reinstalling, check the footer version in the TUI.

```sh
rm -f /root/.crow/bin/crow /usr/local/bin/crow
curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash
```

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

The TUI opens directly, without asking for an API key first. If no provider is
selected, the footer shows "No provider selected". Run `/connect`, pick a
provider, enter its API key, and you are ready. Use `/model` to change the
model for that provider.

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

207 built-in providers, each with its own base URL and static model list; a
live `/models` fetch corrects the list when a provider is connected. The full
list is in the `/connect` picker. Any other OpenAI-compatible API works
through the custom provider wizard. Anthropic is not a direct provider (its
API is not OpenAI-compatible); Claude models are reachable through OpenRouter.

## Configuration

| Path | What it holds |
| --- | --- |
| `~/.crow/auth.json` | Provider keys, saved only through `/connect` (mode 600) |
| `~/.crow/user-settings.json` | Selected provider and models, custom providers, shell, token budget |
| `~/.crow/permissions.json` | Permission rules (allow/deny/ask per tool) |

Environment variables:

| Variable | Purpose |
| --- | --- |
| `CROW_PROVIDER` | Provider id to use, for example `deepseek` |

## TUI commands

| Command | What it does |
| --- | --- |
| `/connect` (`/login`) | Choose a provider and enter its API key |
| `/model` (`/models`) | Select a model for the selected provider |
| `/agents` | Manage custom sub-agents (`/agents assign <name> <task>`) |
| `/fork` | Fork the current session |
| `/transfer <path>` | Move the session to another directory |
| `/budget` | Show or set the session token budget |
| `/schedule` | View scheduled runs |
| `/sandbox` | Select shell sandbox mode |
| `/mcp` | Manage MCP servers |
| `/remote-control` | Start the Telegram bridge |
| `/recap` | Refresh the session recap |
| `/clear` | Clear the session |
| `/exit` (`/quit`) | Quit the CLI |

## Development

```sh
bun install
bun run typecheck
bun run test
bun run build
bun run lint
```

## License

MIT. See [LICENSE](LICENSE).
