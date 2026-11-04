#!/usr/bin/env bun
import type { ModelMessage } from "ai";
import { spawn } from "child_process";
import { InvalidArgumentError, program } from "commander";
import readline from "readline";
import packageJson from "../package.json";
import { Agent } from "./agent/agent";
import { completeDelegation, failDelegation, loadDelegation } from "./agent/delegations";
import { normalizeModelId } from "./crow/models";
import {
  createHeadlessJsonlEmitter,
  type HeadlessOutputFormat,
  isHeadlessOutputFormat,
  renderHeadlessChunk,
  renderHeadlessPrelude,
} from "./headless/output";
import { appendMessages, loadTranscript, SessionStore } from "./storage/index";
import { runTelegramHeadlessBridge } from "./telegram/headless-bridge";
import { startScheduleDaemon } from "./tools/schedule";
import { processAtMentions } from "./utils/at-mentions.js";
import { runScriptManagedUninstall } from "./utils/install-manager";
import { findProvider, getAllProviders } from "./utils/providers";
import {
  getCurrentModel,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  getSelectedProvider,
  getSelectedProviderId,
  loadCustomProviders,
  mergeSandboxSettings,
  type SandboxMode,
  type SandboxSettings,
  saveProviderApiKey,
  saveUserSettings,
  selectProvider,
} from "./utils/settings";
import { runUpdate } from "./utils/update-checker";
import {
  getWorkspaceTrustDecision,
  isShuruSandboxSupported,
  resolveWorkspaceTrustPromptAnswer,
  saveWorkspaceTrustDecision,
} from "./utils/workspace-trust";
import { buildVerifyPrompt, getVerifyCliError } from "./verify/entrypoint";

const exitCleanlyOnSigterm = () => {
  process.exit(0);
};

process.on("SIGTERM", exitCleanlyOnSigterm);

process.on("uncaughtException", (err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

async function startInteractive(
  apiKey: string | undefined,
  baseURL: string,
  model: string | undefined,
  providerId: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  session?: string,
  initialMessage?: string,
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
    batchApi,
    providerId,
  });
  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { createElement } = await import("react");
  const { App } = await import("./ui/app");

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    // Lets terminals (Kitty, iTerm2, WezTerm, …) report Command as `super` on KeyEvent — needed for ⌘C in the TUI.
    useKittyKeyboard: {
      disambiguate: true,
      alternateKeys: true,
    },
  });

  const onExit = () => {
    void agent.cleanup().finally(() => {
      renderer.destroy();
      process.exit(0);
    });
  };

  const onRestart = (binaryPath: string, args: string[]) => {
    void agent.cleanup().finally(() => {
      renderer.destroy();
      const launch = () => {
        const child = spawn(binaryPath, args, { stdio: "inherit" });
        child.on("error", (err) => {
          console.error(`Failed to restart: ${err.message}`);
          process.exit(1);
        });
        child.on("exit", (code, signal) => {
          process.exit(signal ? 1 : (code ?? 0));
        });
      };
      if (process.platform === "win32") setTimeout(launch, 3000);
      else launch();
    });
  };

  createRoot(renderer).render(
    createElement(App, {
      agent,
      startupConfig: {
        apiKey,
        baseURL,
        model: agent.getModel(),
        maxToolRounds,
        sandboxMode,
        sandboxSettings,
        version: packageJson.version,
      },
      initialMessage,
      onExit,
      onRestart,
    }),
  );
}

