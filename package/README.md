# Crow

Crow is a lightweight, minimal AI coding agent for the terminal. Connect any
OpenAI-compatible provider, or add your own, and code without the bloat.

## Install

```sh
npm install -g @crowgentai/crow
```

This installs the `crow` command with the binary for your platform
(Linux x64, macOS arm64, or Windows x64).

## Usage

```sh
crow
```

The TUI opens directly, without asking for an API key first. Run `/connect`,
pick a provider, enter its API key, and you are ready. Use `/model` to change
the model for that provider.

Run one prompt without opening the TUI:

```sh
crow --prompt "Explain this repo in one paragraph"
```

See the [repository](https://github.com/crowgent/crow) for full documentation.

## Publishing

Binaries are build artifacts and are not committed. To publish a new version,
build the three platform binaries from the repository root, then publish the
platform packages first and the wrapper last:

```sh
cd package/crow-linux-x64 && npm publish --access public && cd ../..
cd package/crow-darwin-arm64 && npm publish --access public && cd ../..
cd package/crow-windows-x64 && npm publish --access public && cd ../..
cd package && npm publish --access public
```

Publishing needs `NPM_TOKEN` in the environment; the `.npmrc` in this folder
only references that variable and holds no secret.

## License

MIT.
