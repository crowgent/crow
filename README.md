<p align="center">
  <img src="assets/crow.jpeg" alt="Crow" width="100%">
</p>

<p align="center">
  <a href="https://github.com/crowgent/crow/releases"><img src="https://img.shields.io/github/v/release/crowgent/crow" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/crowgent/crow" alt="License"></a>
</p>

<p align="center">
Crow is a lightweight, minimal AI coding agent for the terminal. Connect any
OpenAI-compatible provider, or add your own, and code without the bloat.
</p>

## Features

> - 207 built-in providers, plus custom providers via /connect
> - Live /models fetch keeps model lists current, or enter a model id manually
> - Keys only via /connect into ~/.crow/auth.json (600), never env files
> - Subagents from .md files, /agents panel, direct dispatch, child sessions
> - Shell tool with configured shell, permission checks, file-backed output
> - Durable loop: retries, step cap, output cap, permissions, crash recovery, token budget
> - Todo, fetch, questions, worktrees, snapshots, images, /fork, /transfer, /budget, /session
> - TUI with Thought line, slash panel, code colours for 33 languages
> - Telegram bridge with background mode, /disconnect, headless --prompt mode
> - In-panel updates: update inside the same panel, then Restart now or Later

## Install

Needs only a provider API key, entered through `/connect` in the TUI. Bun is
needed only to build from source; the release binary is standalone.

```sh
curl -fsSL https://www.crowagent.pro/install.sh | bash
```

Or with npm:

```sh
npm install -g @crowgentai/crow
```

On Windows (PowerShell):

```powershell
irm https://www.crowagent.pro/install.ps1 | iex
```

On macOS and Linux the binary goes to a writable directory already on PATH
(for example `/usr/local/bin`), otherwise to `~/.crow/bin` with a PATH entry
added to your shell config. On Windows it goes to `%USERPROFILE%\.crow\bin`.
Restart your terminal, then run `crow`. To reinstall, remove the old binary
(`~/.crow/bin/crow` or `/usr/local/bin/crow`) and run the installer again.
Never delete `~/.crow` — it holds your providers, keys, permissions, and sessions.

## Install from source

```sh
git clone https://github.com/crowgent/crow.git
cd crow
bun install
bun run build
bun dist/index.js
```

## Usage

```sh
crow
```

If no provider is selected, the footer shows "No provider selected". Run
`/connect`, pick a provider, enter its API key, and you are ready. Use
`/model` to change the model for that provider.

```sh
crow --provider deepseek
crow models
crow models --provider cerebras
crow --prompt "Explain this repo in one paragraph"
```

## Providers

207 built-in providers, each with its own base URL. A live `/models` fetch
keeps model lists current, and providers without a static list resolve fully
live. The full list is in the `/connect` picker. Any other OpenAI-compatible
API works through the custom provider wizard. Anthropic is not a direct
provider (its API is not OpenAI-compatible); Claude models are reachable
through OpenRouter.

## Configuration

| Path | What it holds |
| --- | --- |
| `~/.crow/auth.json` | Provider keys, saved only through `/connect` (mode 600) |
| `~/.crow/user-settings.json` | Selected provider and models, custom providers, shell, token budget |
| `~/.crow/permissions.json` | Permission rules (allow/deny/ask per tool) |

`CROW_PROVIDER` overrides the provider id, for example `deepseek`.

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
