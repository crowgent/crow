import type { KeyBinding, KeyEvent, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { decodePasteBytes, type PasteEvent, parseKeypress } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import os from "os";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Agent } from "../agent/agent";
import {
  DEFAULT_MODEL,
  getEffectiveReasoningEffort,
  getModelIds,
  getModelInfo,
  getSupportedReasoningEfforts,
  MODELS,
  normalizeModelId,
  type ProviderModelInfo,
} from "../crow/models";
import { parseEnvLines, parseHeaderLines } from "../mcp/parse-headers";
import { toMcpServerId, validateMcpServerConfig } from "../mcp/validate";
import { createTelegramBridge, type TelegramBridgeHandle } from "../telegram/bridge";
import { approvePairingCode } from "../telegram/pairing";
import { createTurnCoordinator } from "../telegram/turn-coordinator";
import type { ScheduleDaemonStatus, StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  FileDiff,
  ModelInfo,
  Plan,
  PlanQuestion,
  ReasoningEffort,
  SubagentStatus,
  ToolCall,
  ToolResult,
} from "../types/index";
import { MODES } from "../types/index";
import {
  type AgentDefinition,
  type AgentFileInput,
  deleteAgentFile,
  disableBuiltinAgent,
  findAgentDefinition,
  loadAgentDefinitions,
  writeAgentFile,
} from "../utils/agent-files";
import { processAtMentions } from "../utils/at-mentions.js";
import { FileIndex } from "../utils/file-index.js";
import { copyTextToHostClipboard } from "../utils/host-clipboard";
import {
  type CustomProvider,
  fetchProviderModels,
  findProvider,
  getAllProviders,
  mergeModelIds,
  normalizeBaseUrl,
  type ProviderDefinition,
} from "../utils/providers";
import {
  type CustomSubagentConfig,
  getCurrentModel,
  getProviderApiKey,
  getSelectedProvider,
  getTelegramBotToken,
  isReservedSubagentName,
  loadCustomProviders,
  loadMcpServers,
  loadUserSettings,
  loadValidSubAgents,
  type McpRemoteTransport,
  type McpServerConfig,
  type SandboxMode,
  type SandboxSettings,
  saveApprovedTelegramUserId,
  saveCustomProviders,
  saveMcpServers,
  saveProjectSettings,
  saveProviderApiKey,
  saveRecapsEnabled,
  saveUserSettings,
  selectProvider,
} from "../utils/settings";
import { discoverSkills, formatSkillsForChat } from "../utils/skills";
import { formatSubagentName } from "../utils/subagent-display";
import { checkForUpdate, runUpdate, type UpdateCheckResult } from "../utils/update-checker";
import { buildVerifyPrompt } from "../verify/entrypoint";
import {
  buildAgentFleetRows,
  SUBAGENT_EDITOR_FIELDS,
  type SubagentEditorField,
  SubagentEditorModal,
  SubagentsBrowserModal,
} from "./agents-modal";
import { BtwOverlay, type BtwState } from "./components/btw-overlay.js";
import { SuggestionOverlay } from "./components/SuggestionOverlay.js";
import { type TypeaheadState, useTypeahead } from "./hooks/useTypeahead.js";
import { Markdown } from "./markdown";
import { buildMcpBrowseRows, McpBrowserModal, McpEditorModal } from "./mcp-modal";
import { createEmptyMcpEditorDraft, type McpEditorDraft, type McpEditorField } from "./mcp-modal-types";
import {
  formatPlanAnswers,
  initialPlanQuestionsState,
  PlanQuestionsPanel,
  type PlanQuestionsState,
  PlanView,
} from "./plan";
import { buildScheduleBrowseRows, ScheduleBrowserModal } from "./schedule-modal";
import { filterSlashMenuItems, SLASH_MENU_ITEMS, type SlashMenuItem } from "./slash-menu";
import {
  buildAssistantEntry,
  buildToolResultEntry,
  buildUserEntry,
  decorateTelegramEntries,
  getTelegramSourceLabel,
  getUnflushedTelegramAssistantContent,
  replaceTurnEntries,
} from "./telegram-turn-ui";
import { getCompactTuiSelectionText } from "./terminal-selection-text";
import { dark, type Theme } from "./theme";

const CROW_LOGO = [
  "██████  ██████  ██████  ██      ██",
  "██      ██  ██  ██  ██  ██      ██",
  "▓▓░░    ▓▓██    ██  ▓▓  ██  ██  ▓▓",
  "▓▓░░    ▓▓  ██  ██  ▓▓  ██  ██  ▓▓",
  "██████  ██  ██  ██████  ██████████",
  "                                  ",
];

function HeroLogo({ t }: { t: Theme }) {
  return (
    <box flexDirection="column" alignItems="center">
      {CROW_LOGO.map((line) => (
        <text key={line} fg={t.primary}>
          {line}
        </text>
      ))}
    </box>
  );
}

type ContextStats = {
  contextWindow: number;
  usedTokens: number;
  remainingTokens: number;
  ratioUsed: number;
  ratioRemaining: number;
};
type PasteBlock = { id: number; content: string; lines: number; isImage?: boolean };
type FileMentionBlock = { id: number; path: string };
type QueuedMessage = { text: string; displayText: string; inboxId?: number };

function getPasteBlockToken(block: Pick<PasteBlock, "id" | "lines" | "isImage">): string {
  if (block.isImage) {
    return `[Image #${block.id}]`;
  }
  return `[Pasted #${block.id} ${block.lines}+ lines]`;
}

function getFileMentionToken(block: FileMentionBlock): string {
  const name = block.path.split("/").pop() || block.path;
  return `[File: ${name}]`;
}

const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};
const _SPLIT_END = { ...SPLIT, bottomLeft: "╹" };
const _EMPTY = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
};
const _LINE = {
  topLeft: "━",
  bottomLeft: "━",
  vertical: "",
  topRight: "━",
  bottomRight: "━",
  horizontal: "━",
  bottomT: "━",
  topT: "━",
  cross: "━",
  leftT: "━",
  rightT: "━",
};

const REVIEW_PROMPT = `Review all current changes in this repository. Follow these steps:

1. Run \`git status\` to see which files have been modified, staged, or are untracked.
2. Run \`git diff\` to see unstaged changes and \`git diff --cached\` to see staged changes.
3. If there are no changes at all, say so and stop.
4. Read any changed files in full if needed for context.

Then produce a **Review Report** in this exact structure:

## Summary
One paragraph overview of what changed and why (inferred from the diff).

## Files Changed
For each changed file, list the filename and a brief description of the change.

## Issues Found
List any bugs, logic errors, security concerns, missing error handling, or correctness problems. If none, say "No issues found."

## Suggestions
Code quality, naming, performance, and best-practice improvements. If none, say "No suggestions."

## Risk Assessment
Rate the overall risk of these changes as **Low**, **Medium**, or **High** with a short justification.`;

const COMMIT_PUSH_PROMPT = `Create a git commit for the current repository changes and push the current branch to its remote.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit workflow and safety checks. Inspect the current changes, stage any relevant untracked files, create an appropriate commit message, and push the branch if a commit was created. If there is nothing to commit, say so and stop.`;

const COMMIT_PR_PROMPT = `Create a git commit for the current repository changes and open a pull request for the current branch.

Before committing, inspect the current branch. If it is not already a feature branch, create and switch to a new feature branch with a descriptive name based on the changes.

Follow the repository's commit and pull request workflows. Inspect the current changes, stage any relevant untracked files, create an appropriate commit, push the branch if needed, then open a pull request with a concise summary and test plan. Return the pull request URL. If there is nothing to commit or open in a pull request, explain why and stop.`;

const BUILTIN_TYPED_SLASH_COMMANDS = new Set([
  "/clear",
  "/connect",
  "/login",
  "/model",
  "/models",
  "/sandbox",
  "/recap",
  "/recaps",
  "/remote-control",
  "/mcp",
  "/mcps",
  "/agents",
  "/agent",
  "/schedule",
  "/schedules",
  "/quit",
  "/exit",
  "/q",
  "/review",
  "/verify",
  "/commit-push",
  "/commit-pr",
  "/btw",
]);

interface SandboxRow {
  key: string;
  label: string;
  type: "toggle" | "text";
  placeholder?: string;
  getDisplay: (mode: SandboxMode, s: SandboxSettings) => string;
  getOptions?: () => string[];
  apply: (mode: SandboxMode, s: SandboxSettings, value: string) => { mode?: SandboxMode; settings?: SandboxSettings };
}