async function runHeadless(
  prompt: string,
  apiKey: string,
  baseURL: string,
  model: string | undefined,
  maxToolRounds: number,
  batchApi: boolean,
  sandboxMode: SandboxMode,
  sandboxSettings: SandboxSettings,
  format: HeadlessOutputFormat,
  session?: string,
) {
  const agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
    session,
    sandboxMode,
    sandboxSettings,
    batchApi,
  });
  const prelude = renderHeadlessPrelude(format, agent.getSessionId() || undefined);
  if (prelude.stdout) process.stdout.write(prelude.stdout);
  if (prelude.stderr) process.stderr.write(prelude.stderr);

  try {
    const { enhancedMessage } = processAtMentions(prompt, process.cwd());

    if (format === "json") {
      const { observer, consumeChunk, flush } = createHeadlessJsonlEmitter(agent.getSessionId() || undefined);
      for await (const chunk of agent.processMessage(enhancedMessage, observer)) {
        const writes = consumeChunk(chunk);
        if (writes.stdout) process.stdout.write(writes.stdout);
        if (writes.stderr) process.stderr.write(writes.stderr ?? "");
      }
      const tail = flush();
      if (tail.stdout) process.stdout.write(tail.stdout);
      if (tail.stderr) process.stderr.write(tail.stderr ?? "");
      return;
    }

    for await (const chunk of agent.processMessage(enhancedMessage)) {
      const writes = renderHeadlessChunk(chunk);
      if (writes.stdout) process.stdout.write(writes.stdout);
      if (writes.stderr) process.stderr.write(writes.stderr);
    }
  } finally {
    await agent.cleanup();
  }
}

