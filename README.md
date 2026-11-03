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


<p align="center">
Crow is a lightweight, minimal AI coding agent for the terminal. Connect any
OpenAI-compatible provider, or add your own, and code without the bloat.
</p>

## Features

> - 207 built-in providers, native xai, and custom providers via /connect
> - All custom models fetched and saved, or one entered manually; /model shows them all
> - Keys only via /connect into ~/.crow/auth.json (600), never env files
> - Subagents from .md files, /agents panel, direct dispatch, child sessions
> - Shell tool with configured shell, permission checks, file-backed output
> - Durable loop: retries, step cap, output cap, permissions, crash recovery, token budget
> - Todo, fetch, questions, worktrees, snapshots, images, /fork, /transfer, /budget
> - TUI with Thought line, single-row spinner, wrapping navigation
> - Telegram bridge with rich drafts, plus headless --prompt mode

## Requirements

- [Bun](https://bun.sh) (the working runtime for this repo)
- A provider API key, entered through `/connect` in the TUI

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/crowgent/crow/main/install.sh | bash
```

On Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/crowgent/crow/main/install.ps1 | iex
```

This installs the latest release binary to `%USERPROFILE%\.crow\bin` and adds it to your user PATH. Restart your terminal, then run `crow`. To reinstall, run the same command again.

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