const SANDBOX_ROWS: SandboxRow[] = [
  {
    key: "mode",
    label: "Mode",
    type: "toggle",
    getDisplay: (mode) => (mode === "shuru" ? "Shuru" : "Off"),
    getOptions: () => ["Off", "Shuru"],
    apply: (_mode, _s, value) => ({ mode: value === "Shuru" ? "shuru" : "off" }),
  },
  {
    key: "allowNet",
    label: "Network",
    type: "toggle",
    getDisplay: (_m, s) => (s.allowNet ? "On" : "Off"),
    getOptions: () => ["Off", "On"],
    apply: (_m, _s, value) => ({ settings: { allowNet: value === "On" } }),
  },
  {
    key: "allowedHosts",
    label: "Allowed hosts",
    type: "text",
    placeholder: "api.openai.com, registry.npmjs.org",
    getDisplay: (_m, s) => s.allowedHosts?.join(", ") || "(unrestricted)",
    apply: (_m, _s, value) => ({
      settings: {
        allowedHosts: value
          ? value
              .split(",")
              .map((h) => h.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "ports",
    label: "Port forwards",
    type: "text",
    placeholder: "8080:80, 8443:443",
    getDisplay: (_m, s) => s.ports?.join(", ") || "(none)",
    apply: (_m, _s, value) => ({
      settings: {
        ports: value
          ? value
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean)
          : undefined,
      },
    }),
  },
  {
    key: "cpus",
    label: "CPUs",
    type: "text",
    placeholder: "e.g. 4",
    getDisplay: (_m, s) => (s.cpus ? String(s.cpus) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { cpus: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "memory",
    label: "Memory (MB)",
    type: "text",
    placeholder: "e.g. 4096",
    getDisplay: (_m, s) => (s.memory ? String(s.memory) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { memory: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "diskSize",
    label: "Disk size (MB)",
    type: "text",
    placeholder: "e.g. 8192",
    getDisplay: (_m, s) => (s.diskSize ? String(s.diskSize) : "(default)"),
    apply: (_m, _s, value) => ({ settings: { diskSize: value ? parseInt(value, 10) || undefined : undefined } }),
  },
  {
    key: "from",
    label: "Checkpoint",
    type: "text",
    placeholder: "checkpoint name",
    getDisplay: (_m, s) => s.from || "(none)",
    apply: (_m, _s, value) => ({ settings: { from: value || undefined } }),
  },
];

function getSandboxVisibleRows(mode: SandboxMode): SandboxRow[] {
  return mode === "shuru" ? SANDBOX_ROWS : SANDBOX_ROWS.slice(0, 1);
}

const RECAP_OPTIONS = ["Off", "On"] as const;

function formatRecapsEnabled(enabled: boolean): (typeof RECAP_OPTIONS)[number] {
  return enabled ? "On" : "Off";
}

function parseCustomSubagentSlashCommand(
  cmd: string,
  subagents: CustomSubagentConfig[],
  definitions: AgentDefinition[],
): { agentName: string; prompt: string } | null {
  const trimmed = cmd.trim();
  if (!trimmed.startsWith("/")) return null;

  const body = trimmed.slice(1).trim();
  if (!body) return null;

  const commandToken = body.split(/\s+/, 1)[0]?.toLowerCase();
  if (commandToken && BUILTIN_TYPED_SLASH_COMMANDS.has(`/${commandToken}`)) {
    return null;
  }

  const lowerBody = body.toLowerCase();
  const names = [
    ...subagents.map((item) => item.name),
    ...definitions.filter((item) => item.enabled && item.mode !== "primary").map((item) => item.name),
  ];
  const sortedNames = [...new Set(names)].sort((a, b) => b.length - a.length);
  const match = sortedNames.find((name) => {
    const lowerName = name.trim().toLowerCase();
    return lowerBody === lowerName || lowerBody.startsWith(`${lowerName} `);
  });
  if (!match) return null;

  return {
    agentName: match,
    prompt: body.slice(match.length).trim(),
  };
}

function buildCustomSubagentSlashPrompt(agentName: string, prompt: string): string {
  return `Use the sub-agent "${agentName}" for this task.

Delegate the work with the \`task\` tool using:
- \`agent\`: "${agentName}"
- \`description\`: a short summary of the work
- \`prompt\`: a detailed prompt based on the user's request

User request:
${prompt}`;
}

const CONNECT_CHANNELS: { id: string; label: string; description: string }[] = [
  { id: "telegram", label: "Telegram", description: "Chat with Crow from Telegram" },
];

const MCP_REMOTE_FIELDS: McpEditorField[] = ["transport", "label", "url", "headers", "env"];
const MCP_STDIO_FIELDS: McpEditorField[] = ["transport", "label", "command", "args", "cwd", "env"];

export interface AppStartupConfig {
  apiKey: string | undefined;
  baseURL: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  maxToolRounds: number;
  version: string;
}

interface AppProps {
  agent: Agent;
  startupConfig: AppStartupConfig;
  initialMessage?: string;
  onExit?: () => void;
}

interface ActiveTurnState {
  kind: "local" | "telegram";
  agent: Agent;
  modeColor?: string;
  remoteKey?: string;
  sourceLabel?: string;
  userId?: number;
  latestAssistantText: string;
  flushedAssistantChars: number;
}

export function App({ agent, startupConfig, initialMessage, onExit }: AppProps) {
  const t = dark;
  const renderer = useRenderer();
  const initialHasApiKey = agent.hasApiKey();
  const [hasApiKey, setHasApiKey] = useState(initialHasApiKey);
  const [messages, setMessages] = useState<ChatEntry[]>(() => agent.getChatEntries());
  const [streamContent, setStreamContent] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [thoughtSummary, setThoughtSummary] = useState<{ durationMs: number } | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [liveTurnSourceLabel, setLiveTurnSourceLabel] = useState<string | null>(null);
  const [model, setModel] = useState(agent.getModel());
  const [sandboxMode, setSandboxModeState] = useState<SandboxMode>(agent.getSandboxMode());
  const [mode, setModeState] = useState<AgentMode>(agent.getMode());
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [modelPickerIndex, setModelPickerIndex] = useState(0);
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [showSandboxPicker, setShowSandboxPicker] = useState(false);
  const [sandboxSettings, setSandboxSettingsState] = useState<SandboxSettings>(() => agent.getSandboxSettings());
  const [sandboxSettingsFocusIndex, setSandboxSettingsFocusIndex] = useState(0);
  const [sandboxSettingsEditing, setSandboxSettingsEditing] = useState<string | null>(null);
  const [sandboxSettingsEditBuffer, setSandboxSettingsEditBuffer] = useState("");
  const [showRecapPicker, setShowRecapPicker] = useState(false);
  const [recapsEnabled, setRecapsEnabledState] = useState(() => agent.getRecapsEnabled());
  const [pendingPaymentApproval, setPendingPaymentApproval] = useState<{
    url: string;
    description: string;
    security: string;
    securityLabel: string;
    securityUrl: string;
    amount: string;
    network: string;
    asset: string;
    approvalId?: string;
    selected: number;
  } | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    action: string;
    resource: string;
    toolName: string;
    selected: number;
  } | null>(null);
  const permissionQueueRef = useRef<
    Array<{
      request: { action: string; resource: string; toolName: string };
      resolve: (decision: "allow" | "deny") => void;
    }>
  >([]);
  const permissionAnsweredAtRef = useRef(0);
  const advancePermissionQueue = useCallback(() => {
    const next = permissionQueueRef.current[0];
    setPendingPermission(next ? { ...next.request, selected: 0 } : null);
  }, []);
  const answerPermission = useCallback(
    (decision: "allow" | "deny", always: boolean) => {
      const current = permissionQueueRef.current.shift();
      if (!current) return;
      permissionAnsweredAtRef.current = Date.now();
      if (always && decision === "allow") {
        agent.addPermissionRule({
          action: current.request.action,
          resource: current.request.resource,
          effect: "allow",
        });
      }
      current.resolve(decision);
      advancePermissionQueue();
    },
    [agent, advancePermissionQueue],
  );
  useEffect(() => {
    agent.setPermissionResolver((request) => {
      return new Promise<"allow" | "deny">((resolve) => {
        permissionQueueRef.current.push({ request, resolve });
        if (permissionQueueRef.current.length === 1) {
          advancePermissionQueue();
        }
      });
    });
    return () => {
      agent.setPermissionResolver(null);
    };
  }, [agent, advancePermissionQueue]);
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options: string[];
    selected: number;
  } | null>(null);
  const questionQueueRef = useRef<
    Array<{
      questions: Array<{ question: string; options: string[] }>;
      answers: string[];
      index: number;
      resolve: (answers: string[]) => void;
      reject: (error: Error) => void;
    }>
  >([]);
  const questionAnsweredAtRef = useRef(0);
  const advanceQuestionQueue = useCallback(() => {
    const next = questionQueueRef.current[0];
    if (!next) {
      setPendingQuestion(null);
      return;
    }
    const current = next.questions[next.index];
    setPendingQuestion(current ? { question: current.question, options: current.options, selected: 0 } : null);
  }, []);
  const answerQuestion = useCallback(
    (option: string) => {
      const current = questionQueueRef.current[0];
      if (!current) return;
      questionAnsweredAtRef.current = Date.now();
      current.answers.push(option);
      current.index += 1;
      if (current.index >= current.questions.length) {
        questionQueueRef.current.shift();
        current.resolve(current.answers);
      }
      advanceQuestionQueue();
    },
    [advanceQuestionQueue],
  );
  const declineQuestion = useCallback(() => {
    const current = questionQueueRef.current.shift();
    if (!current) return;
    questionAnsweredAtRef.current = Date.now();
    current.resolve([]);
    advanceQuestionQueue();
  }, [advanceQuestionQueue]);
  useEffect(() => {
    agent.setQuestionResolver((questions, abortSignal) => {
      return new Promise<string[]>((resolve, reject) => {
        const item = { questions, answers: [] as string[], index: 0, resolve, reject };
        questionQueueRef.current.push(item);
        if (abortSignal) {
          const onAbort = () => {
            const at = questionQueueRef.current.indexOf(item);
            if (at >= 0) questionQueueRef.current.splice(at, 1);
            reject(new Error("aborted"));
            advanceQuestionQueue();
          };
          if (abortSignal.aborted) {
            onAbort();
            return;
          }
          abortSignal.addEventListener("abort", onAbort, { once: true });
        }
        if (questionQueueRef.current.length === 1) {
          advanceQuestionQueue();
        }
      });
    });
    return () => {
      agent.setQuestionResolver(null);
    };
  }, [agent, advanceQuestionQueue]);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCall[]>([]);
  const [sessionTitle, setSessionTitle] = useState<string | null>(() => agent.getSessionTitle());
  const [sessionId, setSessionId] = useState<string | null>(() => agent.getSessionId());
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [providerStep, setProviderStep] = useState<
    | "list"
    | "key"
    | "customId"
    | "customName"
    | "customBaseUrl"
    | "customKey"
    | "customModelSource"
    | "customModel"
    | "customModelName"
    | "customModelList"
  >("list");
  const [providerIndex, setProviderIndex] = useState(0);
  const [providerSelectedId, setProviderSelectedId] = useState<string | null>(null);
  const [providerLoading, setProviderLoading] = useState(false);
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>(() => loadCustomProviders());
  const [customDraft, setCustomDraft] = useState<{
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    modelId: string;
  }>({
    id: "",
    name: "",
    baseUrl: "",
    apiKey: "",
    modelId: "",
  });
  const [customFetchedModels, setCustomFetchedModels] = useState<string[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => getSelectedProvider()?.provider.id ?? agent.getProviderId() ?? null,
  );
  const [providerFetchedModels, setProviderFetchedModels] = useState<string[] | null>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashMenuIndex, setSlashMenuIndex] = useState(0);
  const [slashSearchQuery, setSlashSearchQuery] = useState("");
  const [btwState, setBtwState] = useState<BtwState | null>(null);
  const btwAbortRef = useRef<AbortController | null>(null);
  const btwStateRef = useRef<BtwState | null>(null);
  const [reasoningEffortByModel, setReasoningEffortByModel] = useState<Record<string, ReasoningEffort>>(() =>
    Object.fromEntries(
      Object.entries(loadUserSettings().reasoningEffortByModel ?? {}).map(([modelId, effort]) => [
        normalizeModelId(modelId),
        effort,
      ]),
    ),
  );
  const [pasteBlocks, setPasteBlocks] = useState<PasteBlock[]>([]);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  /** Incremented on each successful TUI copy; drives a brief "Copied" banner. */
  const [copyFlashId, setCopyFlashId] = useState(0);
  const [expandedMessages, setExpandedMessages] = useState<Set<number>>(() => new Set());
  const [activeSubagent, setActiveSubagent] = useState<SubagentStatus | null>(null);
  const [pqs, setPqs] = useState<PlanQuestionsState>(initialPlanQuestionsState());
  const pasteCounterRef = useRef(0);
  const pasteBlocksRef = useRef<PasteBlock[]>([]);
  const providerInputRef = useRef<TextareaRenderable>(null);
  const inputRef = useRef<TextareaRenderable>(null);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const { width, height } = useTerminalDimensions();
  const processedInitial = useRef(false);
  const contentAccRef = useRef("");
  const startTimeRef = useRef(0);
  const thoughtDoneRef = useRef(false);
  const reasoningAccRef = useRef("");
  const isProcessingRef = useRef(false);
  const hasApiKeyRef = useRef(initialHasApiKey);
  const showProviderModalRef = useRef(false);
  const queuedMessagesRef = useRef<QueuedMessage[]>([]);
  const processMessageRef = useRef<(text: string, displayText?: string) => Promise<void> | void>(() => {});
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const modeInfoRef = useRef<(typeof MODES)[number]>(MODES[0]);
  const activeRunIdRef = useRef(0);
  const interruptedRunIdRef = useRef<number | null>(null);
  const activeTurnRef = useRef<ActiveTurnState | null>(null);
  const coordinatorRef = useRef(createTurnCoordinator());
  const bridgeRef = useRef<TelegramBridgeHandle | null>(null);
  const telegramAgentsRef = useRef<Map<number, Agent>>(new Map());
  const telegramEntryCountsRef = useRef<Map<number, number>>(new Map());
  const telegramSubagentUnsubsRef = useRef<Map<number, () => void>>(new Map());
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showTelegramTokenModal, setShowTelegramTokenModal] = useState(false);
  const [showTelegramPairModal, setShowTelegramPairModal] = useState(false);
  const [telegramTokenError, setTelegramTokenError] = useState<string | null>(null);
  const [telegramPairError, setTelegramPairError] = useState<string | null>(null);
  const [connectModalIndex, setConnectModalIndex] = useState(0);
  const telegramTokenInputRef = useRef<TextareaRenderable>(null);
  const telegramPairInputRef = useRef<TextareaRenderable>(null);
  const showConnectModalRef = useRef(false);
  const showTelegramTokenModalRef = useRef(false);
  const showTelegramPairModalRef = useRef(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [showMcpEditor, setShowMcpEditor] = useState(false);
  const [mcpSearchQuery, setMcpSearchQuery] = useState("");
  const [mcpModalIndex, setMcpModalIndex] = useState(0);
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>(() => loadMcpServers());
  const [mcpEditorDraft, setMcpEditorDraft] = useState<McpEditorDraft>(createEmptyMcpEditorDraft());
  const [mcpEditorField, setMcpEditorField] = useState<McpEditorField>("transport");
  const [mcpEditorSyncKey, setMcpEditorSyncKey] = useState(0);
  const [mcpEditorError, setMcpEditorError] = useState<string | null>(null);
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null);
  const showMcpModalRef = useRef(false);
  const showMcpEditorRef = useRef(false);
  const mcpLabelRef = useRef<TextareaRenderable>(null);
  const mcpUrlRef = useRef<TextareaRenderable>(null);
  const mcpHeadersRef = useRef<TextareaRenderable>(null);
  const mcpCommandRef = useRef<TextareaRenderable>(null);
  const mcpArgsRef = useRef<TextareaRenderable>(null);
  const mcpCwdRef = useRef<TextareaRenderable>(null);
  const mcpEnvRef = useRef<TextareaRenderable>(null);
  const [showAgentsModal, setShowAgentsModal] = useState(false);
  const [showAgentsEditor, setShowAgentsEditor] = useState(false);
  const [subAgents, setSubAgents] = useState<CustomSubagentConfig[]>(() => loadValidSubAgents());
  const [agentDefinitions, setAgentDefinitions] = useState<AgentDefinition[]>(() =>
    loadAgentDefinitions(process.cwd()),
  );
  const [editingFile, setEditingFile] = useState<{
    definition: AgentDefinition | null;
    scope: "project" | "global";
    originalModel: string;
  } | null>(null);
  const [directSubagent, setDirectSubagent] = useState<SubagentStatus | null>(null);
  const [agentsSearchQuery, setAgentsSearchQuery] = useState("");
  const [agentsModalIndex, setAgentsModalIndex] = useState(0);
  const [editingSubagent, setEditingSubagent] = useState<CustomSubagentConfig | null>(null);
  const [agentsEditorDraft, setAgentsEditorDraft] = useState({ name: "", instruction: "" });
  const [agentsEditorField, setAgentsEditorField] = useState<SubagentEditorField>("name");
  const [agentsEditorModelIndex, setAgentsEditorModelIndex] = useState(() =>
    Math.max(
      0,
      MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
    ),
  );
  const [agentsEditorSyncKey, setAgentsEditorSyncKey] = useState(0);
  const [agentsEditorError, setAgentsEditorError] = useState<string | null>(null);
  const showAgentsModalRef = useRef(false);
  const showAgentsEditorRef = useRef(false);
  const subagentNameRef = useRef<TextareaRenderable>(null);
  const subagentInstructionRef = useRef<TextareaRenderable>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [schedules, setSchedules] = useState<StoredSchedule[]>([]);
  const [scheduleSearchQuery, setScheduleSearchQuery] = useState("");
  const [scheduleModalIndex, setScheduleModalIndex] = useState(0);
  const showScheduleModalRef = useRef(false);

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateOutput, setUpdateOutput] = useState<string | null>(null);
  const showUpdateModalRef = useRef(false);

  const fileIndexRef = useRef<FileIndex | null>(null);
  if (!fileIndexRef.current) {
    fileIndexRef.current = new FileIndex(agent.getCwd());
  }
  const fileMentionCounterRef = useRef(0);
  const fileMentionBlocksRef = useRef<FileMentionBlock[]>([]);

  const handleFileAccept = useCallback((filePath: string, tokenInfo: { startPos: number; endPos: number }) => {
    const ta = inputRef.current;
    if (!ta) return;

    const id = ++fileMentionCounterRef.current;
    const block: FileMentionBlock = { id, path: fileIndexRef.current?.resolvePath(filePath) ?? filePath };
    fileMentionBlocksRef.current = [...fileMentionBlocksRef.current, block];

    const text = ta.plainText;
    const before = text.slice(0, tokenInfo.startPos);
    const after = text.slice(tokenInfo.endPos);
    const token = getFileMentionToken(block);
    const newText = `${before}${token} ${after}`;
    ta.setText(newText);
    ta.cursorOffset = before.length + token.length + 1;
  }, []);

  const typeahead = useTypeahead(inputRef, fileIndexRef.current, handleFileAccept);
  const typeaheadRef = useRef(typeahead);
  typeaheadRef.current = typeahead;

  const setMode = useCallback(
    (m: AgentMode) => {
      if (m === "agent" && mode === "plan" && activePlan) {
        const planText = [
          `# ${activePlan.title}`,
          activePlan.summary,
          "",
          ...activePlan.steps.map(
            (s, i) =>
              `${i + 1}. ${s.title}: ${s.description}${s.filePaths?.length ? ` (${s.filePaths.join(", ")})` : ""}`,
          ),
        ].join("\n");
        agent.setPlanContext(planText);
      }
      agent.setMode(m);
      setModeState(m);
      setModel(agent.getModel());
    },
    [agent, mode, activePlan],
  );
  const cycleMode = useCallback(() => {
    const idx = MODES.findIndex((m) => m.id === mode);
    setMode(MODES[(idx + 1) % MODES.length].id);
  }, [mode, setMode]);

  const modeInfo = MODES.find((m) => m.id === mode)!;
  modeInfoRef.current = modeInfo;
  const modelInfo = getModelInfo(model);
  const contextStats = modelInfo ? agent.getContextStats(modelInfo.contextWindow, streamContent) : null;
  const providerModelInfos: ModelInfo[] = (() => {
    if (!selectedProviderId) return [];
    const custom = customProviders.find((provider) => provider.id === selectedProviderId);
    if (custom) {
      const ids = providerFetchedModels ? mergeModelIds(custom.models, providerFetchedModels) : custom.models;
      return ids.map((id) => ({
        id,
        name: custom.modelNames?.[id] ?? id,
        contextWindow: 128000,
        inputPrice: 0,
        outputPrice: 0,
        reasoning: false,
        description: "",
      }));
    }
    if (providerFetchedModels) {
      return providerFetchedModels.map((id) => {
        const info = getModelInfo(id);
        return (
          info ?? {
            id,
            name: id,
            contextWindow: 128000,
            inputPrice: 0,
            outputPrice: 0,
            reasoning: false,
            description: "",
          }
        );
      });
    }
    return MODELS.filter((m) => (m as ProviderModelInfo).provider === selectedProviderId);
  })();
  const _flatModels = providerModelInfos.map((m) => m.id);
  const filteredModels = modelSearchQuery
    ? providerModelInfos.filter(
        (m) =>
          m.name.toLowerCase().includes(modelSearchQuery.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearchQuery.toLowerCase()),
      )
    : providerModelInfos;
  const filteredModelIds = filteredModels.map((m) => m.id);
  const filteredSlashItems = filterSlashMenuItems(SLASH_MENU_ITEMS, slashSearchQuery);
  const mcpRows = buildMcpBrowseRows(mcpServers, mcpSearchQuery);
  const mcpEditorFields = mcpEditorDraft.transport === "stdio" ? MCP_STDIO_FIELDS : MCP_REMOTE_FIELDS;
  const agentRows = useMemo(
    () => buildAgentFleetRows(agentDefinitions, agentsSearchQuery),
    [agentDefinitions, agentsSearchQuery],
  );
  const scheduleRows = useMemo(
    () => buildScheduleBrowseRows(schedules, scheduleSearchQuery),
    [schedules, scheduleSearchQuery],
  );

  const syncStoredMcpServers = useCallback((servers: McpServerConfig[]) => {
    setMcpServers(servers);
    saveMcpServers(servers);
  }, []);

  const applySandboxMode = useCallback(
    (next: SandboxMode) => {
      agent.setSandboxMode(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxMode(next);
      }
      setSandboxModeState(next);
      saveProjectSettings({ sandboxMode: next });
      saveUserSettings({ sandboxMode: next });
    },
    [agent],
  );

  const applySandboxSettings = useCallback(
    (next: SandboxSettings) => {
      agent.setSandboxSettings(next);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setSandboxSettings(next);
      }
      setSandboxSettingsState(next);
      saveProjectSettings({ sandbox: next });
      saveUserSettings({ sandbox: next });
    },
    [agent],
  );

  const openSandboxPicker = useCallback(() => {
    setSandboxSettingsFocusIndex(0);
    setSandboxSettingsEditing(null);
    setSandboxSettingsEditBuffer("");
    setShowSandboxPicker(true);
  }, []);

  const applyRecapsEnabled = useCallback(
    (enabled: boolean) => {
      agent.setRecapsEnabled(enabled);
      for (const telegramAgent of telegramAgentsRef.current.values()) {
        telegramAgent.setRecapsEnabled(enabled);
      }
      setRecapsEnabledState(enabled);
      saveRecapsEnabled(enabled);
    },
    [agent],
  );

  const openRecapPicker = useCallback(() => {
    setShowRecapPicker(true);
  }, []);

  const setReasoningEfforts = useCallback((next: Record<string, ReasoningEffort>) => {
    setReasoningEffortByModel(next);
    saveUserSettings({ reasoningEffortByModel: next });
  }, []);

  const replacePasteBlocks = useCallback((next: PasteBlock[]) => {
    pasteBlocksRef.current = next;
    setPasteBlocks(next);
  }, []);

  const getModelReasoningEffort = useCallback(
    (modelId: string): ReasoningEffort | undefined => {
      const normalizedModelId = normalizeModelId(modelId);
      return getEffectiveReasoningEffort(normalizedModelId, reasoningEffortByModel[normalizedModelId]);
    },
    [reasoningEffortByModel],
  );

  const adjustModelReasoningEffort = useCallback(
    (modelId: string, direction: -1 | 1) => {
      const normalizedModelId = normalizeModelId(modelId);
      const supported = getSupportedReasoningEfforts(normalizedModelId);
      if (supported.length === 0) return;

      const current = getModelReasoningEffort(normalizedModelId);

      if (!current) {
        if (direction > 0) {
          setReasoningEfforts({ ...reasoningEffortByModel, [normalizedModelId]: supported[0] });
        }
        return;
      }

      const currentIndex = supported.indexOf(current);
      if (direction < 0 && currentIndex <= 0) {
        const { [normalizedModelId]: _, ...rest } = reasoningEffortByModel;
        setReasoningEfforts(rest);
      } else {
        const nextIndex = direction < 0 ? currentIndex - 1 : Math.min(supported.length - 1, currentIndex + 1);
        setReasoningEfforts({ ...reasoningEffortByModel, [normalizedModelId]: supported[nextIndex] });
      }
    },
    [getModelReasoningEffort, reasoningEffortByModel, setReasoningEfforts],
  );

  const snapshotMcpEditorDraft = useCallback((): McpEditorDraft => {
    return {
      ...mcpEditorDraft,
      label: mcpLabelRef.current?.plainText ?? mcpEditorDraft.label,
      url: mcpUrlRef.current?.plainText ?? mcpEditorDraft.url,
      headersText: mcpHeadersRef.current?.plainText ?? mcpEditorDraft.headersText,
      command: mcpCommandRef.current?.plainText ?? mcpEditorDraft.command,
      argsText: mcpArgsRef.current?.plainText ?? mcpEditorDraft.argsText,
      cwd: mcpCwdRef.current?.plainText ?? mcpEditorDraft.cwd,
      envText: mcpEnvRef.current?.plainText ?? mcpEditorDraft.envText,
    };
  }, [mcpEditorDraft]);

  const openMcpModal = useCallback(() => {
    const latest = loadMcpServers();
    setMcpServers(latest);
    setMcpSearchQuery("");
    setMcpModalIndex(0);
    setShowMcpModal(true);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
  }, []);

  const openMcpEditor = useCallback((draft: McpEditorDraft, editingId: string | null = null) => {
    setMcpEditorDraft(draft);
    setEditingMcpId(editingId);
    setMcpEditorField("transport");
    setMcpEditorError(null);
    setMcpEditorSyncKey((n) => n + 1);
    setShowMcpEditor(true);
    setShowMcpModal(true);
  }, []);

  const editSavedMcp = useCallback(
    (server: McpServerConfig) => {
      openMcpEditor(
        {
          label: server.label,
          transport: server.transport,
          url: server.url ?? "",
          headersText: Object.entries(server.headers ?? {})
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
          command: server.command ?? "",
          argsText: (server.args ?? []).join("\n"),
          cwd: server.cwd ?? "",
          envText: Object.entries(server.env ?? {})
            .map(([key, value]) => `${key}=${value}`)
            .join("\n"),
        },
        server.id,
      );
    },
    [openMcpEditor],
  );

  const toggleSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(
        mcpServers.map((item) => (item.id === server.id ? { ...item, enabled: !item.enabled } : item)),
      );
    },
    [mcpServers, syncStoredMcpServers],
  );

  const deleteSavedMcp = useCallback(
    (server: McpServerConfig) => {
      syncStoredMcpServers(mcpServers.filter((item) => item.id !== server.id));
      setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, mcpRows.length - 2))));
    },
    [mcpRows.length, mcpServers, syncStoredMcpServers],
  );

  const openAgentsModal = useCallback(() => {
    setSubAgents(loadValidSubAgents());
    setAgentDefinitions(loadAgentDefinitions(process.cwd()));
    setAgentsSearchQuery("");
    setAgentsModalIndex(0);
    setEditingSubagent(null);
    setEditingFile(null);
    setAgentsEditorError(null);
    setShowAgentsEditor(false);
    setShowAgentsModal(true);
  }, []);

  const openScheduleModal = useCallback(() => {
    void agent
      .listSchedules()
      .then((latest) => {
        setSchedules(latest);
        setScheduleSearchQuery("");
        setScheduleModalIndex(0);
        setShowScheduleModal(true);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedules: ${message}`)]);
      });
  }, [agent]);

  const showScheduleDetails = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .getScheduleDaemonStatus()
        .then((status) => {
          setMessages((prev) => [...prev, buildAssistantEntry(formatScheduleDetails(schedule, status))]);
          setShowScheduleModal(false);
          setScheduleSearchQuery("");
          setTimeout(() => {
            try {
              scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
            } catch {
              /* */
            }
          }, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to load schedule details: ${message}`)]);
        });
    },
    [agent],
  );

  const removeSchedule = useCallback(
    (schedule: StoredSchedule) => {
      void agent
        .removeSchedule(schedule.id)
        .then(async (message) => {
          const latest = await agent.listSchedules();
          setSchedules(latest);
          setScheduleModalIndex((index) => Math.max(0, Math.min(index, Math.max(0, latest.length - 1))));
          setMessages((prev) => [...prev, buildAssistantEntry(message)]);
          setTimeout(() => {
            try {
              scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
            } catch {
              /* */
            }
          }, 10);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          setMessages((prev) => [...prev, buildAssistantEntry(`Failed to remove schedule: ${message}`)]);
        });
    },
    [agent],
  );

  const openSubagentEditor = useCallback((agent: CustomSubagentConfig | null) => {
    setEditingSubagent(agent);
    if (agent) {
      setAgentsEditorDraft({ name: agent.name, instruction: agent.instruction });
      setAgentsEditorModelIndex(
        Math.max(
          0,
          MODELS.findIndex((model) => model.id === normalizeModelId(agent.model)),
        ),
      );
    } else {
      setAgentsEditorDraft({ name: "", instruction: "" });
      setAgentsEditorModelIndex(
        Math.max(
          0,
          MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
        ),
      );
    }
    setAgentsEditorField("name");
    setAgentsEditorError(null);
    setAgentsEditorSyncKey((n) => n + 1);
    setShowAgentsEditor(true);
    setShowAgentsModal(true);
  }, []);

  const openFleetEditor = useCallback(
    (definition: AgentDefinition | null) => {
      setEditingSubagent(null);
      if (!definition) {
        setEditingFile({ definition: null, scope: "project", originalModel: "inherit" });
        setAgentsEditorDraft({ name: "", instruction: "" });
        setAgentsEditorModelIndex(
          Math.max(
            0,
            MODELS.findIndex((model) => model.id === DEFAULT_MODEL),
          ),
        );
      } else if (definition.source === "settings") {
        setEditingFile(null);
        openSubagentEditor({
          name: definition.name,
          model: definition.model === "inherit" ? getCurrentModel() : definition.model,
          instruction: definition.body,
        });
        return;
      } else {
        const scope = definition.source === "project" ? "project" : "global";
        setEditingFile({
          definition,
          scope: definition.source === "builtin" ? "project" : scope,
          originalModel: definition.model,
        });
        setAgentsEditorDraft({ name: definition.name, instruction: definition.body });
        const modelId = definition.model === "inherit" ? getCurrentModel() : definition.model;
        setAgentsEditorModelIndex(
          Math.max(
            0,
            MODELS.findIndex((model) => model.id === normalizeModelId(modelId)),
          ),
        );
      }
      setAgentsEditorField("name");
      setAgentsEditorError(null);
      setAgentsEditorSyncKey((n) => n + 1);
      setShowAgentsEditor(true);
      setShowAgentsModal(true);
    },
    [openSubagentEditor],
  );

  const submitSubagentEditor = useCallback(() => {
    if (editingFile) {
      const name = (subagentNameRef.current?.plainText || "").trim();
      const instruction = subagentInstructionRef.current?.plainText || "";
      const model = MODELS[agentsEditorModelIndex]?.id;

      if (!name) {
        setAgentsEditorError("Name is required.");
        return;
      }
      if (!model || !getModelIds().includes(model)) {
        setAgentsEditorError("Pick a valid model.");
        return;
      }
      const clash = agentDefinitions.find(
        (item) =>
          item.name.toLowerCase() === name.toLowerCase() &&
          item.name.toLowerCase() !== (editingFile.definition?.name.toLowerCase() ?? ""),
      );
      if (clash) {
        setAgentsEditorError(`Another sub-agent already uses this name (${clash.source}).`);
        return;
      }

      const cwd = process.cwd();
      const resolvedModel =
        editingFile.originalModel === "inherit" && normalizeModelId(model) === normalizeModelId(getCurrentModel())
          ? "inherit"
          : model;
      const input: AgentFileInput = {
        description: editingFile.definition?.description ?? "",
        model: resolvedModel,
        tools: editingFile.definition?.tools ?? null,
        maxTurns: editingFile.definition?.maxTurns ?? null,
        color: editingFile.definition?.color ?? null,
        hidden: editingFile.definition?.hidden ?? false,
        enabled: true,
        mode: editingFile.definition?.mode ?? "subagent",
        promptMode: editingFile.definition?.promptMode ?? "replace",
        body: instruction,
      };
      if (
        editingFile.definition &&
        editingFile.definition.source !== "builtin" &&
        editingFile.definition.name.toLowerCase() !== name.toLowerCase()
      ) {
        deleteAgentFile(editingFile.scope, cwd, editingFile.definition.name);
      }
      writeAgentFile(editingFile.scope, cwd, name, input);
      setAgentDefinitions(loadAgentDefinitions(cwd));
      setShowAgentsEditor(false);
      setEditingFile(null);
      setAgentsEditorError(null);
      setAgentsModalIndex(0);
      return;
    }

    const name = (subagentNameRef.current?.plainText || "").trim();
    const instruction = subagentInstructionRef.current?.plainText || "";
    const model = MODELS[agentsEditorModelIndex]?.id;

    if (!name) {
      setAgentsEditorError("Name is required.");
      return;
    }
    if (isReservedSubagentName(name)) {
      setAgentsEditorError('Names "general" and "explore" are reserved.');
      return;
    }
    if (!model || !getModelIds().includes(model)) {
      setAgentsEditorError("Pick a valid model.");
      return;
    }

    const next = [...subAgents];
    if (editingSubagent) {
      const index = next.findIndex((item) => item.name === editingSubagent.name);
      if (index >= 0) next.splice(index, 1);
    }

    if (next.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setAgentsEditorError("Another sub-agent already uses this name.");
      return;
    }

    next.push({ name, model, instruction });
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
  }, [agentDefinitions, agentsEditorModelIndex, editingFile, editingSubagent, subAgents]);

  const removeEditingSubagent = useCallback(() => {
    if (editingFile) {
      const cwd = process.cwd();
      const definition = editingFile.definition;
      if (definition) {
        if (definition.source === "builtin") {
          disableBuiltinAgent("global", cwd, definition.name);
        } else {
          deleteAgentFile(editingFile.scope, cwd, definition.name);
        }
      }
      setAgentDefinitions(loadAgentDefinitions(cwd));
      setShowAgentsEditor(false);
      setEditingFile(null);
      setAgentsEditorError(null);
      setAgentsModalIndex(0);
      return;
    }
    if (!editingSubagent) return;

    const next = subAgents.filter((item) => item.name !== editingSubagent.name);
    saveUserSettings({ subAgents: next });
    setSubAgents(loadValidSubAgents());
    setShowAgentsEditor(false);
    setEditingSubagent(null);
    setAgentsEditorError(null);
    setAgentsModalIndex(0);
  }, [editingFile, editingSubagent, subAgents]);

  const submitMcpEditor = useCallback(() => {
    const draft: McpEditorDraft = {
      label: mcpLabelRef.current?.plainText || "",
      transport: mcpEditorDraft.transport,
      url: mcpUrlRef.current?.plainText || "",
      headersText: mcpHeadersRef.current?.plainText || "",
      command: mcpCommandRef.current?.plainText || "",
      argsText: mcpArgsRef.current?.plainText || "",
      cwd: mcpCwdRef.current?.plainText || "",
      envText: mcpEnvRef.current?.plainText || "",
    };

    const baseId = toMcpServerId(draft.label);
    const currentServers = loadMcpServers();

    const conflictingServer = currentServers.find((s) => s.id === baseId && s.id !== editingMcpId);
    if (conflictingServer) {
      setMcpEditorError(`Only one protocol is supported per MCP. Edit "${conflictingServer.label}" instead.`);
      return;
    }

    const id = editingMcpId ?? baseId;

    const server: McpServerConfig = {
      id,
      label: draft.label.trim(),
      enabled: true,
      transport: draft.transport,
      ...(draft.transport === "stdio"
        ? {
            command: draft.command.trim(),
            args: draft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: draft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }
        : {
            url: draft.url.trim(),
            headers: Object.keys(parseHeaderLines(draft.headersText)).length
              ? parseHeaderLines(draft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(draft.envText)).length ? parseEnvLines(draft.envText) : undefined,
          }),
    };

    const validation = validateMcpServerConfig(server);
    if (!validation.ok) {
      setMcpEditorError(validation.error);
      return;
    }

    const nextServers = editingMcpId
      ? currentServers.map((item) =>
          item.id === editingMcpId ? { ...server, id: editingMcpId, enabled: item.enabled } : item,
        )
      : [...currentServers, server];
    saveMcpServers(nextServers);
    setMcpServers(nextServers);
    setShowMcpEditor(false);
    setEditingMcpId(null);
    setMcpEditorError(null);
    setMcpSearchQuery("");
    setMcpModalIndex(
      Math.max(
        0,
        nextServers.findIndex((item) => item.id === (editingMcpId ?? server.id)),
      ),
    );
  }, [editingMcpId, mcpEditorDraft.transport]);

  const cycleMcpEditorTransport = useCallback(
    (direction: 1 | -1 = 1) => {
      const draft = snapshotMcpEditorDraft();
      const order: Array<McpRemoteTransport | "stdio"> = ["stdio", "http", "sse"];
      const currentIndex = order.indexOf(draft.transport);
      const nextTransport = order[(currentIndex + direction + order.length) % order.length];
      const nextDraft = { ...draft, transport: nextTransport };
      setMcpEditorDraft(nextDraft);
      setMcpEditorField("transport");
      setMcpEditorSyncKey((n) => n + 1);

      if (!editingMcpId) return;

      const existing = mcpServers.find((server) => server.id === editingMcpId);
      if (!existing) return;

      const optimisticServer: McpServerConfig = {
        id: existing.id,
        label: nextDraft.label.trim() || existing.label,
        enabled: existing.enabled,
        transport: nextTransport,
        ...(nextTransport === "stdio"
          ? {
              command: nextDraft.command.trim() || existing.command,
              args: nextDraft.argsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              cwd: nextDraft.cwd.trim() || undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }
          : {
              url: nextDraft.url.trim() || existing.url,
              headers: Object.keys(parseHeaderLines(nextDraft.headersText)).length
                ? parseHeaderLines(nextDraft.headersText)
                : undefined,
              env: Object.keys(parseEnvLines(nextDraft.envText)).length ? parseEnvLines(nextDraft.envText) : undefined,
            }),
      };

      syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? optimisticServer : server)));
    },
    [editingMcpId, mcpServers, snapshotMcpEditorDraft, syncStoredMcpServers],
  );

  useEffect(() => {
    if (!showMcpEditor || !editingMcpId) return;

    const existing = mcpServers.find((server) => server.id === editingMcpId);
    if (!existing) return;
    if (existing.transport === mcpEditorDraft.transport) return;

    const syncedServer: McpServerConfig = {
      id: existing.id,
      label: mcpEditorDraft.label.trim() || existing.label,
      enabled: existing.enabled,
      transport: mcpEditorDraft.transport,
      ...(mcpEditorDraft.transport === "stdio"
        ? {
            command: mcpEditorDraft.command.trim() || undefined,
            args: mcpEditorDraft.argsText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: mcpEditorDraft.cwd.trim() || undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }
        : {
            url: mcpEditorDraft.url.trim() || undefined,
            headers: Object.keys(parseHeaderLines(mcpEditorDraft.headersText)).length
              ? parseHeaderLines(mcpEditorDraft.headersText)
              : undefined,
            env: Object.keys(parseEnvLines(mcpEditorDraft.envText)).length
              ? parseEnvLines(mcpEditorDraft.envText)
              : undefined,
          }),
    };

    syncStoredMcpServers(mcpServers.map((server) => (server.id === editingMcpId ? syncedServer : server)));
  }, [editingMcpId, mcpEditorDraft, mcpServers, showMcpEditor, syncStoredMcpServers]);

  useEffect(() => {
    setMcpModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, mcpRows.length - 1))));
  }, [mcpRows.length]);

  useEffect(() => {
    setScheduleModalIndex((idx) => Math.max(0, Math.min(idx, Math.max(0, scheduleRows.length - 1))));
  }, [scheduleRows.length]);

  const scrollToBottom = useCallback(() => {
    try {
      scrollRef.current?.scrollTo(scrollRef.current?.scrollHeight ?? 99999);
    } catch {
      /* */
    }
  }, []);

  const clearLiveTurnUi = useCallback(() => {
    setStreamContent("");
    setStreamReasoning("");
    setThoughtSummary(null);
    thoughtDoneRef.current = false;
    reasoningAccRef.current = "";
    setActiveToolCalls([]);
    setActiveSubagent(null);
    setLiveTurnSourceLabel(null);
    contentAccRef.current = "";
    for (const item of questionQueueRef.current) {
      item.reject(new Error("turn ended"));
    }
    questionQueueRef.current = [];
    setPendingQuestion(null);
  }, []);

  const finishTurnProcessing = useCallback(() => {
    const nextQueued = queuedMessagesRef.current.shift();
    if (nextQueued) {
      if (nextQueued.inboxId != null) agent.acknowledgeFollowUp(nextQueued.inboxId);
      setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));
      isProcessingRef.current = false;
      void processMessageRef.current(nextQueued.text, nextQueued.displayText);
      return;
    }

    isProcessingRef.current = false;
    setIsProcessing(false);
  }, [agent]);

  const beginLiveTurn = useCallback(
    (turn: Omit<ActiveTurnState, "latestAssistantText" | "flushedAssistantChars">) => {
      clearLiveTurnUi();
      activeTurnRef.current = {
        ...turn,
        latestAssistantText: "",
        flushedAssistantChars: 0,
      };
      isProcessingRef.current = true;
      setIsProcessing(true);
      setLiveTurnSourceLabel(turn.sourceLabel ?? null);
      startTimeRef.current = Date.now();
    },
    [clearLiveTurnUi],
  );

  const markThinkingDone = useCallback(() => {
    if (thoughtDoneRef.current) return;
    thoughtDoneRef.current = true;
    const startedAt = startTimeRef.current;
    setThoughtSummary({
      durationMs: startedAt > 0 ? Date.now() - startedAt : 0,
    });
  }, []);

  const flushPendingAssistantMessage = useCallback(() => {
    const activeTurn = activeTurnRef.current;
    if (!activeTurn) return;

    const cleaned = sanitizeContent(contentAccRef.current);
    if (!cleaned) {
      contentAccRef.current = "";
      setStreamContent("");
      if (activeTurn.kind === "telegram") {
        activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
      }
      return;
    }

    setMessages((prev) => [
      ...prev,
      buildAssistantEntry(cleaned, {
        modeColor: activeTurn.modeColor,
        remoteKey: activeTurn.remoteKey,
        sourceLabel: activeTurn.sourceLabel,
      }),
    ]);

    if (activeTurn.kind === "telegram") {
      activeTurn.flushedAssistantChars = activeTurn.latestAssistantText.length;
    }

    contentAccRef.current = "";
    setStreamContent("");
  }, []);

  const applyLocalAssistantDelta = useCallback(
    (delta: string) => {
      contentAccRef.current += delta;
      setStreamContent(sanitizeContent(contentAccRef.current));
      setTimeout(scrollToBottom, 10);
    },
    [scrollToBottom],
  );

  const applyTelegramAssistantPreview = useCallback(
    (fullContent: string) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn || activeTurn.kind !== "telegram") return;

      activeTurn.latestAssistantText = fullContent;
      contentAccRef.current = getUnflushedTelegramAssistantContent(fullContent, activeTurn.flushedAssistantChars);
      setStreamContent(sanitizeContent(contentAccRef.current));
      setTimeout(scrollToBottom, 10);
    },
    [scrollToBottom],
  );

  const showLiveToolCalls = useCallback(
    (toolCalls: ToolCall[]) => {
      flushPendingAssistantMessage();
      setActiveToolCalls(toolCalls);
      setTimeout(scrollToBottom, 10);
    },
    [flushPendingAssistantMessage, scrollToBottom],
  );

  const appendLiveToolResult = useCallback(
    (toolCall: ToolCall, toolResult: ToolResult) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) return;

      setMessages((prev) => [
        ...prev,
        buildToolResultEntry(toolCall, toolResult, {
          modeColor: activeTurn.modeColor,
          remoteKey: activeTurn.remoteKey,
          sourceLabel: activeTurn.sourceLabel,
        }),
      ]);

      if (toolResult.plan?.questions?.length) {
        setActivePlan(toolResult.plan);
        setPqs(initialPlanQuestionsState());
      }

      setActiveToolCalls([]);
      setTimeout(scrollToBottom, 10);
    },
    [scrollToBottom],
  );

  const syncTelegramTurnEntries = useCallback((activeTurn: ActiveTurnState) => {
    if (activeTurn.kind !== "telegram" || activeTurn.userId === undefined || !activeTurn.remoteKey) return;

    const currentEntries = activeTurn.agent.getChatEntries();
    const syncedCount = telegramEntryCountsRef.current.get(activeTurn.userId) ?? 0;
    if (currentEntries.length <= syncedCount) return;

    const delta = decorateTelegramEntries(currentEntries.slice(syncedCount), activeTurn.userId, activeTurn.remoteKey);
    telegramEntryCountsRef.current.set(activeTurn.userId, currentEntries.length);
    setMessages((prev) => replaceTurnEntries(prev, activeTurn.remoteKey!, delta));
  }, []);

  const finalizeActiveTurn = useCallback(
    ({ wasInterrupted = false, hadError = false }: { wasInterrupted?: boolean; hadError?: boolean } = {}) => {
      const activeTurn = activeTurnRef.current;
      if (!activeTurn) {
        finishTurnProcessing();
        return;
      }

      const finalContent = sanitizeContent(contentAccRef.current);
      if (!wasInterrupted && finalContent) {
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(finalContent, {
            modeColor: activeTurn.modeColor,
            remoteKey: activeTurn.remoteKey,
            sourceLabel: activeTurn.sourceLabel,
          }),
        ]);
      }

      if (!wasInterrupted && !hadError) {
        if (activeTurn.kind === "local" && activeTurn.agent.getSessionId()) {
          setMessages((prev) => {
            const fresh = activeTurn.agent.getChatEntries();
            let prevUserIdx = 0;
            for (let i = 0; i < fresh.length; i++) {
              if (fresh[i]!.type !== "user") continue;
              while (prevUserIdx < prev.length && prev[prevUserIdx]!.type !== "user") prevUserIdx++;
              if (prevUserIdx < prev.length) {
                fresh[i] = { ...fresh[i]!, content: prev[prevUserIdx]!.content };
                prevUserIdx++;
              }
            }
            return fresh;
          });
          setSessionTitle(activeTurn.agent.getSessionTitle());
          setSessionId(activeTurn.agent.getSessionId());
        } else if (activeTurn.kind === "telegram") {
          syncTelegramTurnEntries(activeTurn);
        }
      }

      activeTurnRef.current = null;
      clearLiveTurnUi();
      finishTurnProcessing();
      setTimeout(scrollToBottom, 50);
    },
    [clearLiveTurnUi, finishTurnProcessing, scrollToBottom, syncTelegramTurnEntries],
  );

  const wireTelegramAgentUi = useCallback((userId: number, telegramAgent: Agent) => {
    if (!telegramEntryCountsRef.current.has(userId)) {
      telegramEntryCountsRef.current.set(userId, telegramAgent.getChatEntries().length);
    }

    if (telegramSubagentUnsubsRef.current.has(userId)) {
      return;
    }

    const unsubscribe = telegramAgent.onSubagentStatus((status) => {
      if (activeTurnRef.current?.agent !== telegramAgent) return;
      setActiveSubagent(status);
    });
    telegramSubagentUnsubsRef.current.set(userId, unsubscribe);
  }, []);

  const getTelegramAgent = useCallback(
    (userId: number) => {
      const map = telegramAgentsRef.current;
      const existing = map.get(userId);
      if (existing) {
        wireTelegramAgentUi(userId, existing);
        return existing;
      }

      const selected = getSelectedProvider();
      if (!selected) {
        throw new Error("No provider selected. Use /connect to choose a provider first.");
      }

      const u = loadUserSettings();
      const sid = u.telegram?.sessionsByUserId?.[String(userId)];
      const a = new Agent(selected.apiKey, selected.provider.baseUrl, selected.modelId, startupConfig.maxToolRounds, {
        session: sid,
        sandboxMode,
        sandboxSettings,
        providerId: selected.provider.id,
      });
      if (!sid && a.getSessionId()) {
        saveUserSettings({
          telegram: {
            ...u.telegram,
            sessionsByUserId: {
              ...u.telegram?.sessionsByUserId,
              [String(userId)]: a.getSessionId()!,
            },
          },
        });
      }
      wireTelegramAgentUi(userId, a);
      map.set(userId, a);
      return a;
    },
    [sandboxMode, sandboxSettings, startupConfig, wireTelegramAgentUi],
  );

  const appendTelegramUserMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string }) => {
      const telegramAgent = getTelegramAgent(event.userId);
      beginLiveTurn({
        kind: "telegram",
        agent: telegramAgent,
        remoteKey: event.turnKey,
        userId: event.userId,
        sourceLabel: getTelegramSourceLabel("assistant", event.userId),
      });
      setMessages((prev) => [
        ...prev,
        buildUserEntry(event.content, {
          remoteKey: event.turnKey,
          sourceLabel: getTelegramSourceLabel("user", event.userId),
        }),
      ]);
      setTimeout(scrollToBottom, 10);
    },
    [beginLiveTurn, getTelegramAgent, scrollToBottom],
  );

  const upsertTelegramAssistantMessage = useCallback(
    (event: { turnKey: string; userId: number; content: string; done: boolean }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }

      applyTelegramAssistantPreview(event.content);
      if (event.done) {
        finalizeActiveTurn();
      }
    },
    [applyTelegramAssistantPreview, beginLiveTurn, finalizeActiveTurn, getTelegramAgent],
  );

  const showTelegramToolCalls = useCallback(
    (event: { turnKey: string; userId: number; toolCalls: ToolCall[] }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      showLiveToolCalls(event.toolCalls);
    },
    [beginLiveTurn, getTelegramAgent, showLiveToolCalls],
  );

  const appendTelegramToolResult = useCallback(
    (event: { turnKey: string; userId: number; toolCall: ToolCall; toolResult: ToolResult }) => {
      if (activeTurnRef.current?.remoteKey !== event.turnKey) {
        const telegramAgent = getTelegramAgent(event.userId);
        beginLiveTurn({
          kind: "telegram",
          agent: telegramAgent,
          remoteKey: event.turnKey,
          userId: event.userId,
          sourceLabel: getTelegramSourceLabel("assistant", event.userId),
        });
      }
      appendLiveToolResult(event.toolCall, event.toolResult);
    },
    [appendLiveToolResult, beginLiveTurn, getTelegramAgent],
  );

  const startTelegramBridge = useCallback(() => {
    const token = getTelegramBotToken();
    if (!token || !getSelectedProvider()) return;
    if (bridgeRef.current) return;

    const bridge = createTelegramBridge({
      token,
      getApprovedUserIds: () => loadUserSettings().telegram?.approvedUserIds ?? [],
      coordinator: coordinatorRef.current,
      getTelegramAgent,
      onUserMessage: appendTelegramUserMessage,
      onAssistantMessage: upsertTelegramAssistantMessage,
      onToolCalls: showTelegramToolCalls,
      onToolResult: appendTelegramToolResult,
      onError: (msg) => {
        setMessages((p) => [...p, { type: "assistant", content: `Telegram: ${msg}`, timestamp: new Date() }]);
      },
    });
    bridgeRef.current = bridge;
    bridge.start();
  }, [
    appendTelegramToolResult,
    appendTelegramUserMessage,
    getTelegramAgent,
    showTelegramToolCalls,
    upsertTelegramAssistantMessage,
  ]);

  /** Start long polling when a bot token is already saved (pairing UI is optional if already approved). */
  useEffect(() => {
    if (!hasApiKey) return;
    if (!getTelegramBotToken()) return;
    startTelegramBridge();
  }, [hasApiKey, startTelegramBridge]);

  const handleExit = useCallback(() => {
    void bridgeRef.current?.stop();
    bridgeRef.current = null;
    onExit?.();
  }, [onExit]);

  const showCopyBanner = useCallback(() => {
    setCopyFlashId((n) => n + 1);
  }, []);

  /** Match OpenCode: OSC 52 + real OS clipboard; used from keyboard and root onMouseUp. */
  const copyTuiSelectionToHost = useCallback((): boolean => {
    if (!renderer.hasSelection) return false;
    const sel = renderer.getSelection();
    const text = sel ? getCompactTuiSelectionText(sel) : "";
    if (!text) return false;
    renderer.copyToClipboardOSC52(text);
    copyTextToHostClipboard(text);
    renderer.clearSelection();
    showCopyBanner();
    return true;
  }, [renderer, showCopyBanner]);

  const handleRootMouseUp = useCallback(() => {
    copyTuiSelectionToHost();
  }, [copyTuiSelectionToHost]);

  useEffect(() => {
    if (copyFlashId === 0) return;
    const id = setTimeout(() => setCopyFlashId(0), 2000);
    return () => clearTimeout(id);
  }, [copyFlashId]);

  const providerRows: ProviderDefinition[] = getAllProviders(customProviders);
  const openProviderConnect = useCallback(() => {
    showProviderModalRef.current = true;
    setProviderError(null);
    setProviderStep("list");
    setProviderIndex(0);
    setProviderLoading(false);
    setShowProviderModal(true);
  }, []);

  const applyProviderSelection = useCallback(
    (providerId: string, apiKey: string, modelId: string) => {
      const selection = selectProvider(providerId, modelId);
      if (!selection) return;
      agent.setProvider(providerId, apiKey, selection.provider.baseUrl, selection.modelId);
      setSelectedProviderId(providerId);
      setModel(selection.modelId);
      hasApiKeyRef.current = true;
      setHasApiKey(true);
      setProviderFetchedModels(null);
      setMessages((prev) => [
        ...prev,
        buildAssistantEntry(
          `Connected to ${selection.provider.name}. Model: ${selection.modelId}. Use /models to change the model.`,
        ),
      ]);
    },
    [agent],
  );

  const finishCustomProvider = useCallback(
    (modelIds: string[], defaultModelId: string, modelName?: string) => {
      const id = customDraft.id;
      const models = [...new Set(modelIds.map((model) => model.trim()).filter((model) => model !== ""))];
      if (models.length === 0) return;
      const custom: CustomProvider = {
        id,
        name: customDraft.name || id,
        baseUrl: normalizeBaseUrl(customDraft.baseUrl),
        models,
        ...(modelName && modelName !== defaultModelId ? { modelNames: { [defaultModelId]: modelName } } : {}),
      };
      const next = [...customProviders.filter((provider) => provider.id !== id), custom];
      saveCustomProviders(next);
      setCustomProviders(next);
      saveProviderApiKey(id, customDraft.apiKey);
      providerInputRef.current?.clear();
      showProviderModalRef.current = false;
      setShowProviderModal(false);
      setProviderError(null);
      applyProviderSelection(id, customDraft.apiKey, defaultModelId);
    },
    [applyProviderSelection, customDraft, customProviders],
  );

  const selectProviderRow = useCallback(() => {
    const rows = getAllProviders(customProviders);
    if (providerIndex >= rows.length) {
      setCustomDraft({ id: "", name: "", baseUrl: "", apiKey: "", modelId: "" });
      setProviderStep("customId");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    const provider = rows[providerIndex];
    if (!provider) return;
    setProviderSelectedId(provider.id);
    const savedKey = getProviderApiKey(provider.id);
    if (savedKey) {
      const selection = selectProvider(provider.id);
      if (selection) {
        showProviderModalRef.current = false;
        setShowProviderModal(false);
        applyProviderSelection(provider.id, savedKey, selection.modelId);
      }
      return;
    }
    setProviderStep("key");
    setProviderError(null);
    providerInputRef.current?.clear();
  }, [applyProviderSelection, customProviders, providerIndex]);

  const selectCustomModel = useCallback(() => {
    const modelId = customFetchedModels[providerIndex];
    if (modelId) finishCustomProvider(customFetchedModels, modelId);
  }, [customFetchedModels, finishCustomProvider, providerIndex]);

  const selectModelSource = useCallback(() => {
    if (providerIndex === 1) {
      setProviderStep("customModel");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    setProviderLoading(true);
    setProviderError(null);
    providerInputRef.current?.clear();
    fetchProviderModels(customDraft.baseUrl, customDraft.apiKey)
      .then((ids) => {
        setProviderLoading(false);
        if (ids.length > 0) {
          setCustomFetchedModels(ids);
          setProviderIndex(0);
          setProviderStep("customModelList");
        } else {
          setProviderError(
            "Could not load models from this base URL. Check the base URL and API key, then enter a model id manually.",
          );
          setProviderStep("customModel");
        }
      })
      .catch(() => {
        setProviderLoading(false);
        setProviderError(
          "Could not load models from this base URL. Check the base URL and API key, then enter a model id manually.",
        );
        setProviderStep("customModel");
      });
  }, [customDraft.apiKey, customDraft.baseUrl, providerIndex]);

  const openProviderModels = useCallback(() => {
    const selected = getSelectedProvider();
    if (!selected) {
      setMessages((prev) => [
        ...prev,
        buildAssistantEntry("You have not selected a provider yet. Use /connect to choose a provider first."),
      ]);
      return;
    }
    setSelectedProviderId(selected.provider.id);
    setProviderFetchedModels(null);
    setShowModelPicker(true);
    setModelPickerIndex(0);
    setModelSearchQuery("");
    fetchProviderModels(selected.provider.baseUrl, selected.apiKey)
      .then((ids) => {
        if (ids.length === 0) return;
        setProviderFetchedModels(ids);
        const isCustom = customProviders.some((provider) => provider.id === selected.provider.id);
        if (!isCustom) return;
        const saved = loadCustomProviders();
        const target = saved.find((provider) => provider.id === selected.provider.id);
        if (!target) return;
        const merged = mergeModelIds(target.models, ids);
        if (merged.length === target.models.length) return;
        const next = saved.map((provider) => (provider.id === target.id ? { ...provider, models: merged } : provider));
        saveCustomProviders(next);
        setCustomProviders(next);
      })
      .catch(() => {});
  }, [customProviders]);

  const closeProviderModal = useCallback(() => {
    showProviderModalRef.current = false;
    setProviderError(null);
    setShowProviderModal(false);
  }, []);

  const submitProviderStep = useCallback(() => {
    const input = (providerInputRef.current?.plainText || "").trim();
    if (providerStep === "key") {
      if (!input) {
        setProviderError("Enter an API key to continue.");
        return;
      }
      const providerId = providerSelectedId;
      if (!providerId) {
        setProviderError("Choose a provider first.");
        return;
      }
      saveProviderApiKey(providerId, input);
      providerInputRef.current?.clear();
      showProviderModalRef.current = false;
      setShowProviderModal(false);
      setProviderError(null);
      const selection = selectProvider(providerId);
      if (selection) applyProviderSelection(providerId, input, selection.modelId);
      return;
    }
    if (providerStep === "customId") {
      if (!input) {
        setProviderError("Enter an id for the custom provider.");
        return;
      }
      const id = input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!id) {
        setProviderError("Enter an id using letters and numbers.");
        return;
      }
      if (findProvider(id, customProviders)) {
        setProviderError("A provider with this id already exists.");
        return;
      }
      setCustomDraft((draft) => ({ ...draft, id }));
      setProviderStep("customName");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    if (providerStep === "customName") {
      setCustomDraft((draft) => ({ ...draft, name: input || draft.id }));
      setProviderStep("customBaseUrl");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    if (providerStep === "customBaseUrl") {
      if (!input.startsWith("http://") && !input.startsWith("https://")) {
        setProviderError("Enter a base URL starting with http:// or https://.");
        return;
      }
      setCustomDraft((draft) => ({ ...draft, baseUrl: normalizeBaseUrl(input) }));
      setProviderStep("customKey");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    if (providerStep === "customKey") {
      if (!input) {
        setProviderError("Enter an API key to continue.");
        return;
      }
      setCustomDraft((draft) => ({ ...draft, apiKey: input }));
      setProviderStep("customModelSource");
      setProviderError(null);
      setProviderIndex(0);
      providerInputRef.current?.clear();
      return;
    }
    if (providerStep === "customModel") {
      if (!input) {
        setProviderError("Enter a model id, or go back and fetch models from the base URL.");
        return;
      }
      setCustomDraft((draft) => ({ ...draft, modelId: input }));
      setProviderStep("customModelName");
      setProviderError(null);
      providerInputRef.current?.clear();
      return;
    }
    if (providerStep === "customModelName") {
      finishCustomProvider([customDraft.modelId], customDraft.modelId, input || customDraft.modelId);
      return;
    }
  }, [applyProviderSelection, customDraft, customProviders, finishCustomProvider, providerSelectedId, providerStep]);

  useEffect(() => {
    hasApiKeyRef.current = hasApiKey;
  }, [hasApiKey]);

  useEffect(() => {
    showProviderModalRef.current = showProviderModal;
  }, [showProviderModal]);

  useEffect(() => {
    showConnectModalRef.current = showConnectModal;
  }, [showConnectModal]);
  useEffect(() => {
    showTelegramTokenModalRef.current = showTelegramTokenModal;
  }, [showTelegramTokenModal]);
  useEffect(() => {
    showTelegramPairModalRef.current = showTelegramPairModal;
  }, [showTelegramPairModal]);
  useEffect(() => {
    showMcpModalRef.current = showMcpModal;
  }, [showMcpModal]);
  useEffect(() => {
    showMcpEditorRef.current = showMcpEditor;
  }, [showMcpEditor]);
  useEffect(() => {
    showAgentsModalRef.current = showAgentsModal;
  }, [showAgentsModal]);
  useEffect(() => {
    showAgentsEditorRef.current = showAgentsEditor;
  }, [showAgentsEditor]);
  useEffect(() => {
    showScheduleModalRef.current = showScheduleModal;
  }, [showScheduleModal]);
  useEffect(() => {
    showUpdateModalRef.current = showUpdateModal;
  }, [showUpdateModal]);

  useEffect(() => {
    let cancelled = false;
    checkForUpdate(startupConfig.version).then((result) => {
      if (cancelled || !result?.hasUpdate) return;
      setUpdateInfo(result);
      setShowUpdateModal(true);
    });
    return () => {
      cancelled = true;
    };
  }, [startupConfig.version]);

  useEffect(() => {
    return () => {
      void bridgeRef.current?.stop();
      bridgeRef.current = null;
    };
  }, []);

  const submitTelegramToken = useCallback(() => {
    const token = (telegramTokenInputRef.current?.plainText || "").trim();
    if (!token) {
      setTelegramTokenError("Paste your bot token from @BotFather.");
      return;
    }
    if (!hasApiKeyRef.current) {
      setTelegramTokenError("Choose a provider first with /connect.");
      return;
    }
    const u = loadUserSettings();
    saveUserSettings({ telegram: { ...u.telegram, botToken: token } });
    telegramTokenInputRef.current?.clear();
    setShowTelegramTokenModal(false);
    setTelegramTokenError(null);
    startTelegramBridge();
    setShowTelegramPairModal(true);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content:
          "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
        timestamp: new Date(),
      },
    ]);
  }, [startTelegramBridge]);

  const submitTelegramPair = useCallback(async () => {
    const code = (telegramPairInputRef.current?.plainText || "").trim();
    if (!code) {
      setTelegramPairError("Enter the pairing code.");
      return;
    }
    const result = approvePairingCode(code);
    if (!result.ok) {
      setTelegramPairError(result.error);
      return;
    }
    saveApprovedTelegramUserId(result.userId);
    telegramPairInputRef.current?.clear();
    setShowTelegramPairModal(false);
    setTelegramPairError(null);
    setMessages((p) => [
      ...p,
      {
        type: "assistant",
        content: `Telegram user ${result.userId} paired. Keep this CLI open while you use the bot.`,
        timestamp: new Date(),
      },
    ]);
    try {
      await bridgeRef.current?.sendDm(result.userId, "Pairing approved. You can message Crow here.");
    } catch {
      /* optional DM */
    }
  }, []);

  const beginTelegramFromConnect = useCallback(() => {
    setShowConnectModal(false);
    if (!hasApiKeyRef.current) {
      setMessages((p) => [
        ...p,
        { type: "assistant", content: "Choose a provider first with /connect.", timestamp: new Date() },
      ]);
      openProviderConnect();
      return;
    }
    if (!getTelegramBotToken()) {
      setShowTelegramTokenModal(true);
      setTelegramTokenError(null);
      return;
    }
    startTelegramBridge();
    const alreadyPaired = (loadUserSettings().telegram?.approvedUserIds?.length ?? 0) > 0;
    if (!alreadyPaired) {
      setShowTelegramPairModal(true);
      setTelegramPairError(null);
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content:
            "Telegram polling started. In Telegram, DM your bot and send /pair. Copy the code, then enter it below.",
          timestamp: new Date(),
        },
      ]);
    } else {
      setMessages((p) => [
        ...p,
        {
          type: "assistant",
          content: "Telegram polling is running. Your chat is already paired.",
          timestamp: new Date(),
        },
      ]);
    }
  }, [openProviderConnect, startTelegramBridge]);

  const interruptActiveRun = useCallback(
    (key?: KeyEvent) => {
      if (
        permissionQueueRef.current.length > 0 ||
        Date.now() - permissionAnsweredAtRef.current < 1000 ||
        questionQueueRef.current.length > 0 ||
        Date.now() - questionAnsweredAtRef.current < 1000
      )
        return false;
      if (btwStateRef.current) {
        btwAbortRef.current?.abort();
        btwAbortRef.current = null;
        btwStateRef.current = null;
        setBtwState(null);
        key?.preventDefault();
        key?.stopPropagation();
        return true;
      }
      if (!isProcessingRef.current) return false;
      key?.preventDefault();
      key?.stopPropagation();
      interruptedRunIdRef.current = activeRunIdRef.current;
      queuedMessagesRef.current = [];
      setQueuedMessages([]);
      agent.clearPendingFollowUps();
      const activeAgent = activeTurnRef.current?.agent ?? agent;
      activeTurnRef.current = null;
      clearLiveTurnUi();
      activeAgent.abort();
      return true;
    },
    [agent, clearLiveTurnUi],
  );

  useEffect(() => {
    const onInternalKey = (key: KeyEvent) => {
      if (isEscapeKey(key)) {
        interruptActiveRun(key);
      }
    };

    renderer._internalKeyInput.onInternal("keypress", onInternalKey);
    return () => {
      renderer._internalKeyInput.offInternal("keypress", onInternalKey);
    };
  }, [interruptActiveRun, renderer]);

  useEffect(() => {
    const onRawInput = (sequence: string) => {
      const parsed = parseKeypress(sequence, { useKittyKeyboard: renderer.useKittyKeyboard });
      if (parsed?.name === "escape" || sequence === "\u001b" || sequence === "\u001b\u001b") {
        return interruptActiveRun();
      }
      return false;
    };

    renderer.prependInputHandler(onRawInput);
    return () => {
      renderer.removeInputHandler(onRawInput);
    };
  }, [interruptActiveRun, renderer]);

  useEffect(() => {
    const onStdinData = (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (data.length === 1 && data[0] === 27) {
        interruptActiveRun();
      }
    };

    renderer.stdin.on("data", onStdinData);
    return () => {
      renderer.stdin.off("data", onStdinData);
    };
  }, [interruptActiveRun, renderer]);

  const resetToNewSession = useCallback(() => {
    agent.clearPendingFollowUps();
    const snapshot = agent.startNewSession();
    setMessages(snapshot?.entries ?? []);
    setExpandedMessages(new Set());
    activeTurnRef.current = null;
    clearLiveTurnUi();
    setSessionTitle(snapshot?.session.title ?? null);
    setSessionId(snapshot?.session.id ?? agent.getSessionId());
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
    replacePasteBlocks([]);
    queuedMessagesRef.current = [];
    setQueuedMessages([]);
  }, [agent, clearLiveTurnUi, replacePasteBlocks]);

  const processMessage = useCallback(
    async (text: string, displayText?: string) => {
      if (!text.trim() || isProcessingRef.current) return;
      const runId = ++activeRunIdRef.current;
      const isStale = () => activeRunIdRef.current !== runId;
      isProcessingRef.current = true;
      setIsProcessing(true);
      if (!sessionTitle)
        agent
          .generateTitle((displayText ?? text).trim())
          .then(setSessionTitle)
          .catch(() => {});
      await coordinatorRef.current.run(async () => {
        const color = modeInfoRef.current.color;
        beginLiveTurn({ kind: "local", agent, modeColor: color });
        setMessages((prev) => [...prev, buildUserEntry((displayText ?? text).trim(), { modeColor: color })]);
        setTimeout(scrollToBottom, 50);
        await new Promise((r) => setTimeout(r, 0));
        let turnHadError = false;
        let turnHadAuthError = false;
        try {
          for await (const chunk of agent.processMessage(text.trim())) {
            if (isStale()) {
              break;
            }

            switch (chunk.type) {
              case "content":
                markThinkingDone();
                applyLocalAssistantDelta(chunk.content || "");
                break;
              case "reasoning":
                reasoningAccRef.current += chunk.content || "";
                setStreamReasoning((p) => p + (chunk.content || ""));
                break;
              case "tool_calls":
                markThinkingDone();
                if (chunk.toolCalls) {
                  showLiveToolCalls(chunk.toolCalls);
                }
                break;
              case "tool_result":
                markThinkingDone();
                if (chunk.toolCall && chunk.toolResult) {
                  appendLiveToolResult(chunk.toolCall, chunk.toolResult);
                }
                break;
              case "tool_approval_request":
                if (chunk.toolCall && chunk.approvalId) {
                  let args: Record<string, string> = {};
                  try {
                    args = JSON.parse(chunk.toolCall.function.arguments);
                  } catch {
                    /* ignore */
                  }
                  const pc = chunk.paymentPrecheck;
                  setPendingPaymentApproval({
                    url: args?.url ?? "",
                    description: pc?.description ?? "",
                    security: pc?.security ?? "",
                    securityLabel: pc?.securityLabel ?? "",
                    securityUrl: pc?.securityUrl ?? "",
                    amount: pc?.amount ?? "",
                    network: pc?.network ?? "",
                    asset: pc?.asset ?? "",
                    approvalId: chunk.approvalId,
                    selected: 0,
                  });
                }
                break;
              case "error":
                markThinkingDone();
                turnHadError = true;
                if (chunk.isAuthError) {
                  turnHadAuthError = true;
                }
                contentAccRef.current += `\n${chunk.content || "Unknown error"}`;
                setStreamContent(contentAccRef.current);
                break;
              case "done":
                markThinkingDone();
                break;
            }
          }
        } catch {
          turnHadError = true;
          if (!isStale()) {
            contentAccRef.current += "\nAn unexpected error occurred.";
            setStreamContent(contentAccRef.current);
          }
        }
        const wasInterrupted = interruptedRunIdRef.current === runId;
        if (isStale()) {
          contentAccRef.current = "";
          return;
        }

        if (turnHadAuthError) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry("Your API key is invalid or expired. Use /connect to update it."),
          ]);
        }

        if (!isStale()) {
          finalizeActiveTurn({ wasInterrupted, hadError: turnHadError });
        }
        if (wasInterrupted) {
          interruptedRunIdRef.current = null;
        }
      });
    },
    [
      agent,
      appendLiveToolResult,
      applyLocalAssistantDelta,
      beginLiveTurn,
      finalizeActiveTurn,
      markThinkingDone,
      scrollToBottom,
      sessionTitle,
      showLiveToolCalls,
    ],
  );

  useEffect(() => {
    if (initialMessage && !processedInitial.current) {
      processedInitial.current = true;
      if (hasApiKey) {
        processMessage(initialMessage);
      } else {
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry("You have not selected a provider yet. Use /connect to choose a provider first."),
        ]);
      }
    }
  }, [hasApiKey, initialMessage, processMessage]);
  useEffect(() => {
    processMessageRef.current = processMessage;
  }, [processMessage]);
  const queueRestoredRef = useRef(false);
  useEffect(() => {
    if (queueRestoredRef.current) return;
    queueRestoredRef.current = true;
    const pending = agent.listPendingFollowUps();
    if (pending.length > 0) {
      queuedMessagesRef.current = pending.map((item) => ({
        text: item.text,
        displayText: item.displayText,
        inboxId: item.id,
      }));
      setQueuedMessages(pending.map((item) => item.displayText));
    }
  }, [agent]);
  useEffect(
    () =>
      agent.onSubagentStatus((status) => {
        if (activeTurnRef.current?.agent !== agent) return;
        setActiveSubagent(status);
      }),
    [agent],
  );
  useEffect(
    () => () => {
      for (const unsubscribe of telegramSubagentUnsubsRef.current.values()) {
        unsubscribe();
      }
      telegramSubagentUnsubsRef.current.clear();
    },
    [],
  );
  useEffect(() => {
    let active = true;
    const id = setInterval(() => {
      agent
        .consumeBackgroundNotifications()
        .then((notifications) => {
          if (!active || notifications.length === 0) return;
          setMessages((prev) => [
            ...prev,
            ...notifications.map((message) => ({
              type: "assistant" as const,
              content: message,
              timestamp: new Date(),
            })),
          ]);
          setTimeout(scrollToBottom, 10);
        })
        .catch(() => {});
    }, 2000);

    return () => {
      active = false;
      clearInterval(id);
    };
  }, [agent, scrollToBottom]);

  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const c = cmd.trim().toLowerCase();
      if (c === "/clear") {
        resetToNewSession();
        return true;
      }
      if (c === "/connect" || c === "/login") {
        openProviderConnect();
        return true;
      }
      if (c === "/model" || c === "/models") {
        openProviderModels();
        return true;
      }
      if (c === "/sandbox") {
        openSandboxPicker();
        return true;
      }
      if (c === "/recap" || c === "/recaps") {
        openRecapPicker();
        return true;
      }
      if (c === "/remote-control") {
        setConnectModalIndex(0);
        setShowConnectModal(true);
        return true;
      }
      if (c === "/mcp" || c === "/mcps") {
        openMcpModal();
        return true;
      }
      if (c === "/agents" || c === "/agent") {
        openAgentsModal();
        return true;
      }
      if (c === "/schedule" || c === "/schedules") {
        openScheduleModal();
        return true;
      }
      if (c === "/fork") {
        if (isProcessingRef.current) {
          setMessages((prev) => [...prev, buildAssistantEntry("Cannot fork while a turn is running.")]);
          return true;
        }
        const snapshot = agent.forkSession();
        if (!snapshot) {
          setMessages((prev) => [...prev, buildAssistantEntry("No session to fork.")]);
          return true;
        }
        activeTurnRef.current = null;
        clearLiveTurnUi();
        setMessages(snapshot.entries);
        setSessionTitle(snapshot.session.title);
        setSessionId(snapshot.session.id);
        queuedMessagesRef.current = [];
        setQueuedMessages([]);
        return true;
      }
      if (c.startsWith("/transfer ") || c === "/transfer") {
        if (isProcessingRef.current) {
          setMessages((prev) => [...prev, buildAssistantEntry("Cannot transfer while a turn is running.")]);
          return true;
        }
        const target = cmd.trim().slice("/transfer".length).trim();
        if (!target) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry("Usage: /transfer <path>\nExample: /transfer ~/projects/other"),
          ]);
          return true;
        }
        try {
          agent.transferSession(target);
          setMessages((prev) => [...prev, buildAssistantEntry(`Session moved to ${agent.getCwd()}.`)]);
        } catch (error) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(`Transfer failed: ${error instanceof Error ? error.message : String(error)}`),
          ]);
        }
        return true;
      }
      if (c === "/budget" || c.startsWith("/budget ")) {
        const arg = cmd.trim().slice("/budget".length).trim();
        if (!arg) {
          const current = agent.getSessionTokenBudget();
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(
              current > 0 ? `Session token budget: ${current} tokens.` : "Session token budget: unlimited.",
            ),
          ]);
          return true;
        }
        const value = Number(arg);
        if (!Number.isInteger(value) || value < 0) {
          setMessages((prev) => [...prev, buildAssistantEntry("Usage: /budget <tokens>\nUse 0 for unlimited.")]);
          return true;
        }
        agent.setSessionTokenBudget(value);
        setMessages((prev) => [
          ...prev,
          buildAssistantEntry(
            value > 0 ? `Session token budget set to ${value} tokens.` : "Session token budget removed (unlimited).",
          ),
        ]);
        return true;
      }
      if (c === "/quit" || c === "/exit" || c === "/q") {
        handleExit();
        return true;
      }
      if (c === "/review") {
        processMessage(REVIEW_PROMPT);
        return true;
      }
      if (c === "/verify") {
        processMessage(buildVerifyPrompt(agent.getCwd()));
        return true;
      }
      if (c === "/commit-push") {
        processMessage(COMMIT_PUSH_PROMPT);
        return true;
      }
      if (c === "/commit-pr") {
        processMessage(COMMIT_PR_PROMPT);
        return true;
      }
      if (c.startsWith("/btw ") || c === "/btw") {
        const question = cmd.trim().slice(4).trim();
        if (!question) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry("Usage: /btw <question>\nExample: /btw what does useEffect cleanup do?"),
          ]);
          return true;
        }
        const ac = new AbortController();
        btwAbortRef.current = ac;
        const loadingState: BtwState = { status: "loading", question };
        btwStateRef.current = loadingState;
        setBtwState(loadingState);
        agent
          .askSideQuestion(question, ac.signal)
          .then((result) => {
            if (ac.signal.aborted) return;
            const doneState: BtwState = { status: "done", question, answer: result.response };
            btwStateRef.current = doneState;
            setBtwState(doneState);
          })
          .catch((err) => {
            if (ac.signal.aborted) return;
            const errState: BtwState = {
              status: "error",
              question,
              error: err instanceof Error ? err.message : String(err),
            };
            btwStateRef.current = errState;
            setBtwState(errState);
          });
        return true;
      }
      const assignMatch = /^\/agents\s+assign\s+(\S+)(?:\s+([\s\S]+))?$/.exec(cmd.trim());
      if (assignMatch) {
        const assignName = assignMatch[1] ?? "";
        const assignTask = (assignMatch[2] ?? "").trim();
        if (!assignName || !assignTask) {
          setMessages((prev) => [...prev, buildAssistantEntry("Usage: /agents assign <name> <task>")]);
          return true;
        }
        const definition = findAgentDefinition(agentDefinitions, assignName);
        const custom = !definition
          ? subAgents.find((item) => item.name.toLowerCase() === assignName.toLowerCase())
          : undefined;
        if (definition && (!definition.enabled || definition.mode === "primary")) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(`Sub-agent "${assignName}" cannot be assigned directly.`),
          ]);
          return true;
        }
        if (!definition && !custom) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(`Unknown sub-agent "${assignName}". Open /agents to see available sub-agents.`),
          ]);
          return true;
        }
        const description = assignTask.length > 80 ? `${assignTask.slice(0, 77)}...` : assignTask;
        void (async () => {
          setDirectSubagent({ agent: assignName, description, detail: "Starting" });
          try {
            const result = await agent.runSubagentForeground(
              { agent: assignName, description, prompt: assignTask },
              (detail) => {
                setDirectSubagent((prev) => (prev ? { ...prev, detail } : prev));
              },
            );
            setMessages((prev) => [
              ...prev,
              buildAssistantEntry(
                result.success
                  ? result.task?.summary || result.output || "Sub-agent finished."
                  : result.output || "Sub-agent failed.",
              ),
            ]);
          } catch (error) {
            setMessages((prev) => [
              ...prev,
              buildAssistantEntry(`Sub-agent task failed: ${error instanceof Error ? error.message : String(error)}`),
            ]);
          } finally {
            setDirectSubagent(null);
          }
        })();
        return true;
      }
      const customSubagentCommand = parseCustomSubagentSlashCommand(cmd, subAgents, agentDefinitions);
      if (customSubagentCommand) {
        if (!customSubagentCommand.prompt) {
          setMessages((prev) => [
            ...prev,
            buildAssistantEntry(
              `Usage: /${customSubagentCommand.agentName} <task>\nExample: /${customSubagentCommand.agentName} review the latest changes`,
            ),
          ]);
          return true;
        }

        processMessage(buildCustomSubagentSlashPrompt(customSubagentCommand.agentName, customSubagentCommand.prompt));
        return true;
      }
      return false;
    },
    [
      agent,
      agentDefinitions,
      clearLiveTurnUi,
      handleExit,
      openAgentsModal,
      openMcpModal,
      openRecapPicker,
      openSandboxPicker,
      openProviderConnect,
      openProviderModels,
      openScheduleModal,
      processMessage,
      resetToNewSession,
      subAgents,
    ],
  );

  const handleSlashMenuSelect = useCallback(
    (item: SlashMenuItem) => {
      setShowSlashMenu(false);
      inputRef.current?.clear();
      switch (item.id) {
        case "new":
          resetToNewSession();
          break;
        case "connect":
          openProviderConnect();
          break;
        case "models":
          openProviderModels();
          break;
        case "sandbox":
          openSandboxPicker();
          break;
        case "recaps":
          openRecapPicker();
          break;
        case "remote-control":
          setConnectModalIndex(0);
          setShowConnectModal(true);
          break;
        case "exit":
          handleExit();
          break;
        case "skills":
          setMessages((p) => [
            ...p,
            {
              type: "assistant",
              content: formatSkillsForChat(discoverSkills(agent.getCwd()), agent.getCwd()),
              timestamp: new Date(),
            },
          ]);
          break;
        case "mcp":
          openMcpModal();
          break;
        case "agents":
          openAgentsModal();
          break;
        case "schedule":
          openScheduleModal();
          break;
        case "review":
          processMessage(REVIEW_PROMPT);
          break;
        case "verify":
          processMessage(buildVerifyPrompt(agent.getCwd()));
          break;
        case "commit-push":
          processMessage(COMMIT_PUSH_PROMPT);
          break;
        case "commit-pr":
          processMessage(COMMIT_PR_PROMPT);
          break;
        case "btw":
          inputRef.current?.clear();
          inputRef.current?.insertText("/btw ");
          break;
        case "update":
          setIsUpdating(true);
          setUpdateOutput(null);
          runUpdate(startupConfig.version).then((result) => {
            setIsUpdating(false);
            setUpdateOutput(result.success ? result.output : `Update failed: ${result.output}`);
          });
          break;
      }
    },
    [
      agent,
      handleExit,
      openAgentsModal,
      openMcpModal,
      openProviderConnect,
      openProviderModels,
      openRecapPicker,
      openSandboxPicker,
      openScheduleModal,
      processMessage,
      resetToNewSession,
      startupConfig.version,
    ],
  );

  const blockPrompt =
    showProviderModal ||
    showConnectModal ||
    showTelegramTokenModal ||
    showTelegramPairModal ||
    showMcpModal ||
    showSandboxPicker ||
    showRecapPicker ||
    !!pendingPaymentApproval ||
    !!pendingPermission ||
    !!pendingQuestion ||
    showScheduleModal ||
    showAgentsModal ||
    showAgentsEditor ||
    showUpdateModal;

  const showPlanPanel = !!activePlan?.questions?.length;
  const planQuestions = activePlan?.questions ?? [];
  const isSinglePlan = planQuestions.length === 1 && planQuestions[0]?.type !== "multiselect";
  const planTabCount = isSinglePlan ? 1 : planQuestions.length + 1;
  const isPlanConfirmTab = !isSinglePlan && pqs.tab === planQuestions.length;

  const dismissPlan = useCallback(() => {
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
  }, []);

  const submitPlanAnswers = useCallback(() => {
    if (!activePlan?.questions?.length) return;
    const text = formatPlanAnswers(activePlan.questions, pqs.answers);
    setActivePlan(null);
    setPqs(initialPlanQuestionsState());
    processMessage(text);
  }, [activePlan, pqs.answers, processMessage]);

  const handlePlanSelect = useCallback(
    (q: PlanQuestion, idx: number, options: { id: string; label: string }[], showCustom: boolean) => {
      const isCustom = showCustom && idx === options.length;
      if (isCustom) {
        if (q.type === "multiselect") {
          const customVal = pqs.customInputs[q.id] ?? "";
          if (customVal) {
            const existing = (pqs.answers[q.id] as string[] | undefined) ?? [];
            if (existing.includes(customVal)) {
              setPqs((s) => ({ ...s, answers: { ...s.answers, [q.id]: existing.filter((x) => x !== customVal) } }));
            } else {
              setPqs((s) => ({ ...s, editing: true }));
            }
          } else {
            setPqs((s) => ({ ...s, editing: true }));
          }
        } else {
          setPqs((s) => ({ ...s, editing: true }));
        }
        return;
      }
      const opt = options[idx];
      if (!opt) return;

      if (q.type === "multiselect") {
        setPqs((s) => {
          const existing = (s.answers[q.id] as string[] | undefined) ?? [];
          const next = existing.includes(opt.id) ? existing.filter((x) => x !== opt.id) : [...existing, opt.id];
          return { ...s, answers: { ...s.answers, [q.id]: next } };
        });
      } else {
        setPqs((s) => ({ ...s, answers: { ...s.answers, [q.id]: opt.id } }));
        if (isSinglePlan) {
          submitPlanAnswers();
          return;
        }
        setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
      }
    },
    [pqs, isSinglePlan, submitPlanAnswers],
  );

  const dismissBtw = useCallback(() => {
    btwAbortRef.current?.abort();
    btwAbortRef.current = null;
    btwStateRef.current = null;
    setBtwState(null);
  }, []);

  const handleKey = useCallback(
    (key: KeyEvent) => {
      if (btwState) {
        if (isEscapeKey(key) || key.name === "return") {
          dismissBtw();
        }
        return;
      }
      if (showPlanPanel) {
        const q = planQuestions[pqs.tab];

        // Escape always dismisses
        if (isEscapeKey(key)) {
          dismissPlan();
          return;
        }

        // When editing custom text input
        if (pqs.editing && !isPlanConfirmTab) {
          if (key.name === "return") {
            const qId = q?.id;
            if (qId) {
              const text = (pqs.customInputs[qId] ?? "").trim();
              if (text) {
                if (q.type === "multiselect") {
                  const existing = (pqs.answers[qId] as string[] | undefined) ?? [];
                  const next = existing.includes(text) ? existing : [...existing, text];
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: next } }));
                } else if (q.type === "text") {
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: text } }));
                  if (isSinglePlan) {
                    submitPlanAnswers();
                    return;
                  }
                  setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
                } else {
                  setPqs((s) => ({ ...s, editing: false, answers: { ...s.answers, [qId]: text } }));
                  if (isSinglePlan) {
                    submitPlanAnswers();
                    return;
                  }
                  setPqs((s) => ({ ...s, tab: s.tab + 1, selected: 0 }));
                }
              } else {
                setPqs((s) => ({ ...s, editing: false }));
              }
            }
            return;
          }
          if (key.name === "backspace") {
            const qId = q?.id;
            if (qId)
              setPqs((s) => ({
                ...s,
                customInputs: { ...s.customInputs, [qId]: (s.customInputs[qId] ?? "").slice(0, -1) },
              }));
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            const qId = q?.id;
            if (qId)
              setPqs((s) => ({
                ...s,
                customInputs: { ...s.customInputs, [qId]: (s.customInputs[qId] ?? "") + key.sequence },
              }));
            return;
          }
          return;
        }

        // Tab / left / right — switch between question tabs
        if (key.name === "tab") {
          const dir = key.shift ? -1 : 1;
          setPqs((s) => ({ ...s, tab: (s.tab + dir + planTabCount) % planTabCount, selected: 0 }));
          return;
        }
        if (key.name === "left" || key.name === "h") {
          setPqs((s) => ({ ...s, tab: (s.tab - 1 + planTabCount) % planTabCount, selected: 0 }));
          return;
        }
        if (key.name === "right" || key.name === "l") {
          setPqs((s) => ({ ...s, tab: (s.tab + 1) % planTabCount, selected: 0 }));
          return;
        }

        // Confirm tab
        if (isPlanConfirmTab) {
          if (key.name === "return") {
            submitPlanAnswers();
            return;
          }
          return;
        }

        if (!q) return;

        // Text-only question (no options)
        if (q.type === "text") {
          setPqs((s) => ({ ...s, editing: true }));
          return;
        }

        // Up/down — navigate options
        const options = q.options ?? [];
        const showCustom = true;
        const totalItems = options.length + 1;

        if (key.name === "up" || key.name === "k") {
          setPqs((s) => ({ ...s, selected: (s.selected - 1 + totalItems) % totalItems }));
          return;
        }
        if (key.name === "down" || key.name === "j") {
          setPqs((s) => ({ ...s, selected: (s.selected + 1) % totalItems }));
          return;
        }

        // Number keys 1-9 for quick selection
        const digit = Number(key.name);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= Math.min(totalItems, 9)) {
          const idx = digit - 1;
          setPqs((s) => ({ ...s, selected: idx }));
          handlePlanSelect(q, idx, options, showCustom);
          return;
        }

        // Enter — select current option
        if (key.name === "return") {
          handlePlanSelect(q, pqs.selected, options, showCustom);
          return;
        }

        return;
      }
      if (showUpdateModalRef.current) {
        if (isEscapeKey(key)) {
          setShowUpdateModal(false);
          return;
        }
        if (key.name === "return") {
          setIsUpdating(true);
          setShowUpdateModal(false);
          runUpdate(startupConfig.version).then((result) => {
            setIsUpdating(false);
            setUpdateOutput(result.output);
          });
          return;
        }
        return;
      }
      if (showMcpEditorRef.current) {
        if (isEscapeKey(key)) {
          setShowMcpEditor(false);
          setMcpEditorError(null);
          setMcpSearchQuery("");
          return;
        }
        if (key.name === "return") {
          submitMcpEditor();
          return;
        }
        if (mcpEditorField === "transport" && (key.name === "left" || key.name === "right")) {
          cycleMcpEditorTransport(key.name === "left" ? -1 : 1);
          return;
        }
        if (key.name === "tab") {
          const idx = mcpEditorFields.indexOf(mcpEditorField);
          const nextIdx = (idx + (key.shift ? -1 : 1) + mcpEditorFields.length) % mcpEditorFields.length;
          setMcpEditorField(mcpEditorFields[nextIdx]);
          return;
        }
        if (mcpEditorField === "transport") {
          return;
        }
      }
      if (showAgentsEditorRef.current) {
        if (isEscapeKey(key)) {
          setShowAgentsEditor(false);
          setAgentsEditorError(null);
          return;
        }
        if (key.name === "x" && key.ctrl && (editingSubagent || editingFile)) {
          removeEditingSubagent();
          return;
        }
        if (key.name === "return") {
          submitSubagentEditor();
          return;
        }
        if (
          agentsEditorField === "model" &&
          (key.name === "up" ||
            key.name === "down" ||
            key.name === "left" ||
            key.name === "right" ||
            key.name === "j" ||
            key.name === "k")
        ) {
          const decrement = key.name === "up" || key.name === "left" || key.name === "k";
          setAgentsEditorModelIndex((index) =>
            decrement ? Math.max(0, index - 1) : Math.min(MODELS.length - 1, index + 1),
          );
          return;
        }
        if (key.name === "tab") {
          const index = SUBAGENT_EDITOR_FIELDS.indexOf(agentsEditorField);
          const nextIndex =
            (index + (key.shift ? -1 : 1) + SUBAGENT_EDITOR_FIELDS.length) % SUBAGENT_EDITOR_FIELDS.length;
          setAgentsEditorField(SUBAGENT_EDITOR_FIELDS[nextIndex]);
          return;
        }
        if (agentsEditorField === "model") {
          return;
        }
      }
      if (showMcpModalRef.current) {
        const row = mcpRows[mcpModalIndex];
        if (isEscapeKey(key)) {
          setShowMcpEditor(false);
          setShowMcpModal(false);
          setMcpSearchQuery("");
          setEditingMcpId(null);
          setMcpEditorError(null);
          return;
        }
        if (key.name === "up") {
          setMcpModalIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setMcpModalIndex((i) => Math.min(mcpRows.length - 1, i + 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "server") {
            toggleSavedMcp(row.server);
          } else {
            openMcpEditor(createEmptyMcpEditorDraft());
          }
          return;
        }
        if (key.name === "a" && key.ctrl) {
          openMcpEditor(createEmptyMcpEditorDraft());
          return;
        }
        if (key.name === "e" && key.ctrl && row?.kind === "server") {
          editSavedMcp(row.server);
          return;
        }
        if (key.name === "x" && key.ctrl && row?.kind === "server") {
          deleteSavedMcp(row.server);
          return;
        }
        if (key.name === "backspace") {
          setMcpSearchQuery((q) => q.slice(0, -1));
          setMcpModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setMcpSearchQuery((q) => q + key.sequence);
          setMcpModalIndex(0);
          return;
        }
        return;
      }
      if (showScheduleModalRef.current) {
        const row = scheduleRows[scheduleModalIndex];
        if (isEscapeKey(key)) {
          setShowScheduleModal(false);
          setScheduleSearchQuery("");
          return;
        }
        if (key.name === "up") {
          setScheduleModalIndex((index) => Math.max(0, index - 1));
          return;
        }
        if (key.name === "down") {
          setScheduleModalIndex((index) => Math.min(Math.max(0, scheduleRows.length - 1), index + 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "schedule") {
            showScheduleDetails(row.schedule);
          }
          return;
        }
        if (key.name === "x" && key.ctrl && row?.kind === "schedule") {
          removeSchedule(row.schedule);
          return;
        }
        if (key.name === "backspace") {
          setScheduleSearchQuery((query) => query.slice(0, -1));
          setScheduleModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setScheduleSearchQuery((query) => query + key.sequence);
          setScheduleModalIndex(0);
          return;
        }
        return;
      }
      if (showAgentsModalRef.current && !showAgentsEditorRef.current) {
        const row = agentRows[agentsModalIndex];
        if (isEscapeKey(key)) {
          setShowAgentsModal(false);
          setShowAgentsEditor(false);
          setAgentsSearchQuery("");
          setEditingSubagent(null);
          setAgentsEditorError(null);
          return;
        }
        if (key.name === "up") {
          setAgentsModalIndex((index) => wrapListIndex(index, agentRows.length, -1));
          return;
        }
        if (key.name === "down") {
          setAgentsModalIndex((index) => wrapListIndex(index, agentRows.length, 1));
          return;
        }
        if (key.name === "return") {
          if (row?.kind === "fleet") {
            openFleetEditor(row.definition);
          }
          return;
        }
        if (key.name === "a" && key.ctrl) {
          openFleetEditor(null);
          return;
        }
        if (key.name === "backspace") {
          setAgentsSearchQuery((query) => query.slice(0, -1));
          setAgentsModalIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setAgentsSearchQuery((query) => query + key.sequence);
          setAgentsModalIndex(0);
          return;
        }
        return;
      }
      if (showTelegramTokenModalRef.current) {
        if (isEscapeKey(key)) {
          setShowTelegramTokenModal(false);
          setTelegramTokenError(null);
          return;
        }
        if (key.name === "return") {
          submitTelegramToken();
        }
        return;
      }
      if (showTelegramPairModalRef.current) {
        if (isEscapeKey(key)) {
          setShowTelegramPairModal(false);
          setTelegramPairError(null);
          return;
        }
        if (key.name === "return") {
          void submitTelegramPair();
        }
        return;
      }
      if (showConnectModalRef.current) {
        if (isEscapeKey(key)) {
          setShowConnectModal(false);
          return;
        }
        if (key.name === "up") {
          setConnectModalIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setConnectModalIndex((i) => Math.min(CONNECT_CHANNELS.length - 1, i + 1));
          return;
        }
        if (key.name === "return") {
          const ch = CONNECT_CHANNELS[connectModalIndex];
          if (ch?.id === "telegram") beginTelegramFromConnect();
          return;
        }
        return;
      }
      if (showProviderModalRef.current) {
        if (isEscapeKey(key)) {
          closeProviderModal();
          return;
        }
        if (providerStep === "list") {
          if (key.name === "up") {
            setProviderIndex((i) => wrapListIndex(i, providerRows.length + 1, -1));
            return;
          }
          if (key.name === "down") {
            setProviderIndex((i) => wrapListIndex(i, providerRows.length + 1, 1));
            return;
          }
          if (key.name === "return") {
            selectProviderRow();
            return;
          }
          return;
        }
        if (providerStep === "customModelList") {
          if (key.name === "up") {
            setProviderIndex((i) => wrapListIndex(i, customFetchedModels.length, -1));
            return;
          }
          if (key.name === "down") {
            setProviderIndex((i) => wrapListIndex(i, customFetchedModels.length, 1));
            return;
          }
          if (key.name === "return") {
            selectCustomModel();
            return;
          }
          return;
        }
        if (providerStep === "customModelSource") {
          if (key.name === "up") {
            setProviderIndex((i) => wrapListIndex(i, CUSTOM_MODEL_SOURCE_OPTIONS.length, -1));
            return;
          }
          if (key.name === "down") {
            setProviderIndex((i) => wrapListIndex(i, CUSTOM_MODEL_SOURCE_OPTIONS.length, 1));
            return;
          }
          if (key.name === "return") {
            selectModelSource();
            return;
          }
          return;
        }
        if (key.name === "return") {
          submitProviderStep();
        }
        return;
      }
      if (showSlashMenu) {
        if (isEscapeKey(key)) {
          setShowSlashMenu(false);
          setSlashSearchQuery("");
          inputRef.current?.clear();
          return;
        }
        if (key.name === "up") {
          setSlashMenuIndex((i) => wrapListIndex(i, filteredSlashItems.length, -1));
          return;
        }
        if (key.name === "down") {
          setSlashMenuIndex((i) => wrapListIndex(i, filteredSlashItems.length, 1));
          return;
        }
        if (key.name === "return") {
          const item = filteredSlashItems[slashMenuIndex];
          if (item) handleSlashMenuSelect(item);
          setSlashSearchQuery("");
          return;
        }
        if (key.name === "backspace") {
          setSlashSearchQuery((q) => q.slice(0, -1));
          setSlashMenuIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setSlashSearchQuery((q) => q + key.sequence);
          setSlashMenuIndex(0);
          return;
        }
        return;
      }
      if (showModelPicker) {
        if (isEscapeKey(key)) {
          setShowModelPicker(false);
          setModelSearchQuery("");
          return;
        }
        if (key.name === "up") {
          setModelPickerIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setModelPickerIndex((i) => Math.min(filteredModelIds.length - 1, i + 1));
          return;
        }
        if (key.name === "left" || key.name === "right") {
          const sel = filteredModelIds[modelPickerIndex];
          if (sel) {
            adjustModelReasoningEffort(sel, key.name === "left" ? -1 : 1);
          }
          return;
        }
        if (key.name === "return") {
          const sel = filteredModelIds[modelPickerIndex];
          if (sel) {
            agent.setModel(sel);
            setModel(sel);
            saveProjectSettings({ model: sel });
            if (selectedProviderId) {
              const currentModels = loadUserSettings().providerModels ?? {};
              saveUserSettings({
                providerModels: { ...currentModels, [selectedProviderId]: sel },
                defaultModel: sel,
              });
            } else {
              saveUserSettings({ defaultModel: sel });
            }
          }
          setShowModelPicker(false);
          setModelSearchQuery("");
          return;
        }
        if (key.name === "backspace") {
          setModelSearchQuery((q) => q.slice(0, -1));
          setModelPickerIndex(0);
          return;
        }
        if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
          setModelSearchQuery((q) => q + key.sequence);
          setModelPickerIndex(0);
          return;
        }
        return;
      }
      if (pendingQuestion) {
        if (isEscapeKey(key)) {
          declineQuestion();
          return;
        }
        if (key.name === "up" || key.name === "down") {
          setPendingQuestion((p) =>
            p ? { ...p, selected: wrapListIndex(p.selected, p.options.length, key.name === "down" ? 1 : -1) } : p,
          );
          return;
        }
        if (key.name === "return") {
          answerQuestion(pendingQuestion.options[pendingQuestion.selected] ?? "");
          return;
        }
        return;
      }
      if (pendingPermission) {
        if (isEscapeKey(key)) {
          answerPermission("deny", false);
          return;
        }
        if (key.name === "up" || key.name === "down") {
          setPendingPermission((p) =>
            p ? { ...p, selected: wrapListIndex(p.selected, 3, key.name === "down" ? 1 : -1) } : p,
          );
          return;
        }
        if (key.name === "return") {
          if (pendingPermission.selected === 0) {
            answerPermission("allow", false);
          } else if (pendingPermission.selected === 1) {
            answerPermission("allow", true);
          } else {
            answerPermission("deny", false);
          }
          return;
        }
        return;
      }
      if (pendingPaymentApproval) {
        if (isEscapeKey(key)) {
          setPendingPaymentApproval(null);
          return;
        }
        if (key.name === "up" || key.name === "down") {
          setPendingPaymentApproval((p) => (p ? { ...p, selected: p.selected === 0 ? 1 : 0 } : p));
          return;
        }
        if (key.name === "return") {
          const approved = pendingPaymentApproval.selected === 0;
          const aid = pendingPaymentApproval.approvalId;
          setPendingPaymentApproval(null);
          if (aid) {
            agent.respondToToolApproval(aid, approved);
            if (approved) {
              processMessage("[Payment approved]");
            }
          }
          return;
        }
        return;
      }
      if (showRecapPicker) {
        if (isEscapeKey(key)) {
          setShowRecapPicker(false);
          return;
        }
        if (key.name === "left" || key.name === "right") {
          const current = formatRecapsEnabled(recapsEnabled);
          const idx = RECAP_OPTIONS.indexOf(current);
          const next =
            key.name === "right"
              ? RECAP_OPTIONS[Math.min(RECAP_OPTIONS.length - 1, idx + 1)]
              : RECAP_OPTIONS[Math.max(0, idx - 1)];
          if (next && next !== current) {
            applyRecapsEnabled(next === "On");
          }
          return;
        }
        if (key.name === "return") {
          applyRecapsEnabled(!recapsEnabled);
          return;
        }
        return;
      }
      if (showSandboxPicker) {
        const visibleRows = getSandboxVisibleRows(sandboxMode);

        if (sandboxSettingsEditing) {
          if (isEscapeKey(key)) {
            setSandboxSettingsEditing(null);
            setSandboxSettingsEditBuffer("");
            return;
          }
          if (key.name === "return") {
            const row = visibleRows.find((r) => r.key === sandboxSettingsEditing);
            if (row) {
              const result = row.apply(sandboxMode, sandboxSettings, sandboxSettingsEditBuffer.trim());
              if (result.mode !== undefined) applySandboxMode(result.mode);
              if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
            }
            setSandboxSettingsEditing(null);
            setSandboxSettingsEditBuffer("");
            return;
          }
          if (key.name === "backspace") {
            setSandboxSettingsEditBuffer((b) => b.slice(0, -1));
            return;
          }
          if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
            setSandboxSettingsEditBuffer((b) => b + key.sequence);
            return;
          }
          return;
        }

        if (isEscapeKey(key)) {
          setShowSandboxPicker(false);
          return;
        }
        if (key.name === "up") {
          setSandboxSettingsFocusIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.name === "down") {
          setSandboxSettingsFocusIndex((i) => Math.min(visibleRows.length - 1, i + 1));
          return;
        }

        const focusedRow = visibleRows[sandboxSettingsFocusIndex];
        if (!focusedRow) return;

        if (focusedRow.type === "toggle" && (key.name === "left" || key.name === "right")) {
          const options = focusedRow.getOptions!();
          const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
          const idx = options.indexOf(current);
          const next =
            key.name === "right" ? options[Math.min(options.length - 1, idx + 1)] : options[Math.max(0, idx - 1)];
          if (next && next !== current) {
            const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
            if (result.mode !== undefined) applySandboxMode(result.mode);
            if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
          }
          return;
        }

        if (key.name === "return") {
          if (focusedRow.type === "toggle") {
            const options = focusedRow.getOptions!();
            const current = focusedRow.getDisplay(sandboxMode, sandboxSettings);
            const idx = options.indexOf(current);
            const next = options[(idx + 1) % options.length];
            const result = focusedRow.apply(sandboxMode, sandboxSettings, next);
            if (result.mode !== undefined) applySandboxMode(result.mode);
            if (result.settings) applySandboxSettings({ ...sandboxSettings, ...result.settings });
          } else {
            setSandboxSettingsEditing(focusedRow.key);
            const current = sandboxSettings[focusedRow.key as keyof SandboxSettings];
            setSandboxSettingsEditBuffer(
              Array.isArray(current) ? current.join(", ") : current != null ? String(current) : "",
            );
          }
          return;
        }
        return;
      }

      if (isEscapeKey(key) && interruptActiveRun(key)) {
        return;
      }

      if (!hasApiKeyRef.current && shouldOpenProviderModalForKey(key)) {
        openProviderConnect();
        return;
      }
      if (key.sequence === "/" && !isProcessing) {
        const text = inputRef.current?.plainText || "";
        if (!text.trim()) {
          setShowSlashMenu(true);
          setSlashMenuIndex(0);
          setSlashSearchQuery("");
          return;
        }
      }

      if (key.name === "e" && key.ctrl) {
        let lastUserIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i]!.type === "user") {
            lastUserIdx = i;
            break;
          }
        }
        if (lastUserIdx >= 0) {
          setExpandedMessages((prev) => {
            const next = new Set(prev);
            if (next.has(lastUserIdx)) next.delete(lastUserIdx);
            else next.add(lastUserIdx);
            return next;
          });
        }
        return;
      }
      if (key.name === "c" && key.ctrl && key.shift) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
        }
        return;
      }
      if (key.name === "y" && key.ctrl && copyTuiSelectionToHost()) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      // ⌘C: Kitty / iTerm report Command as `super`; some setups use `meta` instead.
      if (key.name === "c" && !key.ctrl && (key.meta || key.super)) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
      }
      if (key.name === "c" && key.ctrl) {
        if (copyTuiSelectionToHost()) {
          key.preventDefault();
          key.stopPropagation();
          return;
        }
        const text = inputRef.current?.plainText || "";
        if (text.trim()) {
          inputRef.current?.clear();
          replacePasteBlocks([]);
        } else {
          handleExit();
        }
        return;
      }
      if (typeaheadRef.current.visible) {
        if (key.name === "up") {
          typeaheadRef.current.navigateUp();
          return;
        }
        if (key.name === "down") {
          typeaheadRef.current.navigateDown();
          return;
        }
        if (key.name === "tab" || key.name === "return") {
          key.preventDefault();
          key.stopPropagation();
          typeaheadRef.current.accept();
          return;
        }
        if (isEscapeKey(key)) {
          typeaheadRef.current.dismiss();
          return;
        }
      }
      if (key.name === "tab" && !isProcessing) {
        cycleMode();
        return;
      }
    },
    [
      agent,
      agentRows,
      agentsEditorField,
      agentsModalIndex,
      beginTelegramFromConnect,
      btwState,
      closeProviderModal,
      customFetchedModels,
      providerRows,
      providerStep,
      selectCustomModel,
      selectModelSource,
      selectProviderRow,
      connectModalIndex,
      cycleMode,
      cycleMcpEditorTransport,
      deleteSavedMcp,
      dismissBtw,
      dismissPlan,
      editingSubagent,
      editSavedMcp,
      adjustModelReasoningEffort,
      filteredModelIds,
      filteredSlashItems,
      handleExit,
      handlePlanSelect,
      handleSlashMenuSelect,
      interruptActiveRun,
      isPlanConfirmTab,
      isProcessing,
      isSinglePlan,
      mcpEditorField,
      mcpEditorFields,
      mcpModalIndex,
      mcpRows,
      modelPickerIndex,
      openProviderConnect,
      openMcpEditor,
      replacePasteBlocks,
      openFleetEditor,
      editingFile,
      removeSchedule,
      scheduleModalIndex,
      scheduleRows,
      showScheduleDetails,
      submitTelegramPair,
      submitTelegramToken,
      submitMcpEditor,
      submitSubagentEditor,
      planQuestions,
      planTabCount,
      pqs,
      removeEditingSubagent,
      applyRecapsEnabled,
      applySandboxMode,
      applySandboxSettings,
      recapsEnabled,
      sandboxSettings,
      sandboxSettingsEditing,
      sandboxSettingsEditBuffer,
      sandboxSettingsFocusIndex,
      sandboxMode,
      showModelPicker,
      showPlanPanel,
      showRecapPicker,
      showSandboxPicker,
      pendingPaymentApproval,
      pendingPermission,
      pendingQuestion,
      answerPermission,
      answerQuestion,
      declineQuestion,
      processMessage,
      showSlashMenu,
      slashMenuIndex,
      submitProviderStep,
      submitPlanAnswers,
      copyTuiSelectionToHost,
      toggleSavedMcp,
      messages,
      startupConfig.version,
      selectedProviderId,
    ],
  );
  useKeyboard(handleKey);

  const handlePaste = useCallback(
    (event: PasteEvent) => {
      const text = decodePasteBytes(event.bytes);
      const trimmed = text.trim();
      const imageExts = /\.(png|jpe?g|gif|webp|svg|bmp|ico|tiff?)$/i;
      if (imageExts.test(trimmed) && !trimmed.includes("\n")) {
        event.preventDefault();
        const id = ++pasteCounterRef.current;
        const block = { id, content: trimmed, lines: 1, isImage: true } satisfies PasteBlock;
        replacePasteBlocks([...pasteBlocksRef.current, block]);
        inputRef.current?.insertText(getPasteBlockToken(block));
        return;
      }
      const lineCount = text.split("\n").length;
      if (lineCount < 2) return;
      event.preventDefault();
      const id = ++pasteCounterRef.current;
      const block = { id, content: text, lines: lineCount } satisfies PasteBlock;
      replacePasteBlocks([...pasteBlocksRef.current, block]);
      inputRef.current?.insertText(getPasteBlockToken(block));
    },
    [replacePasteBlocks],
  );

  const handleSubmit = useCallback(() => {
    const raw = inputRef.current?.plainText || "";
    if (!raw.trim() && pasteBlocksRef.current.length === 0) {
      if (queuedMessagesRef.current.length > 0 && isProcessingRef.current) {
        interruptedRunIdRef.current = activeRunIdRef.current;
        const activeAgent = activeTurnRef.current?.agent ?? agent;
        activeTurnRef.current = null;
        clearLiveTurnUi();
        activeAgent.abort();
      }
      return;
    }
    inputRef.current?.clear();
    let message = raw;
    const blocks = [...pasteBlocksRef.current];
    replacePasteBlocks([]);
    for (const block of blocks) {
      message = message.replace(getPasteBlockToken(block), block.content);
    }
    const displayText = message.trim();
    const fileBlocks = [...fileMentionBlocksRef.current];
    fileMentionBlocksRef.current = [];
    for (const block of fileBlocks) {
      message = message.replace(getFileMentionToken(block), `@${block.path}`);
    }
    if (!message.trim()) return;
    if (handleCommand(message)) return;
    if (!hasApiKeyRef.current) {
      setMessages((prev) => [
        ...prev,
        buildAssistantEntry("You have not selected a provider yet. Use /connect to choose a provider first."),
      ]);
      return;
    }
    const { enhancedMessage } = processAtMentions(message.trim(), agent.getCwd());
    if (isProcessingRef.current) {
      const inboxId = agent.enqueueFollowUp(enhancedMessage, displayText);
      queuedMessagesRef.current.push({
        text: enhancedMessage,
        displayText,
        inboxId: inboxId ?? undefined,
      });
      setQueuedMessages(queuedMessagesRef.current.map((msg) => msg.displayText));
      setTimeout(scrollToBottom, 10);
      return;
    }
    processMessage(enhancedMessage, displayText);
  }, [agent, clearLiveTurnUi, handleCommand, processMessage, replacePasteBlocks, scrollToBottom]);

  const hasMessages = messages.length > 0 || streamContent || isProcessing;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: OpenCode-style copy-on-mouse-up on root surface
    <box
      width={width}
      height={height}
      backgroundColor={t.background}
      flexDirection="column"
      onMouseUp={handleRootMouseUp}
    >
      {copyFlashId > 0 ? <CopyFlashBanner t={t} width={width} /> : null}
      {hasMessages ? (
        <box flexGrow={1} flexDirection="column">
          <SessionHeader t={t} modeInfo={modeInfo} sessionTitle={sessionTitle} sessionId={sessionId} />
          <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
            {/* Scrollable messages */}
            {/* biome-ignore lint/suspicious/noExplicitAny: OpenTUI type mismatch for stickyStart */}
            <scrollbox ref={scrollRef} flexGrow={1} stickyScroll={true} stickyStart={"bottom" as any}>
              {messages.map((msg, i) => (
                <MessageView
                  key={`${msg.timestamp.getTime()}-${msg.type}-${msg.remoteKey ?? ""}-${msg.content.slice(0, 24)}`}
                  entry={msg}
                  index={i}
                  t={t}
                  modeColor={modeInfo.color}
                  expandedMessages={expandedMessages}
                />
              ))}
              {liveTurnSourceLabel && (activeToolCalls.length > 0 || streamContent || isProcessing) && (
                <box paddingLeft={3} marginTop={1} flexShrink={0}>
                  <text fg={t.textMuted}>{liveTurnSourceLabel}</text>
                </box>
              )}
              {thoughtSummary && (
                <box paddingLeft={3} marginTop={1} flexShrink={0}>
                  <ThoughtLine t={t} durationMs={thoughtSummary.durationMs} fullText={streamReasoning} />
                </box>
              )}
              {/* Active tool calls — pending inline */}
              {activeToolCalls.map((tc) =>
                tc.function.name === "task" || (tc.function.name === "subagent" && !tryParseArg(tc, "background")) ? (
                  <SubagentTaskLine
                    key={tc.id}
                    t={t}
                    agent={tryParseArg(tc, "agent") || "sub-agent"}
                    label={toolArgs(tc) || "Working"}
                    pending
                  />
                ) : tc.function.name === "delegate" || tc.function.name === "subagent" ? (
                  <DelegationTaskLine
                    key={tc.id}
                    t={t}
                    label={toolArgs(tc) || "Background research"}
                    pending
                    id={undefined}
                  />
                ) : (
                  <InlineTool key={tc.id} t={t} pending>
                    {toolLabel(tc)}
                  </InlineTool>
                ),
              )}
              {activeSubagent && <SubagentActivity t={t} status={activeSubagent} />}
              {directSubagent && <SubagentActivity t={t} status={directSubagent} />}
              {/* Streaming assistant content */}
              {streamContent && (
                <box paddingLeft={3} marginTop={1} flexShrink={0}>
                  <Markdown content={streamContent} t={t} />
                </box>
              )}
              {/* Waiting indicator */}
              {isProcessing && thoughtSummary == null && !streamContent && activeToolCalls.length === 0 && (
                <ThinkingSpinner t={t} label="Thinking" />
              )}
              {/* Plan questions panel — inline, OpenCode-style */}
              {showPlanPanel && <PlanQuestionsPanel t={t} questions={planQuestions} state={pqs} />}
              {pendingPaymentApproval && <PaymentApprovalPanel t={t} payment={pendingPaymentApproval} />}
              {pendingPermission && <PermissionApprovalPanel t={t} permission={pendingPermission} />}
              {pendingQuestion && <QuestionPanel t={t} question={pendingQuestion} />}
            </scrollbox>
            {btwState && <BtwOverlay state={btwState} theme={t} />}
            {/* Prompt */}
            <box flexShrink={0} flexDirection="column">
              <PromptBox
                t={t}
                inputRef={inputRef}
                isProcessing={isProcessing}
                showModelPicker={showModelPicker}
                showSandboxPicker={showSandboxPicker}
                showSlashMenu={showSlashMenu}
                showPlanQuestions={showPlanPanel}
                showProviderModal={showProviderModal}
                showAgentsModal={showAgentsModal}
                showAgentsEditor={showAgentsEditor}
                blockPrompt={blockPrompt}
                onSubmit={handleSubmit}
                onPaste={handlePaste}
                pasteBlocks={pasteBlocks}
                modeInfo={modeInfo}
                model={model}
                modelInfo={modelInfo}
                contextStats={contextStats}
                queuedCount={queuedMessages.length}
                queuedMessages={queuedMessages}
                typeahead={typeahead}
              />
            </box>
          </box>
          <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
            <text fg={t.textDim}>{agent.getCwd().replace(os.homedir(), "~")}</text>
            {sandboxMode === "shuru" ? <text fg="#f97316">{" · sandbox"}</text> : null}
            <box flexGrow={1} />
          </box>
        </box>
      ) : (
        /* ── Home ───────────────────────────────────────── */
        <>
          <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
            <box flexGrow={1} minHeight={0} />
            <box flexShrink={0} alignItems="center">
              <HeroLogo t={t} />
            </box>
            <box height={1} minHeight={0} flexShrink={1} />
            <box width="100%" maxWidth={75} flexShrink={0}>
              <PromptBox
                t={t}
                inputRef={inputRef}
                isProcessing={isProcessing}
                showModelPicker={showModelPicker}
                showSandboxPicker={showSandboxPicker}
                showSlashMenu={showSlashMenu}
                showPlanQuestions={showPlanPanel}
                showProviderModal={showProviderModal}
                showAgentsModal={showAgentsModal}
                showAgentsEditor={showAgentsEditor}
                blockPrompt={blockPrompt}
                onSubmit={handleSubmit}
                onPaste={handlePaste}
                pasteBlocks={pasteBlocks}
                modeInfo={modeInfo}
                model={model}
                modelInfo={modelInfo}
                contextStats={contextStats}
                placeholder={"What are we building?"}
                typeahead={typeahead}
              />
            </box>
            <box height={2} minHeight={0} flexShrink={1} />
            <box flexGrow={1} minHeight={0} />
          </box>
          {updateInfo?.hasUpdate && (
            <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
              <text fg="#f59e0b">
                {"┃ Update available: v"}
                {startupConfig.version}
                {" → v"}
                {updateInfo.latestVersion}
                {" — run /update to install"}
              </text>
            </box>
          )}
          {isUpdating && (
            <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
              <text fg="#f59e0b">{"┃ Updating..."}</text>
            </box>
          )}
          {updateOutput && !isUpdating && (
            <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
              <text fg={updateOutput.startsWith("Update complete") ? "#22c55e" : "#ef4444"}>
                {"┃ "}
                {updateOutput}
              </text>
            </box>
          )}
          <box paddingLeft={2} paddingRight={2} flexDirection="row" flexShrink={0}>
            <text fg={t.textDim}>{agent.getCwd().replace(os.homedir(), "~")}</text>
            {sandboxMode === "shuru" ? <text fg="#f97316">{" · sandbox"}</text> : null}
            <box flexGrow={1} />
            <text fg={t.textDim}>{`v${startupConfig.version}`}</text>
          </box>
        </>
      )}
      {showProviderModal && (
        <ProviderConnectModal
          t={t}
          width={width}
          height={height}
          inputRef={providerInputRef}
          error={providerError}
          onSubmit={submitProviderStep}
          step={providerStep}
          providers={providerRows}
          providerIndex={providerIndex}
          customModels={customFetchedModels}
          customDraftName={customDraft.name || customDraft.id}
          selectedProviderName={providerRows.find((provider) => provider.id === providerSelectedId)?.name ?? ""}
          loading={providerLoading}
        />
      )}
      {showUpdateModal && updateInfo && (
        <UpdateModal
          t={t}
          width={width}
          height={height}
          currentVersion={startupConfig.version}
          latestVersion={updateInfo.latestVersion}
        />
      )}
      {showSlashMenu && (
        <SlashMenuModal
          t={t}
          selectedIndex={slashMenuIndex}
          width={width}
          height={height}
          searchQuery={slashSearchQuery}
          filteredItems={filteredSlashItems}
        />
      )}
      {showMcpModal && !showMcpEditor && (
        <McpBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={mcpModalIndex}
          searchQuery={mcpSearchQuery}
          rows={mcpRows}
        />
      )}
      {showMcpEditor && (
        <McpEditorModal
          t={t}
          width={width}
          height={height}
          draft={mcpEditorDraft}
          focusedField={mcpEditorField}
          syncKey={mcpEditorSyncKey}
          error={mcpEditorError}
          title={editingMcpId ? "Edit MCP Server" : "Add MCP Server"}
          labelRef={mcpLabelRef}
          urlRef={mcpUrlRef}
          headersRef={mcpHeadersRef}
          commandRef={mcpCommandRef}
          argsRef={mcpArgsRef}
          cwdRef={mcpCwdRef}
          envRef={mcpEnvRef}
          onSubmit={submitMcpEditor}
        />
      )}
      {showScheduleModal && (
        <ScheduleBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={scheduleModalIndex}
          searchQuery={scheduleSearchQuery}
          rows={scheduleRows}
        />
      )}
      {showAgentsModal && !showAgentsEditor && (
        <SubagentsBrowserModal
          t={t}
          width={width}
          height={height}
          selectedIndex={agentsModalIndex}
          searchQuery={agentsSearchQuery}
          rows={agentRows}
        />
      )}
      {showAgentsEditor && (
        <SubagentEditorModal
          key={`subagent-editor-${agentsEditorSyncKey}`}
          t={t}
          width={width}
          height={height}
          draft={agentsEditorDraft}
          focusedField={agentsEditorField}
          modelIndex={agentsEditorModelIndex}
          error={agentsEditorError}
          title={
            editingFile
              ? editingFile.definition
                ? editingFile.definition.source === "builtin"
                  ? `Override built-in: ${formatSubagentName(editingFile.definition.name)} (project)`
                  : `Edit sub-agent: ${formatSubagentName(editingFile.definition.name)}`
                : "Add sub-agent (project)"
              : editingSubagent
                ? `Edit sub-agent: ${formatSubagentName(editingSubagent.name)}`
                : "Add sub-agent"
          }
          nameRef={subagentNameRef}
          instructionRef={subagentInstructionRef}
          onSubmit={submitSubagentEditor}
          showRemoveHint={!!(editingSubagent || editingFile)}
        />
      )}
      {showModelPicker && (
        <ModelPickerModal
          t={t}
          currentModel={model}
          selectedIndex={modelPickerIndex}
          width={width}
          height={height}
          searchQuery={modelSearchQuery}
          filteredModels={filteredModels}
          reasoningEffortByModel={reasoningEffortByModel}
        />
      )}
      {showRecapPicker && <RecapPickerModal t={t} enabled={recapsEnabled} width={width} height={height} />}
      {showSandboxPicker && (
        <SandboxPickerModal
          t={t}
          currentMode={sandboxMode}
          settings={sandboxSettings}
          focusIndex={sandboxSettingsFocusIndex}
          editing={sandboxSettingsEditing}
          editBuffer={sandboxSettingsEditBuffer}
          width={width}
          height={height}
        />
      )}
      {showConnectModal && (
        <ConnectModal
          t={t}
          width={width}
          height={height}
          selectedIndex={connectModalIndex}
          channels={CONNECT_CHANNELS}
        />
      )}
      {showTelegramTokenModal && (
        <TelegramTokenModal
          t={t}
          width={width}
          height={height}
          inputRef={telegramTokenInputRef}
          error={telegramTokenError}
          onSubmit={submitTelegramToken}
        />
      )}
      {showTelegramPairModal && (
        <TelegramPairModal
          t={t}
          width={width}
          height={height}
          inputRef={telegramPairInputRef}
          error={telegramPairError}
          onSubmit={() => void submitTelegramPair()}
        />
      )}
    </box>
  );
}