function changeDirectoryOrExit(directory: string | undefined) {
  if (!directory) {
    return;
  }

  try {
    process.chdir(directory);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Cannot change to directory ${directory}: ${msg}`);
    process.exit(1);
  }
}

type CliOptions = Record<string, string | boolean | undefined>;

function stringOption(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function resolveCliSandboxMode(value: string | boolean | undefined): SandboxMode | undefined {
  if (value === true) return "shuru";
  if (value === false) return "off";
  return undefined;
}

function hasExplicitSandboxOption(options: CliOptions): boolean {
  return options.sandbox === true || options.sandbox === false;
}

async function promptWorkspaceTrust(
  cwd: string,
  sandboxSupported = isShuruSandboxSupported(),
): Promise<ReturnType<typeof resolveWorkspaceTrustPromptAnswer>> {
  const message = sandboxSupported
    ? [
        "",
        `Crow has not been run in ${cwd} before.`,
        "",
        "Sandbox mode isolates agent shell commands in a Shuru microVM so",
        "untrusted repos cannot touch your host filesystem or network by default.",
        "",
        "Run crow in sandbox mode for this directory?",
        "",
        "  [Y] Yes, always in sandbox",
        "  [n] No, run on host",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/n/s]: ",
      ].join("\n")
    : [
        "",
        `Crow has not been run in ${cwd} before.`,
        "",
        "Sandbox mode is only available on macOS Apple Silicon in this version.",
        "",
        "Run crow directly on the host for this directory?",
        "",
        "  [Y] Yes, remember host mode",
        "  [s] Yes, this session only",
        "",
        "Choice [Y/s]: ",
      ].join("\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(message, resolve);
    });
    return resolveWorkspaceTrustPromptAnswer(answer, sandboxSupported);
  } finally {
    rl.close();
  }
}

async function resolveWorkspaceTrustSandboxMode(sandboxMode: SandboxMode, options: CliOptions): Promise<SandboxMode> {
  if (sandboxMode === "shuru" || hasExplicitSandboxOption(options)) return sandboxMode;
  if (process.env.CROW_TRUST_WORKSPACE) return sandboxMode;

  const cwd = process.cwd();
  const saved = getWorkspaceTrustDecision(cwd);
  if (saved) return saved;
  if (!process.stdin.isTTY || !process.stderr.isTTY) return sandboxMode;

  const decision = await promptWorkspaceTrust(cwd);
  if (decision.remember) saveWorkspaceTrustDecision(cwd, decision.sandboxMode);
  return decision.sandboxMode;
}

async function runBackgroundDelegation(jobPath: string, options: CliOptions) {
  let output = "";
  let agent: Agent | undefined;

  try {
    const delegation = await loadDelegation(jobPath);
    const config = resolveConfig(options);
    const apiKey = config.apiKey;
    if (!apiKey) {
      throw new Error("No provider selected. Use /connect in the TUI to choose a provider first.");
    }

    const baseURL = config.baseURL;
    const explicitModel = stringOption(options.model) || delegation.model;
    const model = explicitModel ? normalizeModelId(explicitModel) : undefined;
    const maxToolRounds =
      parseInt(stringOption(options.maxToolRounds) || String(delegation.maxToolRounds), 10) || delegation.maxToolRounds;
    const sandboxMode = resolveCliSandboxMode(options.sandbox) || delegation.sandboxMode || getCurrentSandboxMode();
    const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), delegation.sandboxSettings);
    agent = new Agent(apiKey, baseURL, model, maxToolRounds, {
      persistSession: false,
      sandboxMode,
      sandboxSettings,
      batchApi: Boolean(delegation.batchApi ?? options.batchApi === true),
      providerId: config.providerId,
    });
    let history: ModelMessage[] = [];
    if (delegation.sessionId) {
      try {
        const store = new SessionStore(delegation.cwd);
        if (store.getSessionById(delegation.sessionId)) {
          history = loadTranscript(delegation.sessionId);
        }
      } catch {
        history = [];
      }
    }
    const result = await agent.runTaskRequest(
      {
        agent: delegation.agent,
        description: delegation.description,
        prompt: delegation.prompt,
      },
      undefined,
      undefined,
      { history },
    );

    output = (result.output || "").trim();

    if (!result.success) {
      await failDelegation(jobPath, result.output || result.error || "Background delegation failed.", output);
      return;
    }

    if (delegation.sessionId) {
      try {
        const store = new SessionStore(delegation.cwd);
        if (store.getSessionById(delegation.sessionId)) {
          appendMessages(delegation.sessionId, [
            { role: "user", content: delegation.prompt },
            { role: "assistant", content: output },
          ]);
          store.touchSession(delegation.sessionId, delegation.cwd);
        }
      } catch {
        // Best effort — the delegation record already holds the completed output.
      }
    }
    await completeDelegation(jobPath, output, result.task?.summary);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await failDelegation(jobPath, msg, output);
    } catch {
      // Best effort — background tasks should fail silently if persistence is unavailable.
    }
    process.exit(1);
  } finally {
    await agent?.cleanup();
  }
}

function resolveConfig(options: CliOptions) {
  const providerOption = stringOption(options.provider);
  if (providerOption) {
    const provider = findProvider(providerOption, loadCustomProviders());
    if (provider) selectProvider(provider.id);
  }
  const selected = getSelectedProvider();
  const providerId = selected?.provider.id ?? providerOption;
  const apiKey = stringOption(options.apiKey) || selected?.apiKey;
  const baseURL = stringOption(options.baseUrl) || selected?.provider.baseUrl || "";
  const explicitModel = stringOption(options.model);
  const model = explicitModel ? normalizeModelId(explicitModel) : selected?.modelId || getCurrentModel() || undefined;
  const maxToolRounds = parseInt(stringOption(options.maxToolRounds) || "400", 10) || 400;
  const sandboxMode = resolveCliSandboxMode(options.sandbox) || getCurrentSandboxMode();

  const cliOverrides: SandboxSettings = {};
  if (options.allowNet === true) cliOverrides.allowNet = true;
  const allowHostValue = options.allowHost;
  if (Array.isArray(allowHostValue) && allowHostValue.length > 0) {
    cliOverrides.allowedHosts = allowHostValue as string[];
    if (!cliOverrides.allowNet) cliOverrides.allowNet = true;
  }
  const portValue = options.port;
  if (Array.isArray(portValue) && portValue.length > 0) {
    cliOverrides.ports = portValue as string[];
  }
  const sandboxSettings = mergeSandboxSettings(getCurrentSandboxSettings(), cliOverrides);

  if (typeof options.apiKey === "string" && providerId) saveProviderApiKey(providerId, options.apiKey);
  if (typeof options.model === "string") saveUserSettings({ defaultModel: normalizeModelId(options.model) });

  return { apiKey, baseURL, model, maxToolRounds, sandboxMode, sandboxSettings, providerId };
}

function requireApiKey(apiKey: string | undefined): string {
  if (!apiKey) {
    console.error(
      "Error: No provider selected. Use /connect in the TUI to choose a provider, or set CROW_PROVIDER and a provider API key.",
    );
    process.exit(1);
  }

  return apiKey;
}

function parseHeadlessOutputFormat(value: string): HeadlessOutputFormat {
  if (isHeadlessOutputFormat(value)) {
    return value;
  }

  throw new InvalidArgumentError(`Invalid headless format "${value}". Expected "text" or "json".`);
}

program
  .name("crow")
  .description("AI coding agent with multiple providers — built with Bun and OpenTUI")
  .version(packageJson.version)
  .argument("[message...]", "Initial message to send")
  .option("-k, --api-key <key>", "API key for the selected provider")
  .option("--provider <id>", "Provider to use (for example openai, deepseek, qwen)")
  .option("-u, --base-url <url>", "API base URL")
  .option("-m, --model <model>", "Model to use")
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("-p, --prompt <prompt>", "Run a single prompt headlessly")
  .option("--verify", "Run the built-in verify flow headlessly")
  .option("--format <format>", "Headless output format: text or json", parseHeadlessOutputFormat, "text")
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--allow-net", "Enable network access inside the Shuru sandbox")
  .option("--allow-host <pattern>", "Restrict sandbox network to specific hosts (repeatable)", collect, [])
  .option("--port <mapping>", "Forward a host port to sandbox guest (HOST:GUEST, repeatable)", collect, [])
  .option("-s, --session <id>", "Continue a saved session by id, or use 'latest'")
  .option("--background-task-file <path>", "Run a persisted background delegation")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--batch-api", "Use batch API for model calls (async, lower cost)")
  .option("--update", "Update crow to the latest version and exit")
  .action(async (message: string[], options) => {
    if (options.update) {
      console.log("Checking for updates...");
      const result = await runUpdate(packageJson.version);
      console.log(result.output);
      process.exit(result.success ? 0 : 1);
    }

    changeDirectoryOrExit(options.directory);

    if (options.backgroundTaskFile) {
      await runBackgroundDelegation(options.backgroundTaskFile, options);
      return;
    }

    const config = resolveConfig(options);

    if (options.verify) {
      const verifyError = getVerifyCliError({ hasPrompt: Boolean(options.prompt), hasMessageArgs: message.length > 0 });
      if (verifyError) {
        console.error(verifyError);
        process.exit(1);
      }

      await runHeadless(
        buildVerifyPrompt(process.cwd()),
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
      );
      return;
    }

    if (options.prompt) {
      await runHeadless(
        options.prompt,
        requireApiKey(config.apiKey),
        config.baseURL,
        config.model,
        config.maxToolRounds,
        options.batchApi === true,
        config.sandboxMode,
        config.sandboxSettings,
        options.format,
        options.session,
      );
      return;
    }

    const initialMessage = message.length > 0 ? message.join(" ") : undefined;
    config.sandboxMode = await resolveWorkspaceTrustSandboxMode(config.sandboxMode, options);
    await startInteractive(
      config.apiKey,
      config.baseURL,
      config.model,
      config.providerId,
      config.maxToolRounds,
      options.batchApi === true,
      config.sandboxMode,
      config.sandboxSettings,
      options.session,
      initialMessage,
    );
  });

program
  .command("telegram-bridge")
  .description("Start the Telegram remote-control bridge without opening the TUI")
  .option("-k, --api-key <key>", "API key for the selected provider")
  .option("--provider <id>", "Provider to use (for example openai, deepseek, qwen)")
  .option("-u, --base-url <url>", "API base URL")
  .option("-m, --model <model>", "Model to use")
  .option("-d, --directory <dir>", "Working directory", process.cwd())
  .option("--sandbox", "Run agent shell commands inside a Shuru sandbox")
  .option("--no-sandbox", "Run agent shell commands directly on the host")
  .option("--max-tool-rounds <n>", "Max tool execution rounds", "400")
  .option("--log-file <path>", "Bridge log file", "telegram-remote-bridge.log")
  .option("--pair-code-file <path>", "Pairing code file", "telegram-pair-code.txt")
  .action(async (options) => {
    changeDirectoryOrExit(options.directory);
    const config = resolveConfig(options);

    process.off("SIGTERM", exitCleanlyOnSigterm);
    try {
      await runTelegramHeadlessBridge({
        apiKey: requireApiKey(config.apiKey),
        baseURL: config.baseURL,
        model: config.model,
        maxToolRounds: config.maxToolRounds,
        sandboxMode: config.sandboxMode,
        sandboxSettings: config.sandboxSettings,
        logFile: options.logFile,
        pairCodeFile: options.pairCodeFile,
      });
    } finally {
      process.on("SIGTERM", exitCleanlyOnSigterm);
    }
  });

program
  .command("models")
  .description("List available models for the selected provider, or all providers when none is selected")
  .option("--provider <id>", "Provider to list models for")
  .action((options, command) => {
    const providerArg =
      typeof options.provider === "string"
        ? options.provider
        : typeof command?.opts?.()?.provider === "string"
          ? command.opts().provider
          : typeof program.opts().provider === "string"
            ? program.opts().provider
            : undefined;
    if (providerArg) {
      const provider = findProvider(providerArg, loadCustomProviders());
      if (provider) {
        selectProvider(provider.id);
      } else {
        console.log(`\nUnknown provider: ${providerArg}. Open the TUI and use /connect to choose a provider.`);
        return;
      }
    }
    const selected = getSelectedProvider();
    const selectedId = selected?.provider.id ?? getSelectedProviderId();
    const selectedProvider =
      selected?.provider ?? (selectedId ? findProvider(selectedId, loadCustomProviders()) : undefined);
    const providers = selectedProvider ? [selectedProvider] : getAllProviders(loadCustomProviders());
    for (const provider of providers) {
      console.log(`\n${provider.name} (${provider.id}) — ${provider.baseUrl}\n`);
      for (const m of provider.models) {
        console.log(`  ${m.id} — ${m.name}`);
      }
    }
    if (!selected) {
      if (selectedProvider) {
        console.log(
          `\nProvider ${selectedProvider.id} is selected but no API key is saved. Open the TUI and use /connect to enter its key.`,
        );
      } else {
        console.log("\nNo provider selected. Open the TUI and use /connect to choose a provider.");
      }
    }
    console.log();
  });

program
  .command("update")
  .description("Update Crow to the latest release")
  .action(async () => {
    console.log("Checking for updates...");
    const result = await runUpdate(packageJson.version);
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("uninstall")
  .description("Remove a script-installed Crow binary and optional data")
  .option("--dry-run", "Show what would be removed without removing it")
  .option("--force", "Skip the confirmation prompt")
  .option("--keep-config", "Keep ~/.crow config files")
  .option("--keep-data", "Keep ~/.crow data files")
  .action(async (options) => {
    const result = await runScriptManagedUninstall({
      dryRun: options.dryRun === true,
      force: options.force === true,
      keepConfig: options.keepConfig === true,
      keepData: options.keepData === true,
    });
    console.log(result.output);
    process.exit(result.success ? 0 : 1);
  });

program
  .command("daemon")
  .description("Start the schedule daemon to run scheduled tasks")
  .option("--background", "Detach and run in the background")
  .action(async (options) => {
    if (options.background) {
      const result = await startScheduleDaemon(process.cwd());
      console.log(
        result.alreadyRunning
          ? `Schedule daemon already running (pid: ${result.status.pid ?? "unknown"}).`
          : `Schedule daemon started in the background (pid: ${result.pid ?? "unknown"}).`,
      );
      return;
    }

    process.off("SIGTERM", exitCleanlyOnSigterm);
    const { SchedulerDaemon } = await import("./daemon/scheduler");
    const daemon = new SchedulerDaemon();
    await daemon.start();
  });

program.parse();