/* ── Session Header ──────────────────────────────────────────── */

function SessionHeader({
  t,
  sessionTitle,
  sessionId,
}: {
  t: Theme;
  modeInfo: (typeof MODES)[number];
  sessionTitle: string | null;
  sessionId: string | null;
}) {
  return (
    <box flexShrink={0} width="100%">
      <box flexDirection="row" width="100%" paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2}>
        <text>
          {sessionTitle ? (
            <span style={{ fg: t.text }}>
              <b>{sessionTitle}</b>
            </span>
          ) : null}
        </text>
        <box flexGrow={1} />
        {sessionId ? <text fg={t.textDim}>{sessionId}</text> : null}
      </box>
    </box>
  );
}

/* ── Prompt Box ──────────────────────────────────────────────── */

const TEXTAREA_KEYBINDINGS: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "return", shift: true, action: "newline" },
];

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function ContextMeter({ t, stats }: { t: Theme; stats: ContextStats }) {
  return (
    <text>
      <span style={{ fg: t.textMuted }}>{`${Math.round(stats.ratioRemaining * 100)}%`}</span>
      <span style={{ fg: t.textDim }}>{` ${formatTokenCount(stats.remainingTokens)}`}</span>
    </text>
  );
}

function PromptBox({
  t,
  inputRef,
  isProcessing,
  showModelPicker,
  showSandboxPicker,
  showSlashMenu,
  showPlanQuestions,
  showProviderModal,
  showAgentsModal,
  showAgentsEditor,
  blockPrompt,
  onSubmit,
  onPaste,
  pasteBlocks: _pasteBlocks,
  modeInfo,
  model,
  modelInfo,
  contextStats,
  placeholder,
  queuedCount,
  queuedMessages,
  typeahead,
}: {
  t: Theme;
  inputRef: React.RefObject<TextareaRenderable | null>;
  isProcessing: boolean;
  showModelPicker: boolean;
  showSandboxPicker: boolean;
  showSlashMenu: boolean;
  showPlanQuestions: boolean;
  showProviderModal: boolean;
  showAgentsModal: boolean;
  showAgentsEditor: boolean;
  blockPrompt?: boolean;
  onSubmit: () => void;
  onPaste: (event: PasteEvent) => void;
  pasteBlocks: { id: number; content: string; lines: number }[];
  modeInfo: (typeof MODES)[number];
  model: string;
  modelInfo: ReturnType<typeof getModelInfo>;
  contextStats?: ContextStats | null;
  placeholder?: string;
  queuedCount?: number;
  queuedMessages?: string[];
  typeahead?: TypeaheadState;
}) {
  const hasQueue = (queuedMessages?.length ?? 0) > 0;
  const showSuggestions = typeahead?.visible ?? false;

  return (
    <box backgroundColor={t.backgroundPanel}>
      <box>
        {hasQueue && (
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={t.queueBg}
            flexShrink={0}
          >
            {queuedMessages!.map((msg, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only queue of plain strings
              <text key={i} fg={t.text}>
                {"→ "}
                {msg}
              </text>
            ))}
            <box height={1} />
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"send now"}</span>
              <span style={{ fg: t.textDim }}>{" · "}</span>
              <span style={{ fg: t.primary }}>{"↑ "}</span>
              <span style={{ fg: t.textMuted }}>{"edit"}</span>
              <span style={{ fg: t.textDim }}>{" · "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"cancel"}</span>
            </text>
          </box>
        )}
        {showSuggestions && typeahead && (
          <SuggestionOverlay t={t} suggestions={typeahead.suggestions} selectedIndex={typeahead.selectedIndex} />
        )}
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={t.backgroundElement}
          flexDirection="column"
          flexShrink={0}
        >
          <box flexDirection="row" gap={2} alignItems="flex-start">
            <PromptModeLabel t={t} modeInfo={modeInfo} isProcessing={isProcessing} />
            <box flexGrow={1}>
              <textarea
                ref={inputRef}
                focused={
                  !showModelPicker &&
                  !showSandboxPicker &&
                  !showSlashMenu &&
                  !showPlanQuestions &&
                  !showProviderModal &&
                  !showAgentsModal &&
                  !showAgentsEditor &&
                  !blockPrompt
                }
                placeholder={
                  isProcessing ? "Queue a follow-up... (esc to interrupt)" : placeholder || "Message Crow..."
                }
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={10}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
                onPaste={onPaste as unknown as (event: PasteEvent) => void}
              />
            </box>
          </box>
          <box
            flexDirection="row"
            justifyContent="space-between"
            alignItems="center"
            paddingTop={1}
            height={isProcessing ? 3 : 1}
            flexShrink={0}
          >
            <box flexDirection="row" gap={1} alignItems="center" height={isProcessing ? 3 : 1}>
              {isProcessing ? <DotGridSpinner t={t} /> : null}
              <text fg={t.text}>{modelInfo?.name || model || "No provider selected"}</text>
              {contextStats ? <ContextMeter t={t} stats={contextStats} /> : null}
            </box>
            <box flexDirection="row" gap={1} alignItems="center" height={1}>
              {isProcessing ? (
                <box flexDirection="row" gap={1}>
                  <text fg={t.text}>
                    {"enter "}
                    <span style={{ fg: t.textMuted }}>{"queue"}</span>
                  </text>
                  <text fg={t.text}>
                    {"esc "}
                    <span style={{ fg: t.textMuted }}>{(queuedCount ?? 0) > 0 ? "clear queue" : "interrupt"}</span>
                  </text>
                </box>
              ) : showSuggestions ? (
                <box flexDirection="row" gap={1}>
                  <text fg={t.text}>
                    {"tab "}
                    <span style={{ fg: t.textMuted }}>{"accept"}</span>
                  </text>
                  <text fg={t.text}>
                    {"↑↓ "}
                    <span style={{ fg: t.textMuted }}>{"navigate"}</span>
                  </text>
                  <text fg={t.text}>
                    {"esc "}
                    <span style={{ fg: t.textMuted }}>{"dismiss"}</span>
                  </text>
                </box>
              ) : (
                <>
                  <text fg={t.text}>
                    {"@ "}
                    <span style={{ fg: t.textMuted }}>{"files"}</span>
                  </text>
                  <text fg={t.text}>
                    {"shift+enter "}
                    <span style={{ fg: t.textMuted }}>{"new line"}</span>
                  </text>
                  <text fg={t.text}>
                    {"tab "}
                    <span style={{ fg: t.textMuted }}>{"modes"}</span>
                  </text>
                </>
              )}
            </box>
          </box>
        </box>
      </box>
    </box>
  );
}

function PromptModeLabel({ modeInfo }: { t: Theme; modeInfo: (typeof MODES)[number]; isProcessing: boolean }) {
  return (
    <text fg={modeInfo.color}>
      <b>{modeInfo.label}</b>
    </text>
  );
}

function DotGridSpinner({ t }: { t: Theme }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 9), 120);
    return () => clearInterval(id);
  }, []);
  const lit = frame + 1;
  const dot = (index: number) => (
    <span key={index} style={{ fg: index < lit ? t.text : t.textMuted }}>
      {"●"}
    </span>
  );
  return (
    <box flexDirection="column">
      <text>
        {dot(0)} {dot(1)} {dot(2)}
      </text>
      <text>
        {dot(3)} {dot(4)} {dot(5)}
      </text>
      <text>
        {dot(6)} {dot(7)} {dot(8)}
      </text>
    </box>
  );
}

function CopyFlashBanner({ t, width }: { t: Theme; width: number }) {
  return (
    <box
      position="absolute"
      left={0}
      top={1}
      width={width}
      zIndex={500}
      alignItems="center"
      flexShrink={0}
      backgroundColor={t.background}
      shouldFill={false}
    >
      <box
        height={3}
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={t.queueBg}
        justifyContent="center"
        alignItems="center"
      >
        <text>
          <span style={{ fg: t.accent }}>{"✓ "}</span>
          <span style={{ fg: t.text }}>{"Copied to clipboard"}</span>
        </text>
      </box>
    </box>
  );
}

const CUSTOM_MODEL_SOURCE_OPTIONS = ["Fetch all models from base URL", "Enter model id manually"];

function ProviderConnectModal({
  t,
  width,
  height,
  inputRef,
  error,
  onSubmit,
  step,
  providers,
  providerIndex,
  customModels,
  customDraftName,
  selectedProviderName,
  loading,
}: {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
  step:
    | "list"
    | "key"
    | "customId"
    | "customName"
    | "customBaseUrl"
    | "customKey"
    | "customModelSource"
    | "customModel"
    | "customModelName"
    | "customModelList";
  providers: ProviderDefinition[];
  providerIndex: number;
  customModels: string[];
  customDraftName: string;
  selectedProviderName: string;
  loading: boolean;
}) {
  const overlayBg = "#000000cc" as string;
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    listRef.current?.scrollChildIntoView(`provider-${providerIndex}`);
  }, [providerIndex]);
  const panelWidth = Math.min(68, width - 6);
  const isList = step === "list" || step === "customModelList" || step === "customModelSource";
  const listItems =
    step === "list"
      ? [...providers.map((provider) => provider.name), "Add custom provider..."]
      : step === "customModelSource"
        ? CUSTOM_MODEL_SOURCE_OPTIONS
        : customModels;
  const panelHeight = isList ? Math.min(listItems.length + 7, Math.floor(height * 0.7)) : 13;
  const top = bottomAlignedModalTop(height, panelHeight);
  const title =
    step === "list"
      ? "Connect a provider"
      : step === "key"
        ? `API key for ${selectedProviderName}`
        : step === "customId"
          ? "Custom provider id"
          : step === "customName"
            ? "Custom provider name"
            : step === "customBaseUrl"
              ? "Custom provider base URL"
              : step === "customKey"
                ? `API key for ${customDraftName}`
                : step === "customModelSource"
                  ? `Models for ${customDraftName}`
                  : step === "customModel"
                    ? `Model id for ${customDraftName}`
                    : step === "customModelName"
                      ? `Model name for ${customDraftName}`
                      : `Pick a model for ${customDraftName}`;
  const prompt =
    step === "list"
      ? "Pick a provider. If it already has a saved key, it connects right away."
      : step === "key"
        ? "Paste the API key. It is saved to ~/.crow/user-settings.json."
        : step === "customId"
          ? "An id like openrouter. It is used in commands and settings."
          : step === "customName"
            ? "Display name, for example MiMo Router. Leave empty to use the id."
            : step === "customBaseUrl"
              ? "Base URL of the OpenAI-compatible API, for example https://example.com/v1."
              : step === "customKey"
                ? "Paste the API key for this provider."
                : step === "customModelSource"
                  ? "Fetch every model from this base URL, or enter one model id manually."
                  : step === "customModel"
                    ? "Models could not be fetched from this base URL. Type a model id instead."
                    : step === "customModelName"
                      ? "Display name for this model. Leave empty to use the model id."
                      : "Models fetched from this base URL. Pick the default model. Every fetched model will be saved.";
  const placeholder =
    step === "key" || step === "customKey"
      ? "sk-..."
      : step === "customId"
        ? "openrouter"
        : step === "customName"
          ? "My provider"
          : step === "customBaseUrl"
            ? "https://example.com/v1"
            : step === "customModel"
              ? "my-model-id"
              : step === "customModelName"
                ? "My Model"
                : "";

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{title}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>{loading ? "Fetching models..." : prompt}</text>
        </box>
        {isList ? (
          <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
            {listItems.map((item, idx) => {
              const selected = idx === providerIndex;
              return (
                <box
                  key={item}
                  id={`provider-${idx}`}
                  backgroundColor={selected ? t.selectedBg : undefined}
                  paddingLeft={2}
                  paddingRight={2}
                  width="100%"
                >
                  <text fg={selected ? t.selected : t.text}>{item}</text>
                </box>
              );
            })}
            {listItems.length === 0 && (
              <box paddingLeft={2}>
                <text fg={t.textMuted}>{"No models found"}</text>
              </box>
            )}
          </scrollbox>
        ) : (
          <box paddingLeft={2} paddingRight={2} paddingTop={1}>
            <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
              <textarea
                ref={inputRef}
                focused={true}
                placeholder={placeholder}
                textColor={t.text}
                backgroundColor={t.backgroundElement}
                placeholderColor={t.textMuted}
                minHeight={1}
                maxHeight={3}
                wrapMode="word"
                keyBindings={TEXTAREA_KEYBINDINGS}
                onSubmit={onSubmit as unknown as () => void}
              />
            </box>
          </box>
        )}
        <box flexGrow={1} minHeight={0} />
        <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{isList ? "enter " : "enter "}</span>
              <span style={{ fg: t.textMuted }}>{isList ? "select  ·  " : "save  ·  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"close"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}

/* ── Messages ────────────────────────────────────────────────── */

const USER_MSG_COLLAPSED_LINES = 5;

function UserMessageContent({ content, t, expanded }: { content: string; t: Theme; expanded: boolean }) {
  const lines = content.split("\n");
  const isLong = lines.length > USER_MSG_COLLAPSED_LINES;

  if (!isLong) {
    return <text fg={t.text}>{content}</text>;
  }

  if (expanded) {
    return (
      <>
        <text fg={t.text}>{content}</text>
        <box marginTop={1}>
          <text fg={t.textDim}>
            {"ctrl+e "}
            <span style={{ fg: t.textMuted }}>{"collapse"}</span>
          </text>
        </box>
      </>
    );
  }

  const preview = lines.slice(0, USER_MSG_COLLAPSED_LINES).join("\n");
  const hiddenCount = lines.length - USER_MSG_COLLAPSED_LINES;
  return (
    <>
      <text fg={t.text}>{preview}</text>
      <box marginTop={1}>
        <text fg={t.textDim}>
          {"ctrl+e "}
          <span style={{ fg: t.textMuted }}>{`expand (${hiddenCount} more lines)`}</span>
        </text>
      </box>
    </>
  );
}

function MessageView({
  entry,
  index,
  t,
  modeColor,
  expandedMessages,
}: {
  entry: ChatEntry;
  index: number;
  t: Theme;
  modeColor: string;
  expandedMessages?: Set<number>;
}) {
  switch (entry.type) {
    case "user":
      return (
        <box
          border={["left"]}
          customBorderChars={SPLIT}
          borderColor={entry.modeColor || modeColor}
          marginTop={index === 0 ? 0 : 1}
          marginBottom={1}
        >
          <box
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={t.backgroundPanel}
            flexShrink={0}
            flexDirection="column"
          >
            {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
            <UserMessageContent content={entry.content} t={t} expanded={expandedMessages?.has(index) ?? false} />
          </box>
        </box>
      );

    case "assistant":
      return (
        <box paddingLeft={3} marginTop={1} flexShrink={0} flexDirection="column">
          {entry.sourceLabel ? <text fg={t.textMuted}>{entry.sourceLabel}</text> : null}
          {entry.thought ? (
            <ThoughtLine t={t} durationMs={entry.thought.durationMs} fullText={entry.thought.text} />
          ) : null}
          {entry.thought ? (
            <box marginTop={1} flexShrink={0}>
              <Markdown content={entry.content} t={t} />
            </box>
          ) : (
            <Markdown content={entry.content} t={t} />
          )}
        </box>
      );

    case "tool_call":
      return (
        <box paddingLeft={3} marginTop={1}>
          <text>
            <span style={{ fg: entry.modeColor || modeColor }}>{"▣ "}</span>
            <span style={{ fg: t.textMuted }}>{entry.content.replace("▣  ", "")}</span>
          </text>
        </box>
      );

    case "tool_result": {
      const name = entry.toolCall?.function.name || "tool";
      const args = toolArgs(entry.toolCall);
      const diff = entry.toolResult?.diff;
      const plan = entry.toolResult?.plan;

      if (name === "generate_plan" && plan) {
        return <PlanView plan={plan} t={t} />;
      }

      if ((name === "task" || name === "subagent") && entry.toolResult?.task) {
        return <TaskResultView t={t} entry={entry} />;
      }

      if ((name === "delegate" || name === "subagent") && entry.toolResult?.delegation) {
        return <DelegationResultView t={t} entry={entry} />;
      }

      if (name === "delegation_list") {
        return <DelegationListView t={t} content={entry.content} />;
      }

      if (name === "delegation_read") {
        return <ToolTextOutputView t={t} label={toolLabel(entry.toolCall!)} content={entry.content} />;
      }

      if (name === "lsp") {
        const lspOp = tryParseArg(entry.toolCall, "operation") || "query";
        const lspFile = tryParseArg(entry.toolCall, "filePath") || "";
        const lspLine = tryParseArg(entry.toolCall, "line");
        const lspPos = lspLine ? `:${lspLine}` : "";
        return (
          <box gap={0} marginTop={1}>
            <InlineTool t={t} pending={false}>
              {`lsp ${lspOp} ${lspFile}${lspPos}`}
            </InlineTool>
            <LspResultView t={t} operation={lspOp} filePath={lspFile} position={lspPos} content={entry.content} />
          </box>
        );
      }

      if ((entry.toolResult?.media?.length ?? 0) > 0) {
        if (name === "generate_image" || name === "generate_video") {
          return <MediaAutoOpenView t={t} label={toolLabel(entry.toolCall!)} toolResult={entry.toolResult!} />;
        }
        return <MediaToolResultView t={t} label={toolLabel(entry.toolCall!)} toolResult={entry.toolResult!} />;
      }

      if (name === "write_file" || name === "edit_file") {
        const filePath = diff?.filePath || tryParseArg(entry.toolCall, "path") || args;
        const label = name === "write_file" ? `Write ${filePath}` : `Edit ${filePath}`;
        return (
          <box gap={0}>
            <InlineTool t={t} pending={false}>
              {label}
            </InlineTool>
            {diff && <DiffView t={t} diff={diff} />}
            {(entry.toolResult?.lspDiagnostics?.length ?? 0) > 0 && (
              <LspDiagnosticsView t={t} diagnostics={entry.toolResult?.lspDiagnostics ?? []} />
            )}
          </box>
        );
      }

      if (name === "bash" && entry.toolResult?.backgroundProcess) {
        const bp = entry.toolResult.backgroundProcess;
        return <BackgroundProcessLine t={t} id={bp.id} pid={bp.pid} command={bp.command} />;
      }

      if (name === "process_logs") {
        return <ProcessLogsView t={t} content={entry.content} />;
      }

      if (name === "process_stop" || name === "process_list") {
        return (
          <InlineTool t={t} pending={false}>
            {entry.content}
          </InlineTool>
        );
      }

      if (name === "read_file")
        return (
          <InlineTool
            t={t}
            pending={false}
          >{`Read ${trunc(tryParseArg(entry.toolCall, "path") || args, 60)}`}</InlineTool>
        );
      if (name === "search_web" || name === "search_x")
        return (
          <InlineTool t={t} pending={false}>
            {name === "search_web" ? "Web" : "X"}
            {` Search "${trunc(args, 60)}"`}
          </InlineTool>
        );

      return (
        <InlineTool t={t} pending={false}>
          {trunc(name === "bash" ? args : `${name} ${args}`, 80)}
        </InlineTool>
      );
    }

    default:
      return <text fg={t.textMuted}>{entry.content}</text>;
  }
}

/* ── Diff View ────────────────────────────────────────────────── */

type DiffRow =
  | { kind: "context"; oldNum: number; newNum: number; text: string }
  | { kind: "added"; newNum: number; text: string }
  | { kind: "removed"; oldNum: number; text: string }
  | { kind: "separator"; count: number };

const MAX_DIFF_ROWS = 20;
const LINE_NUM_WIDTH = 4;

function parsePatch(patch: string): DiffRow[] {
  const lines = patch.split("\n");
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let prevOldEnd = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      const skipped = oldLine - prevOldEnd - 1;
      if (skipped > 0) {
        rows.push({ kind: "separator", count: skipped });
      }
      continue;
    }

    if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\")) continue;
    if (line.startsWith("Index:") || line.startsWith("====")) continue;

    if (line.startsWith("-")) {
      rows.push({ kind: "removed", oldNum: oldLine, text: line.slice(1) });
      oldLine++;
      prevOldEnd = oldLine - 1;
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", newNum: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.length > 0 || (oldLine > 0 && newLine > 0)) {
      const content = line.startsWith(" ") ? line.slice(1) : line;
      rows.push({ kind: "context", oldNum: oldLine, newNum: newLine, text: content });
      oldLine++;
      newLine++;
      prevOldEnd = oldLine - 1;
    }
  }

  return rows;
}

function DiffView({ t, diff }: { t: Theme; diff: FileDiff }) {
  const rows = parsePatch(diff.patch);
  if (rows.length === 0) return null;

  const truncated = rows.length > MAX_DIFF_ROWS;
  const visible = truncated ? rows.slice(0, MAX_DIFF_ROWS) : rows;

  const pad = (n: number | undefined) =>
    n !== undefined ? String(n).padStart(LINE_NUM_WIDTH) : " ".repeat(LINE_NUM_WIDTH);

  return (
    <box paddingLeft={5} marginTop={0} flexShrink={0}>
      <box flexDirection="column">
        {/* Header */}
        <box backgroundColor={t.diffHeader} paddingLeft={1} paddingRight={1}>
          <text>
            <span style={{ fg: t.diffHeaderFg }}>{diff.filePath}</span>
            <span style={{ fg: t.textDim }}>{"  "}</span>
            <span style={{ fg: t.diffRemovedFg }}>{`-${diff.removals}`}</span>
            <span style={{ fg: t.textDim }}> </span>
            <span style={{ fg: t.diffAddedFg }}>{`+${diff.additions}`}</span>
          </text>
        </box>

        {/* Rows */}
        {visible.map((row, i) => {
          if (row.kind === "separator") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: separator rows lack unique identifiers
              <box key={`sep-${i}`} backgroundColor={t.diffSeparator} paddingLeft={1}>
                <text fg={t.diffSeparatorFg}>
                  {"⌃  "}
                  {row.count}
                  {" unmodified lines"}
                </text>
              </box>
            );
          }
          if (row.kind === "removed") {
            return (
              <box key={`rm-${row.oldNum}`} backgroundColor={t.diffRemoved} flexDirection="row">
                <text fg={t.diffRemovedLineNum}>{pad(row.oldNum)}</text>
                <text fg={t.diffRemovedFg}>{` ${row.text}`}</text>
              </box>
            );
          }
          if (row.kind === "added") {
            return (
              <box key={`add-${row.newNum}`} backgroundColor={t.diffAdded} flexDirection="row">
                <text fg={t.diffAddedLineNum}>{pad(row.newNum)}</text>
                <text fg={t.diffAddedFg}>{` ${row.text}`}</text>
              </box>
            );
          }
          return (
            <box key={`ctx-${row.oldNum}`} backgroundColor={t.diffContext} flexDirection="row">
              <text fg={t.diffLineNumber}>{pad(row.oldNum)}</text>
              <text fg={t.diffContextFg}>{` ${row.text}`}</text>
            </box>
          );
        })}

        {truncated && (
          <box backgroundColor={t.diffSeparator} paddingLeft={1}>
            <text fg={t.diffSeparatorFg}>
              {"⌃  "}
              {rows.length - MAX_DIFF_ROWS}
              {" more lines"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

const MAX_LSP_RESULT_LINES = 10;

function LspResultView({
  t,
  operation,
  filePath,
  position,
  content,
}: {
  t: Theme;
  operation: string;
  filePath: string;
  position: string;
  content: string;
}) {
  const body = content.trim();
  const lines = body.split("\n");
  const truncated = lines.length > MAX_LSP_RESULT_LINES;
  const visible = truncated ? lines.slice(0, MAX_LSP_RESULT_LINES).join("\n") : body;
  const label = `${operation} ${filePath}${position}`;

  return (
    <box paddingLeft={5} marginTop={0} flexShrink={0}>
      <box flexDirection="column">
        <box backgroundColor={t.diffHeader} paddingLeft={1} paddingRight={1}>
          <text>
            <span style={{ fg: t.primary }}>{"lsp"}</span>
            <span style={{ fg: t.textDim }}>{" · "}</span>
            <span style={{ fg: t.diffHeaderFg }}>{label}</span>
          </text>
        </box>
        <box backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1}>
          <text fg={t.mdCodeBlockFg}>{visible}</text>
        </box>
        {truncated && (
          <box backgroundColor={t.diffSeparator} paddingLeft={1}>
            <text fg={t.diffSeparatorFg}>
              {"⌃  "}
              {lines.length - MAX_LSP_RESULT_LINES}
              {" more lines"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}

function LspDiagnosticsView({ t, diagnostics }: { t: Theme; diagnostics: NonNullable<ToolResult["lspDiagnostics"]> }) {
  const files = diagnostics.slice(0, 3);
  return (
    <box paddingLeft={5} marginTop={1}>
      <box flexDirection="column">
        <box>
          <text fg={t.textMuted}>{"LSP diagnostics"}</text>
        </box>
        {files.map((entry) => (
          <box key={`${entry.serverId}:${entry.filePath}`} flexDirection="column">
            <text fg={t.textDim}>{`${entry.serverId} • ${entry.filePath}`}</text>
            {entry.diagnostics.slice(0, 5).map((diagnostic, index) => (
              <text
                // biome-ignore lint/suspicious/noArrayIndexKey: diagnostics may not include stable ids
                key={`${entry.serverId}:${entry.filePath}:${index}`}
                fg={diagnostic.severity === 1 ? t.diffRemovedFg : diagnostic.severity === 2 ? t.primary : t.textMuted}
              >
                {`${formatLspSeverity(diagnostic.severity)} ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.message}`}
              </text>
            ))}
          </box>
        ))}
      </box>
    </box>
  );
}

function formatLspSeverity(severity?: number): string {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "issue";
  }
}

const THINKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatThoughtDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function ThoughtLine({ t, durationMs, fullText }: { t: Theme; durationMs: number; fullText: string }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = fullText.trim().length > 0;
  return (
    <box flexDirection="column" flexShrink={0}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: click toggles the expanded thinking text */}
      <box flexShrink={0} onMouseUp={expandable ? () => setExpanded((value) => !value) : undefined}>
        <text fg={t.textMuted}>
          Thought • {formatThoughtDuration(durationMs)}
          {expandable ? (expanded ? " · click to collapse" : " · click to expand") : ""}
        </text>
      </box>
      {expanded && (
        <box flexShrink={0}>
          <Markdown content={fullText} t={t} />
        </box>
      )}
    </box>
  );
}

function ThinkingSpinner({ t, label }: { t: Theme; label: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % THINKING_FRAMES.length), 80);
    return () => clearInterval(id);
  }, []);
  return (
    <box paddingLeft={3}>
      <text>
        <span style={{ fg: t.textMuted }}>{THINKING_FRAMES[frame]}</span>
        <span style={{ fg: t.textMuted }}> {label}</span>
      </text>
    </box>
  );
}

function InlineTool({ t, pending: _pending, children }: { t: Theme; pending: boolean; children: React.ReactNode }) {
  return (
    <box paddingLeft={3}>
      <text fg={t.textMuted}>
        {"→ "}
        {children}
      </text>
    </box>
  );
}

function SubagentTaskLine({ t, agent, label, pending }: { t: Theme; agent: string; label: string; pending: boolean }) {
  const displayLabel = compactTaskLabel(label);
  const displayAgent = formatSubagentName(agent);

  return (
    <box paddingLeft={3}>
      <text>
        {pending ? <span style={{ fg: t.subagentAccent }}>{"○"}</span> : null}
        {pending ? " " : ""}
        <span style={{ fg: t.subagentAccent }}>
          <b>{`${displayAgent}: ${displayLabel}`}</b>
        </span>
      </text>
    </box>
  );
}

function DelegationTaskLine({ t, label, pending, id }: { t: Theme; label: string; pending: boolean; id?: string }) {
  const displayLabel = compactTaskLabel(label);

  return (
    <box paddingLeft={3}>
      <text>
        {pending ? (
          <span style={{ fg: t.subagentAccent }}>{"○"}</span>
        ) : (
          <span style={{ fg: t.subagentAccent }}>{"◆"}</span>
        )}{" "}
        <span style={{ fg: t.subagentAccent }}>
          <b>{"Background"}</b>
        </span>
        <span style={{ fg: t.textMuted }}>
          {" — "}
          {displayLabel}
        </span>
        {id ? <span style={{ fg: t.textDim }}>{`  (${id})`}</span> : null}
      </text>
    </box>
  );
}

function SubagentActivity({ t, status }: { t: Theme; status: SubagentStatus }) {
  return (
    <box paddingLeft={5}>
      <text fg={t.textMuted}>
        {"→ "}
        {truncateLine(status.detail, 100)}
      </text>
    </box>
  );
}

function TaskResultView({ t, entry }: { t: Theme; entry: ChatEntry }) {
  const task = entry.toolResult?.task;
  if (!task) return null;

  return (
    <box gap={0}>
      <SubagentTaskLine t={t} agent={task.agent} label={task.description} pending={false} />
      <box paddingLeft={5}>
        <text fg={t.text}>
          {formatSubagentName(task.agent)}
          {": "}
          {truncateLine(task.summary, 90)}
        </text>
      </box>
    </box>
  );
}

function DelegationResultView({ t, entry }: { t: Theme; entry: ChatEntry }) {
  const delegation = entry.toolResult?.delegation;
  if (!delegation) return null;

  return <DelegationTaskLine t={t} label={delegation.description} pending={false} id={delegation.id} />;
}

function DelegationListView({ t, content }: { t: Theme; content: string }) {
  const items = parseDelegationList(content);

  if (items.length === 0) {
    return (
      <InlineTool t={t} pending={false}>
        {"No background delegations"}
      </InlineTool>
    );
  }

  return (
    <box paddingLeft={3} gap={0}>
      {items.map((item) => {
        const statusColor =
          item.status === "complete"
            ? "#8adf8a"
            : item.status === "running"
              ? t.subagentAccent
              : item.status === "error"
                ? "#df8a8a"
                : t.textMuted;

        return (
          <box key={item.id}>
            <text>
              <span style={{ fg: statusColor }}>{"◆ "}</span>
              <span style={{ fg: t.text }}>{item.id}</span>
              <span style={{ fg: statusColor }}>{` ${item.status}`}</span>
              <span style={{ fg: t.textMuted }}>
                {" — "}
                {truncateLine(item.label, 60)}
              </span>
            </text>
          </box>
        );
      })}
    </box>
  );
}

function parseDelegationList(content: string): { id: string; status: string; label: string }[] {
  const items: { id: string; status: string; label: string }[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/`([^`]+)`\s+\[(\w+)]\s+(.*)/);
    if (match) {
      items.push({ id: match[1], status: match[2], label: match[3].trim() });
    }
  }
  return items;
}

function BackgroundProcessLine({ t, id, pid, command }: { t: Theme; id: number; pid: number; command: string }) {
  return (
    <box paddingLeft={3}>
      <text>
        <span style={{ fg: t.subagentAccent }}>{"◆ "}</span>
        <span style={{ fg: t.subagentAccent }}>
          <b>{"Background process"}</b>
        </span>
        <span style={{ fg: t.textMuted }}>{` id:${id} pid:${pid}`}</span>
        <span style={{ fg: t.textDim }}>
          {" — "}
          {truncateLine(command, 60)}
        </span>
      </text>
    </box>
  );
}

function formatScheduleDetails(schedule: StoredSchedule, daemonStatus: ScheduleDaemonStatus): string {
  const daemonText = daemonStatus.running
    ? `running${daemonStatus.pid ? ` (pid ${daemonStatus.pid})` : ""}`
    : "not running";
  return [
    `Schedule: ${schedule.name}`,
    `ID: ${schedule.id}`,
    `Type: ${schedule.cron ? "recurring" : "one-time"}`,
    `Cron: ${schedule.cron ?? "runs once immediately"}`,
    `Enabled: ${schedule.enabled ? "yes" : "no"}`,
    `Model: ${schedule.model}`,
    `Directory: ${schedule.directory}`,
    `Last run: ${schedule.lastRunAt ?? "never"}`,
    `Daemon: ${daemonText}`,
    "",
    "Instruction:",
    schedule.instruction,
  ].join("\n");
}

function ProcessLogsView({ t, content }: { t: Theme; content: string }) {
  const lines = content.split("\n");
  const header = lines[0] || "";
  const body = lines.slice(1).join("\n").trim();

  return (
    <box paddingLeft={3} gap={0}>
      <text fg={t.textMuted}>
        {"→ "}
        {header}
      </text>
      {body ? (
        <box paddingLeft={2} marginTop={0}>
          <box backgroundColor={t.mdCodeBlockBg} paddingLeft={1} paddingRight={1}>
            <text fg={t.mdCodeBlockFg}>{truncateBlock(body, 15)}</text>
          </box>
        </box>
      ) : null}
    </box>
  );
}

function truncateBlock(text: string, maxLines: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines`].join("\n");
}

function ToolTextOutputView({ t, label, content }: { t: Theme; label: string; content: string }) {
  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
      <box paddingLeft={5} marginTop={1} flexShrink={0}>
        <Markdown content={content} t={t} />
      </box>
    </box>
  );
}

function openMediaFile(filePath: string): void {
  try {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    require("child_process").execFile(cmd, [filePath]);
  } catch {}
}

function MediaAutoOpenView({ t, label, toolResult }: { t: Theme; label: string; toolResult: ToolResult }) {
  const media = toolResult.media ?? [];
  const openedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const asset of media) {
      if (!openedRef.current.has(asset.path)) {
        openedRef.current.add(asset.path);
        openMediaFile(asset.path);
      }
    }
  }, [media]);

  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
    </box>
  );
}

function MediaToolResultView({ t, label, toolResult }: { t: Theme; label: string; toolResult: ToolResult }) {
  const media = toolResult.media ?? [];

  return (
    <box gap={0}>
      <InlineTool t={t} pending={false}>
        {label}
      </InlineTool>
      {toolResult.output ? (
        <box paddingLeft={5} marginTop={1} flexShrink={0}>
          <Markdown content={toolResult.output} t={t} />
        </box>
      ) : null}
      {media.length > 0 ? (
        <box paddingLeft={5} marginTop={toolResult.output ? 1 : 0} flexDirection="column">
          {media.map((asset) => (
            <box
              key={`${asset.path}-${asset.url ?? ""}-${asset.sourcePath ?? ""}-${asset.sourceUrl ?? ""}`}
              flexDirection="column"
            >
              <text fg={t.text}>{asset.path}</text>
              {asset.url ? <text fg={t.textMuted}>{`url: ${asset.url}`}</text> : null}
              {asset.sourcePath ? <text fg={t.textMuted}>{`source: ${asset.sourcePath}`}</text> : null}
              {asset.sourceUrl ? <text fg={t.textMuted}>{`source_url: ${asset.sourceUrl}`}</text> : null}
            </box>
          ))}
        </box>
      ) : null}
    </box>
  );
}

/* ── Slash Menu ──────────────────────────────────────────────── */

function bottomAlignedModalTop(height: number, panelHeight: number): number {
  return Math.max(2, Math.floor((height - panelHeight) / 2));
}

/* ── Update Modal ────────────────────────────────────────────── */

function UpdateModal({
  t,
  width,
  height,
  currentVersion,
  latestVersion,
}: {
  t: Theme;
  width: number;
  height: number;
  currentVersion: string;
  latestVersion: string;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(60, width - 6);
  const panelHeight = 9;
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg="#f59e0b">
            <b>{"Update Available"}</b>
          </text>
          <text fg={t.textMuted}>{"esc to dismiss"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>
            {"A new version of crow is available: "}
            <span style={{ fg: t.textMuted }}>
              {"v"}
              {currentVersion}
            </span>
            {" → "}
            <span style={{ fg: "#22c55e" }}>
              {"v"}
              {latestVersion}
            </span>
          </text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>{"Press enter to update now, or esc to dismiss"}</text>
        </box>
      </box>
    </box>
  );
}

function SlashMenuModal({
  t,
  selectedIndex,
  width,
  height,
  searchQuery,
  filteredItems,
}: {
  t: Theme;
  selectedIndex: number;
  width: number;
  height: number;
  searchQuery: string;
  filteredItems: SlashMenuItem[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const item = filteredItems[selectedIndex];
    if (item) listRef.current?.scrollChildIntoView(`slash-${item.id}`);
  }, [selectedIndex, filteredItems]);

  const itemCount = Math.max(filteredItems.length, 1);
  const contentHeight = itemCount + 5;
  const maxH = Math.floor(height * 0.6);
  const panelHeight = Math.min(contentHeight, maxH);
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(50, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Commands"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search..."}</span>}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {filteredItems.map((item, idx) => (
            <box
              key={item.id}
              id={`slash-${item.id}`}
              backgroundColor={idx === selectedIndex ? t.selectedBg : undefined}
              paddingLeft={2}
              paddingRight={2}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={idx === selectedIndex ? t.selected : t.text}>
                  {"/"}
                  {item.label}
                </text>
                <text fg={t.textMuted}>{item.description}</text>
              </box>
            </box>
          ))}
          {filteredItems.length === 0 && (
            <box paddingLeft={2}>
              <text fg={t.textMuted}>{"No commands match your search"}</text>
            </box>
          )}
        </scrollbox>
      </box>
    </box>
  );
}

function ConnectModal({
  t,
  width,
  height,
  selectedIndex,
  channels,
}: {
  t: Theme;
  width: number;
  height: number;
  selectedIndex: number;
  channels: { id: string; label: string; description: string }[];
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const ch = channels[selectedIndex];
    if (ch) listRef.current?.scrollChildIntoView(`connect-${ch.id}`);
  }, [selectedIndex, channels]);

  const panelHeight = Math.min(channels.length + 9, Math.floor(height * 0.5));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(56, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Connect"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.textMuted}>{"Choose a channel"}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {channels.map((ch, idx) => (
            <box
              key={ch.id}
              id={`connect-${ch.id}`}
              backgroundColor={idx === selectedIndex ? t.selectedBg : undefined}
              paddingLeft={2}
              paddingRight={2}
            >
              <box flexDirection="row" justifyContent="space-between">
                <text fg={idx === selectedIndex ? t.selected : t.text}>{ch.label}</text>
                <text fg={t.textMuted}>{ch.description}</text>
              </box>
            </box>
          ))}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          <text>
            <span style={{ fg: t.primary }}>{"enter "}</span>
            <span style={{ fg: t.textMuted }}>{"select  ·  "}</span>
            <span style={{ fg: t.primary }}>{"↑↓ "}</span>
            <span style={{ fg: t.textMuted }}>{"navigate  ·  "}</span>
            <span style={{ fg: t.primary }}>{"esc "}</span>
            <span style={{ fg: t.textMuted }}>{"close"}</span>
          </text>
        </box>
      </box>
    </box>
  );
}

function TelegramTokenModal({
  t,
  width,
  height,
  inputRef,
  error,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = 14;
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Telegram bot token"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>
            {"From @BotFather: /newbot, then paste the token here. Stored in ~/.crow/user-settings.json."}
          </text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
            <textarea
              ref={inputRef}
              focused={true}
              placeholder="123456:ABC..."
              textColor={t.text}
              backgroundColor={t.backgroundElement}
              placeholderColor={t.textMuted}
              minHeight={1}
              maxHeight={3}
              wrapMode="word"
              keyBindings={TEXTAREA_KEYBINDINGS}
              onSubmit={onSubmit as unknown as () => void}
            />
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
        <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"save token  ·  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"close"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}

function TelegramPairModal({
  t,
  width,
  height,
  inputRef,
  error,
  onSubmit,
}: {
  t: Theme;
  width: number;
  height: number;
  inputRef: React.RefObject<TextareaRenderable | null>;
  error: string | null;
  onSubmit: () => void;
}) {
  const overlayBg = "#000000cc" as string;
  const panelWidth = Math.min(68, width - 6);
  const panelHeight = 13;
  const top = bottomAlignedModalTop(height, panelHeight);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={panelWidth}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Pairing code"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.text}>{"DM your bot with /pair, then paste the 6-character code."}</text>
        </box>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <box backgroundColor={t.backgroundElement} paddingLeft={1} paddingRight={1} width="100%">
            <textarea
              ref={inputRef}
              focused={true}
              placeholder="ABC123"
              textColor={t.text}
              backgroundColor={t.backgroundElement}
              placeholderColor={t.textMuted}
              minHeight={1}
              maxHeight={2}
              wrapMode="word"
              keyBindings={TEXTAREA_KEYBINDINGS}
              onSubmit={onSubmit as unknown as () => void}
            />
          </box>
        </box>
        <box flexGrow={1} minHeight={0} />
        <box paddingLeft={2} paddingRight={2} paddingTop={2} paddingBottom={1}>
          {error ? (
            <text fg={t.diffRemovedFg}>{error}</text>
          ) : (
            <text>
              <span style={{ fg: t.primary }}>{"enter "}</span>
              <span style={{ fg: t.textMuted }}>{"approve pairing  ·  "}</span>
              <span style={{ fg: t.primary }}>{"esc "}</span>
              <span style={{ fg: t.textMuted }}>{"close"}</span>
            </text>
          )}
        </box>
      </box>
    </box>
  );
}

/* ── Model Picker ────────────────────────────────────────────── */

function ModelPickerModal({
  t,
  currentModel,
  selectedIndex,
  width,
  height,
  searchQuery,
  filteredModels,
  reasoningEffortByModel,
}: {
  t: Theme;
  currentModel: string;
  selectedIndex: number;
  width: number;
  height: number;
  searchQuery: string;
  filteredModels: ModelInfo[];
  reasoningEffortByModel: Record<string, ReasoningEffort>;
}) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    const m = filteredModels[selectedIndex];
    if (m) listRef.current?.scrollChildIntoView(`model-${m.id}`);
  }, [selectedIndex, filteredModels]);

  const itemCount = Math.max(filteredModels.length, 1);
  const selectedModel = filteredModels[selectedIndex];
  const selectedSupportsReasoning = !!selectedModel && getSupportedReasoningEfforts(selectedModel.id).length > 0;
  const contentHeight = itemCount + 6;
  const maxH = Math.floor(height * 0.6);
  const panelHeight = Math.min(contentHeight, maxH);
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;
  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(60, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Select model"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <text fg={t.text}>{searchQuery || <span style={{ fg: t.textMuted }}>{"Search..."}</span>}</text>
        </box>
        <scrollbox ref={listRef} flexGrow={1} minHeight={0}>
          {filteredModels.map((m, idx) => {
            const selected = idx === selectedIndex;
            const current = m.id === currentModel;
            const supportedReasoningEfforts = getSupportedReasoningEfforts(m.id);
            const reasoningEffort =
              getEffectiveReasoningEffort(m.id, reasoningEffortByModel[normalizeModelId(m.id)]) ?? "auto";
            return (
              <box
                key={m.id}
                id={`model-${m.id}`}
                backgroundColor={selected ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
                width="100%"
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={current ? t.accent : selected ? t.selected : t.text}>{m.name}</text>
                  {supportedReasoningEfforts.length > 0 ? (
                    <text fg={selected ? t.primary : t.textMuted}>{`[${reasoningEffort}]`}</text>
                  ) : null}
                </box>
              </box>
            );
          })}
          {filteredModels.length === 0 && (
            <box paddingLeft={2}>
              <text fg={t.textMuted}>{"No models match your search"}</text>
            </box>
          )}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>
            {selectedSupportsReasoning ? "left/right reasoning  enter select  esc close" : "enter select  esc close"}
          </text>
        </box>
      </box>
    </box>
  );
}

function SandboxPickerModal({
  t,
  currentMode,
  settings,
  focusIndex,
  editing,
  editBuffer,
  width,
  height,
}: {
  t: Theme;
  currentMode: SandboxMode;
  settings: SandboxSettings;
  focusIndex: number;
  editing: string | null;
  editBuffer: string;
  width: number;
  height: number;
}) {
  const visibleRows = getSandboxVisibleRows(currentMode);
  const panelHeight = Math.min(visibleRows.length + 6, Math.floor(height * 0.6));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(64, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Sandbox settings"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <scrollbox flexGrow={1} minHeight={0}>
          {visibleRows.map((row, idx) => {
            const focused = idx === focusIndex;
            const isEditing = editing === row.key;
            const display = row.getDisplay(currentMode, settings);
            return (
              <box
                key={row.key}
                backgroundColor={focused ? t.selectedBg : undefined}
                paddingLeft={2}
                paddingRight={2}
                width="100%"
              >
                <box width="100%" flexDirection="row" justifyContent="space-between">
                  <text fg={focused ? t.selected : t.text}>{row.label}</text>
                  {isEditing ? (
                    <text fg={t.accent}>
                      {editBuffer || row.placeholder || ""}
                      {"_"}
                    </text>
                  ) : row.type === "toggle" ? (
                    <text fg={focused ? t.primary : t.textMuted}>
                      {"< "}
                      {display}
                      {" >"}
                    </text>
                  ) : (
                    <text fg={focused ? t.primary : t.textMuted}>{display}</text>
                  )}
                </box>
              </box>
            );
          })}
        </scrollbox>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>
            {editing
              ? "type value  enter confirm  esc cancel"
              : "arrows navigate  left/right toggle  enter edit  esc close"}
          </text>
        </box>
      </box>
    </box>
  );
}

function RecapPickerModal({
  t,
  enabled,
  width,
  height,
}: {
  t: Theme;
  enabled: boolean;
  width: number;
  height: number;
}) {
  const panelHeight = Math.min(7, Math.floor(height * 0.6));
  const top = bottomAlignedModalTop(height, panelHeight);
  const overlayBg = "#000000cc" as string;
  const display = formatRecapsEnabled(enabled);

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width}
      height={height}
      alignItems="center"
      paddingTop={top}
      backgroundColor={overlayBg}
    >
      <box
        width={Math.min(64, width - 6)}
        height={panelHeight}
        backgroundColor={t.backgroundPanel}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
      >
        <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
          <text fg={t.primary}>
            <b>{"Recap settings"}</b>
          </text>
          <text fg={t.textMuted}>{"esc"}</text>
        </box>
        <box flexGrow={1} minHeight={0}>
          <box backgroundColor={t.selectedBg} paddingLeft={2} paddingRight={2} width="100%">
            <box width="100%" flexDirection="row" justifyContent="space-between">
              <text fg={t.selected}>{"Recaps"}</text>
              <text fg={t.primary}>
                {"< "}
                {display}
                {" >"}
              </text>
            </box>
          </box>
        </box>
        <box flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={t.textMuted}>{"left/right toggle  enter cycle  esc close"}</text>
        </box>
      </box>
    </box>
  );
}

function PaymentApprovalPanel({
  t,
  payment,
}: {
  t: Theme;
  payment: {
    url: string;
    description: string;
    security: string;
    securityLabel: string;
    securityUrl: string;
    amount: string;
    network: string;
    asset: string;
    approvalId?: string;
    selected: number;
  };
}) {
  const options = ["Approve payment", "Reject"];
  return (
    <box
      flexDirection="column"
      border={["left"]}
      customBorderChars={{
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
      }}
      borderColor="#e5c07b"
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={t.backgroundPanel}
    >
      <text>
        <span style={{ fg: t.planTitle ?? t.primary }}>
          <b>{"Payment required"}</b>
        </span>
      </text>
      <box marginTop={1} flexDirection="column">
        <text>
          <span style={{ fg: t.text }}>{payment.url}</span>
        </text>
        {payment.description ? (
          <text>
            <span style={{ fg: t.textMuted }}>{payment.description}</span>
          </text>
        ) : null}
        {payment.security ? (
          <text>
            <span style={{ fg: t.textMuted }}>{"Security: "}</span>
            <span style={{ fg: "#60a5fa" }}>{payment.securityLabel}</span>
          </text>
        ) : null}
        <text>
          <span style={{ fg: t.textMuted }}>{"Price: "}</span>
          <span style={{ fg: "#22c55e" }}>
            <b>{`${payment.amount} USDC`}</b>
          </span>
          <span style={{ fg: t.textMuted }}>{` on ${payment.network}`}</span>
        </text>
      </box>
      <box marginTop={1} flexDirection="column">
        {options.map((label, i) => {
          const isSel = i === payment.selected;
          return (
            <text key={label}>
              <span style={{ fg: isSel ? "#22c55e" : t.textMuted }}>{isSel ? "> " : "  "}</span>
              <span style={{ fg: isSel ? t.text : t.textMuted }}>{isSel ? <b>{label}</b> : label}</span>
            </text>
          );
        })}
      </box>
      <box flexDirection="row" gap={3} marginTop={1} flexShrink={0}>
        <text>
          <span style={{ fg: t.text }}>{"↑↓"}</span>
          <span style={{ fg: t.textMuted }}>{" select"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"enter"}</span>
          <span style={{ fg: t.textMuted }}>{" confirm"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"esc"}</span>
          <span style={{ fg: t.textMuted }}>{" reject"}</span>
        </text>
      </box>
    </box>
  );
}

function QuestionPanel({
  t,
  question,
}: {
  t: Theme;
  question: {
    question: string;
    options: string[];
    selected: number;
  };
}) {
  return (
    <box
      flexDirection="column"
      border={["left"]}
      customBorderChars={{
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
      }}
      borderColor="#61afef"
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={t.backgroundPanel}
    >
      <text>
        <span style={{ fg: t.planTitle ?? t.primary }}>
          <b>{"Question"}</b>
        </span>
      </text>
      <box marginTop={1}>
        <text>
          <span style={{ fg: t.text }}>{question.question}</span>
        </text>
      </box>
      <box marginTop={1} flexDirection="column">
        {question.options.map((label, i) => {
          const isSel = i === question.selected;
          return (
            <text key={label}>
              <span style={{ fg: isSel ? "#22c55e" : t.textMuted }}>{isSel ? "> " : "  "}</span>
              <span style={{ fg: isSel ? t.text : t.textMuted }}>{isSel ? <b>{label}</b> : label}</span>
            </text>
          );
        })}
      </box>
      <box flexDirection="row" gap={3} marginTop={1} flexShrink={0}>
        <text>
          <span style={{ fg: t.text }}>{"↑↓"}</span>
          <span style={{ fg: t.textMuted }}>{" select"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"enter"}</span>
          <span style={{ fg: t.textMuted }}>{" confirm"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"esc"}</span>
          <span style={{ fg: t.textMuted }}>{" decline"}</span>
        </text>
      </box>
    </box>
  );
}

function PermissionApprovalPanel({
  t,
  permission,
}: {
  t: Theme;
  permission: {
    action: string;
    resource: string;
    toolName: string;
    selected: number;
  };
}) {
  const options = ["Allow once", "Always allow", "Deny"];
  return (
    <box
      flexDirection="column"
      border={["left"]}
      customBorderChars={{
        topLeft: "",
        bottomLeft: "",
        vertical: "┃",
        topRight: "",
        bottomRight: "",
        horizontal: " ",
        bottomT: "",
        topT: "",
        cross: "",
        leftT: "",
        rightT: "",
      }}
      borderColor="#e5c07b"
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={t.backgroundPanel}
    >
      <text>
        <span style={{ fg: t.planTitle ?? t.primary }}>
          <b>{"Permission required"}</b>
        </span>
      </text>
      <box marginTop={1} flexDirection="column">
        <text>
          <span style={{ fg: t.textMuted }}>{"Tool: "}</span>
          <span style={{ fg: t.text }}>{permission.toolName}</span>
        </text>
        {permission.resource ? (
          <text>
            <span style={{ fg: t.textMuted }}>{"Target: "}</span>
            <span style={{ fg: t.text }}>{permission.resource}</span>
          </text>
        ) : null}
      </box>
      <box marginTop={1} flexDirection="column">
        {options.map((label, i) => {
          const isSel = i === permission.selected;
          return (
            <text key={label}>
              <span style={{ fg: isSel ? "#22c55e" : t.textMuted }}>{isSel ? "> " : "  "}</span>
              <span style={{ fg: isSel ? t.text : t.textMuted }}>{isSel ? <b>{label}</b> : label}</span>
            </text>
          );
        })}
      </box>
      <box flexDirection="row" gap={3} marginTop={1} flexShrink={0}>
        <text>
          <span style={{ fg: t.text }}>{"↑↓"}</span>
          <span style={{ fg: t.textMuted }}>{" select"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"enter"}</span>
          <span style={{ fg: t.textMuted }}>{" confirm"}</span>
        </text>
        <text>
          <span style={{ fg: t.text }}>{"esc"}</span>
          <span style={{ fg: t.textMuted }}>{" deny"}</span>
        </text>
      </box>
    </box>
  );
}

/* ── Helpers ──────────────────────────────────────────────────── */

function isEscapeKey(key: KeyEvent): boolean {
  return (
    key.name === "escape" ||
    key.code === "Escape" ||
    key.baseCode === 27 ||
    key.sequence === "\u001b" ||
    key.raw === "\u001b"
  );
}

function wrapListIndex(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (index + delta + count) % count;
}

function toolArgs(tc?: ToolCall): string {
  if (!tc) return "";
  try {
    const a = JSON.parse(tc.function.arguments);
    if (tc.function.name === "bash") return a.command || "";
    if (tc.function.name === "read_file" || tc.function.name === "write_file" || tc.function.name === "edit_file")
      return a.path || "";
    if (tc.function.name === "generate_image" || tc.function.name === "generate_video") return a.prompt || "";
    if (tc.function.name === "task" || tc.function.name === "subagent") return a.description || "";
    if (tc.function.name === "lsp") return `${a.operation || "query"} ${a.filePath || ""}`.trim();
    if (tc.function.name === "delegate") return a.description || "";
    if (tc.function.name === "delegation_read") return a.id || "";
    if (tc.function.name === "process_logs" || tc.function.name === "process_stop")
      return a.id != null ? String(a.id) : "";
    return a.query || "";
  } catch {
    return "";
  }
}
function tryParseArg(tc: ToolCall | undefined, key: string): string {
  if (!tc) return "";
  try {
    return JSON.parse(tc.function.arguments)[key] || "";
  } catch {
    return "";
  }
}
function toolLabel(tc: ToolCall): string {
  const args = toolArgs(tc);
  if (tc.function.name === "bash") {
    try {
      const parsed = JSON.parse(tc.function.arguments);
      if (parsed.background) return `Background: ${trunc(args || "Starting process...", 70)}`;
    } catch {
      /* */
    }
    return trunc(args || "Running command...", 80);
  }
  if (tc.function.name === "read_file") return `Read ${trunc(args, 60)}`;
  if (tc.function.name === "write_file") return `Write ${trunc(args, 60)}`;
  if (tc.function.name === "edit_file") return `Edit ${trunc(args, 60)}`;
  if (tc.function.name === "search_web") return `Web Search "${trunc(args, 60)}"`;
  if (tc.function.name === "search_x") return `X Search "${trunc(args, 60)}"`;
  if (tc.function.name === "generate_image") return `Generate image "${trunc(args, 60)}"`;
  if (tc.function.name === "generate_video") return `Generate video "${trunc(args, 60)}"`;
  if (tc.function.name === "task") return `Task ${trunc(args, 60)}`;
  if (tc.function.name === "subagent")
    return tryParseArg(tc, "background") ? `Background ${trunc(args, 60)}` : `Task ${trunc(args, 60)}`;
  if (tc.function.name === "delegate") return `Background ${trunc(args, 60)}`;
  if (tc.function.name === "delegation_read") return `Read delegation ${trunc(args, 60)}`;
  if (tc.function.name === "delegation_list") return "List delegations";
  if (tc.function.name === "process_logs") return `Logs for process ${args}`;
  if (tc.function.name === "process_stop") return `Stop process ${args}`;
  if (tc.function.name === "process_list") return "List processes";
  if (tc.function.name === "generate_plan") return "Generating plan...";
  return trunc(`${tc.function.name} ${args}`, 80);
}
function sanitizeContent(raw: string): string {
  let s = raw.replace(/^[\s\n]*assistant:\s*/gi, "");
  s = s.replace(/\{"success"\s*:\s*(true|false)\s*,\s*"output"\s*:\s*"[\s\S]*$/m, "");
  return s.trim();
}
function shouldOpenProviderModalForKey(_key: {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
}): boolean {
  return false;
}
function compactTaskLabel(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 3) return label.trim() || "Working";
  return `${words.slice(0, 3).join(" ")}...`;
}
function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
function truncateLine(s: string, n: number): string {
  return trunc(s.replace(/\s+/g, " ").trim(), n);
}
