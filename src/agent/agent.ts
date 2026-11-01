import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import {
  addBatchRequests,
  type BatchClientOptions,
  createBatch,
  getBatchChatCompletion,
  pollBatchRequestResult,
} from "../crow/batch";
import {
  type CrowProvider,
  createProvider,
  createReasoningCapture,
  generateRecap as genRecap,
  generateTitle as genTitle,
  resolveModelRuntime,
} from "../crow/client";
import { type getModelInfo, normalizeModelId } from "../crow/models";
import { toolSetToBatchTools } from "../crow/tool-schemas";
import { createTools } from "../crow/tools";
import { executeEventHooks } from "../hooks/index";
import type {
  NotificationHookInput,
  PostCompactHookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { shutdownWorkspaceLspManager } from "../lsp/runtime";
import { buildMcpToolSet } from "../mcp/runtime";
import {
  appendCompaction,
  appendMessages,
  appendSystemMessage,
  buildChatEntries,
  getNextMessageSequence,
  getSessionTotalTokens,
  loadTranscript,
  loadTranscriptState,
  recordThought,
  recordUsageEvent,
  SessionStore,
} from "../storage/index";
import { BashTool } from "../tools/bash";
import { type ScheduleDaemonStatus, ScheduleManager, type StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  SessionInfo,
  SessionSnapshot,
  StreamChunk,
  SubagentStatus,
  TaskRequest,
  ToolCall,
  ToolResult,
  UsageSource,
  VerifyRecipe,
  WorkspaceInfo,
} from "../types/index";
import { loadAgentDefinitions } from "../utils/agent-files";
import {
  type CustomSubagentConfig,
  getCurrentModel,
  getModeSpecificModel,
  loadMcpServers,
  loadRecapsEnabled,
  loadValidSubAgents,
  type SandboxMode,
  type SandboxSettings,
} from "../utils/settings";
import { runSideQuestion, type SideQuestionResult } from "../utils/side-question";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe } from "../verify/entrypoint";
import { runVerifyOrchestration } from "../verify/orchestrator";
import {
  accumulateUsage,
  type BatchContext,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  type ExecutedBatchTool,
  executeBatchToolCall as executeBatchTool,
  getBatchFinishReason,
  getBatchClientOptions as getBatchOptions,
  getBatchUsage,
  hasUsage,
  type ProcessMessageFinishReason,
  type ProcessMessageUsage,
  toLocalToolCall,
  toToolResult,
} from "./batch";
import {
  type CompactionSettings,
  createCompactionSummaryMessage,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_RESERVE_TOKENS,
  estimateConversationTokens,
  generateCompactionSummary,
  prepareCompaction,
  relaxCompactionSettings,
  shouldCompactContext,
} from "./compaction";
import {
  type DelegationContext,
  DelegationManager,
  listDelegations as listDelegationResults,
  readDelegation as readDelegationResult,
  runDelegation as runDelegationTask,
} from "./delegations";

import { humanizeApiError, isAuthenticationError, isContextLimitError } from "./errors";
import { applyModelConstraints, buildSystemPrompt } from "./prompts";
import { sanitizeModelMessages } from "./reasoning";
import {
  formatSubagentActivity,
  runTask as runSubagentTask,
  runTaskRequest as runSubagentTaskRequest,
  type SubagentContext,
  truncate,
} from "./subagents";
import { ThoughtTracker } from "./thought";
import { buildVisionUserMessages } from "./vision-input";

const MAX_TOOL_ROUNDS = 400;

interface AgentOptions {
  persistSession?: boolean;
  session?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
  batchApi?: boolean;
  providerId?: string;
}

export interface ProcessMessageStepStart {
  stepNumber: number;
  timestamp: number;
}

export interface ProcessMessageStepFinish {
  stepNumber: number;
  timestamp: number;
  finishReason: ProcessMessageFinishReason;
  usage: ProcessMessageUsage;
}

export interface ProcessMessageToolStart {
  toolCall: ToolCall;
  timestamp: number;
}

export interface ProcessMessageToolFinish {
  toolCall: ToolCall;
  toolResult: ToolResult;
  timestamp: number;
}

export interface ProcessMessageError {
  message: string;
  timestamp: number;
}

export interface ProcessMessageObserver {
  onStepStart?(info: ProcessMessageStepStart): void;
  onStepFinish?(info: ProcessMessageStepFinish): void;
  onToolStart?(info: ProcessMessageToolStart): void;
  onToolFinish?(info: ProcessMessageToolFinish): void;
  onError?(info: ProcessMessageError): void;
}

export class Agent {
  private provider: CrowProvider | null = null;
  private providerId: string | null = null;
  private apiKey: string | null = null;
  private baseURL: string | null = null;
  private bash: BashTool;
  private delegations: DelegationManager;
  private schedules: ScheduleManager;
  private sessionStore: SessionStore | null = null;
  private workspace: WorkspaceInfo | null = null;
  private session: SessionInfo | null = null;
  private messages: ModelMessage[] = [];
  private messageSeqs: Array<number | null> = [];
  private abortController: AbortController | null = null;
  private maxToolRounds: number;
  private mode: AgentMode = "agent";
  private modelId: string;
  private maxTokens: number;
  private planContext: string | null = null;
  private subagentStatusListeners = new Set<(status: SubagentStatus | null) => void>();
  private sendTelegramFile: ((filePath: string) => Promise<ToolResult>) | null = null;
  private batchApi = false;
  private sessionStartHookFired = false;
  private recapsEnabled = true;

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    options: AgentOptions = {},
  ) {
    this.baseURL = baseURL || null;
    if (apiKey) {
      this.setApiKey(apiKey, baseURL);
    }
    if (options.providerId) {
      this.providerId = options.providerId;
    }
    this.bash = new BashTool(process.cwd(), {
      sandboxMode: options.sandboxMode ?? "off",
      sandboxSettings: options.sandboxSettings,
    });
    this.delegations = new DelegationManager(() => this.bash.getCwd());

    const initialMode: AgentMode = "agent";
    this.modelId = normalizeModelId(model || getCurrentModel(initialMode));
    this.schedules = new ScheduleManager(
      () => this.bash.getCwd(),
      () => this.modelId,
    );
    this.maxToolRounds = maxToolRounds || MAX_TOOL_ROUNDS;
    const envMax = Number(process.env.CROW_MAX_TOKENS);
    this.maxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 16_384;
    this.batchApi = options.batchApi ?? false;
    this.recapsEnabled = loadRecapsEnabled();

    if (options.persistSession !== false) {
      this.sessionStore = new SessionStore(this.bash.getCwd());
      this.workspace = this.sessionStore.getWorkspace();
      this.session = this.sessionStore.openSession(options.session, this.modelId, this.mode, this.bash.getCwd());
      this.mode = this.session.mode;
      const transcript = loadTranscriptState(this.session.id);
      this.messages = transcript.messages;
      this.messageSeqs = transcript.seqs;
      this.sessionStore.setModel(this.session.id, this.modelId);
    }
  }

  getModel(): string {
    return this.modelId;
  }

  setModel(model: string): void {
    this.modelId = normalizeModelId(model);
    if (this.sessionStore && this.session) {
      this.sessionStore.setModel(this.session.id, this.modelId);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
  }

  getMode(): AgentMode {
    return this.mode;
  }

  getSandboxMode(): SandboxMode {
    return this.bash.getSandboxMode();
  }

  setSandboxMode(mode: SandboxMode): void {
    this.bash.setSandboxMode(mode);
  }

  getSandboxSettings(): SandboxSettings {
    return this.bash.getSandboxSettings();
  }

  setSandboxSettings(settings: SandboxSettings): void {
    this.bash.setSandboxSettings(settings);
  }

  setMode(mode: AgentMode): void {
    if (mode !== this.mode) {
      this.mode = mode;
      const modeModel = getModeSpecificModel(mode);
      if (modeModel) {
        this.modelId = normalizeModelId(modeModel);
      }
      if (this.sessionStore && this.session) {
        this.sessionStore.setMode(this.session.id, mode);
        this.sessionStore.setModel(this.session.id, this.modelId);
        this.session = this.sessionStore.getRequiredSession(this.session.id);
      }
    }
  }

  setPlanContext(ctx: string | null): void {
    this.planContext = ctx;
  }

  setSendTelegramFile(fn: ((filePath: string) => Promise<ToolResult>) | null): void {
    this.sendTelegramFile = fn;
  }

  hasApiKey(): boolean {
    return !!this.apiKey;
  }

  setApiKey(apiKey: string, baseURL = this.baseURL ?? undefined): void {
    this.apiKey = apiKey;
    this.baseURL = baseURL || null;
    this.provider = createProvider(apiKey, baseURL);
  }

  setProvider(providerId: string, apiKey: string, baseURL: string, modelId?: string): void {
    this.providerId = providerId;
    this.setApiKey(apiKey, baseURL);
    if (modelId) this.setModel(modelId);
  }

  getProviderId(): string | null {
    return this.providerId;
  }

  getCwd(): string {
    return this.bash.getCwd();
  }

  async listSchedules(): Promise<StoredSchedule[]> {
    return this.schedules.list();
  }

  async removeSchedule(id: string): Promise<string> {
    const removed = await this.schedules.remove(id);
    return removed ? `Removed schedule "${removed.name}".` : `Schedule "${id}" not found.`;
  }

  async getScheduleDaemonStatus(): Promise<ScheduleDaemonStatus> {
    return this.schedules.getDaemonStatus();
  }

  getContextStats(
    contextWindow: number,
    inFlightText = "",
  ): {
    contextWindow: number;
    usedTokens: number;
    remainingTokens: number;
    ratioUsed: number;
    ratioRemaining: number;
  } {
    const system = buildSystemPrompt(
      this.bash.getCwd(),
      this.mode,
      this.bash.getSandboxMode(),
      this.planContext,
      undefined,
      this.bash.getSandboxSettings(),
    );
    const usedTokens = Math.min(contextWindow, estimateConversationTokens(system, this.messages, inFlightText));
    const remainingTokens = Math.max(0, contextWindow - usedTokens);

    return {
      contextWindow,
      usedTokens,
      remainingTokens,
      ratioUsed: usedTokens / contextWindow,
      ratioRemaining: remainingTokens / contextWindow,
    };
  }

  async generateTitle(userMessage: string): Promise<string> {
    const provider = this.provider;
    if (!provider) {
      return "New session";
    }

    const generated = await genTitle(provider, userMessage, this.modelId);
    this.recordUsage(generated.usage, "title", generated.modelId);
    if (this.sessionStore && this.session && !this.session.title && generated.title) {
      this.sessionStore.setTitle(this.session.id, generated.title);
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    }
    return generated.title;
  }

  getSessionRecap(): string | null {
    return this.recapsEnabled ? this.session?.recap?.text || null : null;
  }

  getRecapsEnabled(): boolean {
    return this.recapsEnabled;
  }

  setRecapsEnabled(enabled: boolean): void {
    this.recapsEnabled = enabled;
  }

  async askSideQuestion(question: string, signal?: AbortSignal): Promise<SideQuestionResult> {
    if (!this.provider) {
      return { response: "No API key configured." };
    }

    const contextParts: string[] = [];
    let charBudget = 2000;
    for (let i = this.messages.length - 1; i >= 0 && charBudget > 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((p: { type: string }) => p.type === "text")
                .map((p: { type: string; text?: string }) => p.text ?? "")
                .join("")
            : "";
      if (!text) continue;
      const snippet = text.length > 400 ? `${text.slice(0, 400)}…` : text;
      contextParts.unshift(`[${msg.role}]: ${snippet}`);
      charBudget -= snippet.length;
    }
    const conversationContext = contextParts.join("\n\n");

    const result = await runSideQuestion(question, this.provider, this.modelId, conversationContext, signal);
    this.recordUsage(result.usage, "other");
    return result;
  }

  abort(): void {
    this.abortController?.abort();
    this.emitSubagentStatus(null);
  }

  async cleanup(): Promise<void> {
    await Promise.allSettled([this.bash.cleanup(), shutdownWorkspaceLspManager(this.bash.getCwd())]);
  }

  respondToToolApproval(approvalId: string, approved: boolean): void {
    const toolApprovalResponse: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-approval-response" as const,
          approvalId,
          approved,
        },
      ],
    };
    this.messages.push(toolApprovalResponse);
    this.messageSeqs.push(null);
  }

  clearHistory(): void {
    this.startNewSession();
  }

  startNewSession(): SessionSnapshot | null {
    if (this.sessionStartHookFired) {
      const endInput: SessionEndHookInput = {
        hook_event_name: "SessionEnd",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      this.fireHook(endInput).catch(() => {});
      this.sessionStartHookFired = false;
    }

    if (!this.sessionStore) {
      this.messages = [];
      this.messageSeqs = [];
      return null;
    }

    this.sessionStore = new SessionStore(this.bash.getCwd());
    this.workspace = this.sessionStore.getWorkspace();
    this.session = this.sessionStore.createSession(this.modelId, this.mode, this.bash.getCwd());
    this.messages = [];
    this.messageSeqs = [];
    return this.getSessionSnapshot();
  }

  getSessionInfo(): SessionInfo | null {
    return this.session;
  }

  getSessionId(): string | null {
    return this.session?.id || null;
  }

  getSessionTitle(): string | null {
    return this.session?.title || null;
  }

  getChatEntries(): ChatEntry[] {
    if (!this.session) return [];
    return buildChatEntries(this.session.id);
  }

  getSessionSnapshot(): SessionSnapshot | null {
    if (!this.session || !this.workspace) return null;
    return {
      workspace: this.workspace,
      session: this.session,
      messages: loadTranscript(this.session.id),
      entries: buildChatEntries(this.session.id),
      totalTokens: getSessionTotalTokens(this.session.id),
    };
  }

  onSubagentStatus(listener: (status: SubagentStatus | null) => void): () => void {
    this.subagentStatusListeners.add(listener);
    return () => {
      this.subagentStatusListeners.delete(listener);
    };
  }

  private emitSubagentStatus(status: SubagentStatus | null): void {
    for (const listener of this.subagentStatusListeners) {
      listener(status);
    }
  }

  private discardAbortedTurn(userMessage: ModelMessage): void {
    const idx = this.messages.lastIndexOf(userMessage);
    if (idx >= 0) {
      this.messages.splice(idx, 1);
      this.messageSeqs.splice(idx, 1);
    }
  }

  private async refreshSessionRecap(signal?: AbortSignal): Promise<void> {
    if (!this.recapsEnabled || !this.provider || !this.sessionStore || !this.session) {
      return;
    }

    try {
      const prompt = this.buildRecapPrompt();
      if (!prompt) {
        return;
      }

      const generated = await genRecap(this.provider, prompt, withAbortTimeout(signal, 8_000), this.modelId);
      this.recordUsage(generated.usage, "recap", generated.modelId);
      if (!generated.recap) {
        return;
      }

      this.sessionStore.setRecap(this.session.id, {
        text: generated.recap,
        model: generated.modelId,
        updatedAt: new Date(),
      });
      this.session = this.sessionStore.getRequiredSession(this.session.id);
    } catch {
      // Recaps are best-effort and should never make the completed turn fail.
    }
  }

  private buildRecapPrompt(): string | null {
    if (!this.session) {
      return null;
    }

    const transcript = formatEntriesForRecap(buildChatEntries(this.session.id), 5_000);
    if (!transcript) {
      return null;
    }

    const sections = [
      "Refresh the saved recap for this coding session using the latest transcript.",
      this.session.recap?.text
        ? `Existing recap:\n${truncate(this.session.recap.text, 1_200)}`
        : "Existing recap:\n(none)",
      `Session transcript:\n${transcript}`,
    ];
    return sections.join("\n\n");
  }

  private recordUsage(
    usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
    source: UsageSource = "message",
    model = this.modelId,
  ): void {
    if (!usage) return;
    if (this.session) {
      recordUsageEvent(this.session.id, source, model, usage);
    }
  }

  async consumeBackgroundNotifications(): Promise<string[]> {
    try {
      const notifications = await this.delegations.consumeNotifications();
      for (const notification of notifications) {
        this.messages.push({ role: "system", content: notification.message });
        let seq: number | null = null;
        if (this.session) {
          seq = appendSystemMessage(this.session.id, notification.message);
        }
        this.messageSeqs.push(seq);

        const notifInput: NotificationHookInput = {
          hook_event_name: "Notification",
          message: notification.message,
          session_id: this.session?.id,
          cwd: this.bash.getCwd(),
        };
        this.fireHook(notifInput).catch(() => {});
      }
      return notifications.map((notification) => notification.message);
    } catch {
      return [];
    }
  }

  private get batchContext(): BatchContext {
    return {
      apiKey: this.apiKey,
      baseURL: this.baseURL ?? undefined,
      maxTokens: this.maxTokens,
      recordUsage: (usage, source, modelId) => this.recordUsage(usage, source, modelId),
      formatActivity: (toolName, args) => formatSubagentActivity(toolName, args),
    };
  }

  private getBatchClientOptions(signal?: AbortSignal): BatchClientOptions {
    return getBatchOptions(this.batchContext, signal);
  }

  private async executeBatchToolCall(
    tools: ToolSet,
    toolCall: ToolCall,
    messages: ModelMessage[],
    signal?: AbortSignal,
  ): Promise<{ input: unknown; result: ToolResult }> {
    return executeBatchTool(tools, toolCall, messages, signal);
  }

  private get subagentContext(): SubagentContext {
    return {
      provider: this.requireProvider(),
      bash: this.bash,
      modelId: this.modelId,
      providerId: this.providerId,
      maxToolRounds: this.maxToolRounds,
      maxTokens: this.maxTokens,
      batchApi: this.batchApi,
      batch: this.batchContext,
      sessionId: this.session?.id,
      fireHook: (input, signal) => this.fireHook(input, signal),
      emitSubagentStatus: (status) => this.emitSubagentStatus(status),
      recordUsage: (usage, source, modelId) => this.recordUsage(usage, source, modelId),
    };
  }

  async runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    return runSubagentTaskRequest(this.subagentContext, request, onActivity, abortSignal);
  }

  private async runTask(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    return runSubagentTask(this.subagentContext, request, abortSignal);
  }

  private get delegationContext(): DelegationContext {
    return {
      delegations: this.delegations,
      modelId: this.modelId,
      sandboxMode: this.bash.getSandboxMode(),
      sandboxSettings: this.bash.getSandboxSettings(),
      maxToolRounds: this.maxToolRounds,
      maxTokens: this.maxTokens,
      batchApi: this.batchApi,
      sessionId: this.session?.id,
      cwd: this.bash.getCwd(),
      fireHook: (input, signal) => this.fireHook(input, signal),
    };
  }

  private async runDelegation(request: TaskRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    return runDelegationTask(this.delegationContext, request, abortSignal);
  }

  private async readDelegation(id: string): Promise<ToolResult> {
    return readDelegationResult(this.delegationContext, id);
  }

  private async listDelegations(): Promise<ToolResult> {
    return listDelegationResults(this.delegationContext);
  }

  private getCompactionSettings(): CompactionSettings {
    return {
      reserveTokens: Math.max(this.maxTokens, DEFAULT_RESERVE_TOKENS),
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    };
  }

  private async compactForContext(
    provider: CrowProvider,
    system: string,
    contextWindow: number,
    signal: AbortSignal,
    settings = this.getCompactionSettings(),
    force = false,
  ): Promise<boolean> {
    if (!this.session) return false;

    const preparation = prepareCompaction(this.messages, system, settings);
    if (!preparation) return false;
    if (!force && !shouldCompactContext(preparation.tokensBefore, contextWindow, settings)) {
      return false;
    }

    const trigger = force ? "manual" : "auto";
    const preCompactInput: PreCompactHookInput = {
      hook_event_name: "PreCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(preCompactInput, signal).catch(() => {});

    const keptSeqs = this.messageSeqs.slice(preparation.firstKeptIndex);
    const firstKeptSeq = keptSeqs.find((seq): seq is number => seq !== null) ?? getNextMessageSequence(this.session.id);
    const summary = await generateCompactionSummary(provider, this.modelId, preparation, undefined, signal);

    appendCompaction(this.session.id, firstKeptSeq, summary, preparation.tokensBefore);
    this.messages = [createCompactionSummaryMessage(summary), ...preparation.keptMessages];
    this.messageSeqs = [null, ...keptSeqs];

    const postCompactInput: PostCompactHookInput = {
      hook_event_name: "PostCompact",
      trigger,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(postCompactInput, signal).catch(() => {});

    return true;
  }

  private async *processMessageBatchTurn(args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: CrowProvider;
    subagents: CustomSubagentConfig[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  }): AsyncGenerator<StreamChunk, void, unknown> {
    const { userModelMessage, observer, provider, subagents, system, runtime, modelInfo, signal } = args;
    let attemptedOverflowRecovery = false;

    while (true) {
      let closeMcp: (() => Promise<void>) | undefined;
      const turnMessages: ModelMessage[] = [];
      const totalUsage: ProcessMessageUsage = {};

      try {
        const settings = attemptedOverflowRecovery
          ? relaxCompactionSettings(this.getCompactionSettings())
          : this.getCompactionSettings();
        if (modelInfo) {
          await this.compactForContext(
            provider,
            system,
            modelInfo.contextWindow,
            signal,
            settings,
            attemptedOverflowRecovery,
          );
        }

        if (runtime.modelInfo?.responsesOnly) {
          throw new Error("Batch mode currently supports chat-completions models only.");
        }

        const baseTools = createTools(this.bash, provider, this.mode, {
          modelId: this.modelId,
          providerId: this.providerId ?? undefined,
          runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
          runDelegation: (request, abortSignal) =>
            this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
          readDelegation: (id) => this.readDelegation(id),
          listDelegations: () => this.listDelegations(),
          scheduleManager: this.schedules,
          subagents,
          agentDefinitions: loadAgentDefinitions(this.bash.getCwd()),
          sendTelegramFile: this.sendTelegramFile ?? undefined,
          sessionId: this.session?.id ?? undefined,
        });
        let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
        if (this.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
          const mcpBundle = await buildMcpToolSet(loadMcpServers());
          closeMcp = mcpBundle.close;
          tools = { ...baseTools, ...mcpBundle.tools };
          if (mcpBundle.errors.length > 0) {
            yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
          }
        }

        const batchTools = runtime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(tools);
        const batch = await createBatch({
          ...this.getBatchClientOptions(signal),
          name: buildBatchName("session", this.getSessionId() || runtime.modelId),
        });

        for (let round = 0; round < this.maxToolRounds; round++) {
          const stepNumber = round + 1;
          notifyObserver(observer?.onStepStart, {
            stepNumber,
            timestamp: Date.now(),
          });

          const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
          await addBatchRequests({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequests: [
              {
                batch_request_id: batchRequestId,
                batch_request: {
                  chat_get_completion: buildBatchChatCompletionRequest({
                    modelId: runtime.modelId,
                    system,
                    messages: [...this.messages, ...turnMessages],
                    temperature: 0.7,
                    maxOutputTokens: runtime.modelInfo?.supportsMaxOutputTokens === false ? undefined : this.maxTokens,
                    reasoningEffort: undefined,
                    tools: batchTools,
                  }),
                },
              },
            ],
          });

          const result = await pollBatchRequestResult({
            ...this.getBatchClientOptions(signal),
            batchId: batch.batch_id,
            batchRequestId,
          });
          const response = getBatchChatCompletion(result);
          const choice = response.choices[0];
          if (!choice) {
            throw new Error("Batch response did not contain any choices.");
          }

          const usage = getBatchUsage(response);
          accumulateUsage(totalUsage, usage);
          const finishReason = getBatchFinishReason(choice.finish_reason);

          const content = choice.message.content ?? "";
          if (content) {
            yield { type: "content", content };
          }

          const requestMessages = [...this.messages, ...turnMessages];
          const toolCalls = (choice.message.tool_calls ?? []).map(toLocalToolCall);
          const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
          if (assistantMessage) {
            turnMessages.push(assistantMessage);
          }

          if (toolCalls.length === 0) {
            notifyObserver(observer?.onStepFinish, {
              stepNumber,
              timestamp: Date.now(),
              finishReason,
              usage,
            });
            if (hasUsage(totalUsage)) {
              this.recordUsage(totalUsage, "message", runtime.modelId);
            }
            this.appendCompletedTurn(userModelMessage, turnMessages);
            await this.refreshSessionRecap(signal);
            yield { type: "done" };
            return;
          }

          yield { type: "tool_calls", toolCalls };

          const toolParts: ExecutedBatchTool[] = [];
          for (const toolCall of toolCalls) {
            notifyObserver(observer?.onToolStart, {
              toolCall,
              timestamp: Date.now(),
            });

            const executed = await this.executeBatchToolCall(tools, toolCall, requestMessages, signal);
            notifyObserver(observer?.onToolFinish, {
              toolCall,
              toolResult: executed.result,
              timestamp: Date.now(),
            });
            yield { type: "tool_result", toolCall, toolResult: executed.result };
            toolParts.push({
              toolCall,
              input: executed.input,
              toolResult: executed.result,
            });
          }

          const toolMessage = buildToolBatchMessage(toolParts);
          if (toolMessage) {
            turnMessages.push(toolMessage);
          }
          notifyObserver(observer?.onStepFinish, {
            stepNumber,
            timestamp: Date.now(),
            finishReason,
            usage,
          });
        }

        const message = `Error: Reached max tool rounds (${this.maxToolRounds}) in batch mode.`;
        notifyObserver(observer?.onError, {
          message,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield { type: "error", content: message };
        yield { type: "done" };
        return;
      } catch (err: unknown) {
        if (signal.aborted) {
          this.discardAbortedTurn(userModelMessage);
          yield { type: "content", content: "\n\n[Cancelled]" };
          yield { type: "done" };
          return;
        }

        if (!attemptedOverflowRecovery && turnMessages.length === 0 && modelInfo && isContextLimitError(err)) {
          attemptedOverflowRecovery = true;
          continue;
        }

        const authError = isAuthenticationError(err);
        const friendly = humanizeApiError(err);
        notifyObserver(observer?.onError, {
          message: friendly,
          timestamp: Date.now(),
        });
        if (hasUsage(totalUsage)) {
          this.recordUsage(totalUsage, "message", runtime.modelId);
        }
        this.appendCompletedTurn(userModelMessage, turnMessages);
        yield {
          type: "error",
          content: friendly,
          isAuthError: authError,
        };
        yield { type: "done" };
        return;
      } finally {
        await closeMcp?.().catch(() => {});
      }
    }
  }

  private appendCompletedTurn(
    userMessage: ModelMessage,
    newMessages: ModelMessage[],
    thought?: { durationMs: number; text: string },
  ): void {
    if (newMessages.length === 0) return;

    const userIndex = this.messages.lastIndexOf(userMessage);
    if (!this.sessionStore || !this.session) {
      if (userIndex >= 0 && this.messageSeqs[userIndex] == null) {
        this.messageSeqs[userIndex] = null;
      }
      this.messages.push(...newMessages);
      this.messageSeqs.push(...newMessages.map(() => null));
      return;
    }

    const insertedSeqs = appendMessages(this.session.id, [userMessage, ...newMessages]);
    if (userIndex >= 0) {
      this.messageSeqs[userIndex] = insertedSeqs[0] ?? this.messageSeqs[userIndex];
    }
    this.messages.push(...newMessages);
    this.messageSeqs.push(...insertedSeqs.slice(1));
    if (thought != null) {
      const firstAssistantIndex = newMessages.findIndex((message) => message.role === "assistant");
      const firstAssistantSeq = firstAssistantIndex >= 0 ? insertedSeqs[1 + firstAssistantIndex] : undefined;
      if (firstAssistantSeq != null) {
        recordThought(this.session.id, firstAssistantSeq, thought.durationMs, thought.text);
      }
    }
    this.sessionStore.touchSession(this.session.id, this.bash.getCwd());
    this.session = this.sessionStore.getRequiredSession(this.session.id);
  }

  private fireHook(
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeEventHooks>>> {
    return executeEventHooks(input, this.bash.getCwd(), signal);
  }

  async *processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    this.emitSubagentStatus(null);

    if (!this.sessionStartHookFired) {
      this.sessionStartHookFired = true;
      const isResume = this.messages.length > 0;
      const sessionStartInput: SessionStartHookInput = {
        hook_event_name: "SessionStart",
        source: isResume ? "resume" : "startup",
        session_id: this.session?.id,
        cwd: this.bash.getCwd(),
      };
      await this.fireHook(sessionStartInput, signal).catch(() => {});
    }

    const promptInput: UserPromptSubmitHookInput = {
      hook_event_name: "UserPromptSubmit",
      user_prompt: userMessage,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(promptInput, signal).catch(() => {});

    await this.consumeBackgroundNotifications();
    const userModelMessages = await buildVisionUserMessages(userMessage, this.bash.getCwd(), signal);
    const userModelMessage = userModelMessages[0] ?? ({ role: "user", content: userMessage } satisfies ModelMessage);
    this.messages.push(userModelMessage);
    this.messageSeqs.push(null);

    this.requireProvider();
    const thoughtTracker = new ThoughtTracker();
    const reasoningCapture = createReasoningCapture((text) => {
      thoughtTracker.capture(text);
    });
    const provider = createProvider(this.apiKey ?? "", this.baseURL ?? undefined, reasoningCapture.fetch);
    const subagents = loadValidSubAgents();
    const system = applyModelConstraints(
      buildSystemPrompt(
        this.bash.getCwd(),
        this.mode,
        this.bash.getSandboxMode(),
        this.planContext,
        subagents,
        this.bash.getSandboxSettings(),
      ),
      this.modelId,
    );
    const runtime = resolveModelRuntime(provider, this.modelId);
    const modelInfo = runtime.modelInfo;
    this.planContext = null;
    let attemptedOverflowRecovery = false;

    if (this.batchApi) {
      try {
        yield* this.processMessageBatchTurn({
          userModelMessage,
          observer,
          provider,
          subagents,
          system,
          runtime,
          modelInfo,
          signal,
        });
      } finally {
        if (this.abortController?.signal === signal) {
          this.abortController = null;
        }
      }
      return;
    }

    try {
      while (true) {
        let assistantText = "";
        let streamOk = false;
        let closeMcp: (() => Promise<void>) | undefined;
        let stepNumber = -1;
        const activeToolCalls: ToolCall[] = [];

        try {
          const settings = attemptedOverflowRecovery
            ? relaxCompactionSettings(this.getCompactionSettings())
            : this.getCompactionSettings();
          if (modelInfo) {
            await this.compactForContext(
              provider,
              system,
              modelInfo.contextWindow,
              signal,
              settings,
              attemptedOverflowRecovery,
            );
          }

          const baseTools = createTools(this.bash, provider, this.mode, {
            modelId: this.modelId,
            providerId: this.providerId ?? undefined,
            runTask: (request, abortSignal) => this.runTask(request, combineAbortSignals(signal, abortSignal)),
            runDelegation: (request, abortSignal) =>
              this.runDelegation(request, combineAbortSignals(signal, abortSignal)),
            readDelegation: (id) => this.readDelegation(id),
            listDelegations: () => this.listDelegations(),
            scheduleManager: this.schedules,
            subagents,
            agentDefinitions: loadAgentDefinitions(this.bash.getCwd()),
            sendTelegramFile: this.sendTelegramFile ?? undefined,
            sessionId: this.session?.id ?? undefined,
          });
          let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
          if (this.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
            const mcpBundle = await buildMcpToolSet(loadMcpServers());
            closeMcp = mcpBundle.close;
            tools = { ...baseTools, ...mcpBundle.tools };
            if (mcpBundle.errors.length > 0) {
              yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
            }
          }

          thoughtTracker.start();
          const result = streamText({
            model: runtime.model,
            system,
            messages: this.messages,
            tools,
            stopWhen: stepCountIs(this.maxToolRounds),
            maxRetries: 0,
            abortSignal: signal,
            temperature: 0.7,
            ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: this.maxTokens }),
            ...(runtime.providerOptions ? { providerOptions: runtime.providerOptions } : {}),
            experimental_onStepStart: (event: unknown) => {
              stepNumber = getStepNumber(event, stepNumber + 1);
              notifyObserver(observer?.onStepStart, {
                stepNumber,
                timestamp: Date.now(),
              });
            },
            onStepFinish: (event: unknown) => {
              const currentStep = getStepNumber(event, Math.max(stepNumber, 0));
              stepNumber = Math.max(stepNumber, currentStep);
              notifyObserver(observer?.onStepFinish, {
                stepNumber: currentStep,
                timestamp: Date.now(),
                finishReason: getFinishReason(event),
                usage: getUsage(event),
              });
            },
            onFinish: ({ totalUsage }) => {
              this.recordUsage(totalUsage, "message", runtime.modelId);
            },
          });

          for await (const part of result.fullStream) {
            if (signal.aborted) {
              yield { type: "content", content: "\n\n[Cancelled]" };
              break;
            }

            thoughtTracker.noteStreamPart(part.type);
            yield* thoughtTracker.emitFresh();

            switch (part.type) {
              case "text-delta":
                assistantText += part.text;
                yield { type: "content", content: part.text };
                break;

              case "reasoning-delta":
                yield* thoughtTracker.emitText(part.text);
                break;

              case "tool-call": {
                const tc = toToolCall(part);
                activeToolCalls.push(tc);
                notifyObserver(observer?.onToolStart, {
                  toolCall: tc,
                  timestamp: Date.now(),
                });
                yield { type: "tool_calls", toolCalls: [tc] };
                break;
              }

              case "tool-result": {
                const tc: ToolCall = {
                  id: part.toolCallId,
                  type: "function",
                  function: { name: part.toolName, arguments: JSON.stringify(part.input ?? {}) },
                };
                const tr = toToolResult(part.output);
                notifyObserver(observer?.onToolFinish, {
                  toolCall: tc,
                  toolResult: tr,
                  timestamp: Date.now(),
                });
                yield { type: "tool_result", toolCall: tc, toolResult: tr };
                break;
              }

              case "tool-approval-request": {
                const approvalPart = part as unknown as {
                  approvalId: string;
                  toolCall: { toolCallId: string; toolName: string; input: unknown };
                };
                const toolCallId = approvalPart.toolCall?.toolCallId ?? "";
                const pendingTc = activeToolCalls.find((tc) => tc.id === toolCallId);
                const tcForChunk = pendingTc ?? {
                  id: toolCallId,
                  type: "function" as const,
                  function: {
                    name: approvalPart.toolCall?.toolName ?? "",
                    arguments: JSON.stringify(approvalPart.toolCall?.input ?? {}),
                  },
                };

                yield {
                  type: "tool_approval_request",
                  approvalId: approvalPart.approvalId,
                  toolCall: tcForChunk,
                };
                break;
              }

              case "error": {
                const authError = isAuthenticationError(part.error);
                const friendly = humanizeApiError(part.error);
                notifyObserver(observer?.onError, {
                  message: friendly,
                  timestamp: Date.now(),
                });
                yield {
                  type: "error",
                  content: friendly,
                  isAuthError: authError,
                };
                break;
              }

              case "abort":
                yield { type: "content", content: "\n\n[Cancelled]" };
                break;
            }
          }

          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          await reasoningCapture.settled();
          const thought = thoughtTracker.finish();
          try {
            const response = await result.response;
            if (!signal.aborted) {
              this.appendCompletedTurn(userModelMessage, sanitizeModelMessages(response.messages), thought);
              await this.refreshSessionRecap(signal);
              streamOk = true;
            }
          } catch (responseError: unknown) {
            if (
              !attemptedOverflowRecovery &&
              !assistantText.trim() &&
              modelInfo &&
              isContextLimitError(responseError)
            ) {
              attemptedOverflowRecovery = true;
              continue;
            }
          }

          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "done" };
            return;
          }

          if (!streamOk && assistantText.trim()) {
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }], thought);
            await this.refreshSessionRecap(signal);
          }

          const stopInput: StopHookInput = {
            hook_event_name: "Stop",
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopInput, signal).catch(() => {});

          yield { type: "done" };
          return;
        } catch (err: unknown) {
          if (signal.aborted) {
            this.discardAbortedTurn(userModelMessage);
            yield { type: "content", content: "\n\n[Cancelled]" };
            yield { type: "done" };
            return;
          }

          if (!attemptedOverflowRecovery && !assistantText.trim() && modelInfo && isContextLimitError(err)) {
            attemptedOverflowRecovery = true;
            continue;
          }

          const authError = isAuthenticationError(err);
          const friendly = humanizeApiError(err);
          notifyObserver(observer?.onError, {
            message: friendly,
            timestamp: Date.now(),
          });
          yield {
            type: "error",
            content: friendly,
            isAuthError: authError,
          };
          if (assistantText.trim()) {
            this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
          }

          const stopFailureInput: StopFailureHookInput = {
            hook_event_name: "StopFailure",
            error: friendly,
            session_id: this.session?.id,
            cwd: this.bash.getCwd(),
          };
          await this.fireHook(stopFailureInput, signal).catch(() => {});

          yield { type: "done" };
          return;
        } finally {
          await closeMcp?.().catch(() => {});
        }
      }
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }

  private requireProvider(): CrowProvider {
    if (!this.provider) {
      throw new Error("You have not selected a provider yet. Use /connect to choose a provider first.");
    }

    return this.provider;
  }

  async detectVerifyRecipe(settings?: SandboxSettings, abortSignal?: AbortSignal): Promise<VerifyRecipe | null> {
    try {
      const result = await this.runTaskRequest(
        {
          agent: "verify-detect",
          description: "Detect verification recipe",
          prompt: buildVerifyDetectPrompt(this.bash.getCwd(), settings ?? this.bash.getSandboxSettings()),
        },
        undefined,
        abortSignal,
      );
      if (!result.success || !result.output) return null;
      const maybeJson = extractJsonObject(result.output);
      if (!maybeJson) return null;
      return normalizeVerifyRecipe(JSON.parse(maybeJson));
    } catch {
      return null;
    }
  }

  async runVerify(onProgress?: (detail: string) => void, abortSignal?: AbortSignal): Promise<ToolResult> {
    this.abortController = new AbortController();
    const signal = abortSignal ?? this.abortController.signal;
    const userModelMessage: ModelMessage = { role: "user", content: "/verify" };
    this.messages.push(userModelMessage);
    this.messageSeqs.push(null);

    try {
      await this.consumeBackgroundNotifications();
      const result = await runVerifyOrchestration(this, { onProgress, abortSignal: signal });
      const assistantText = result.output || result.error || "Verification completed.";
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: assistantText }]);
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const failureText = signal.aborted ? "Verification aborted." : `Verification failed: ${msg}`;
      this.appendCompletedTurn(userModelMessage, [{ role: "assistant", content: failureText }]);
      return { success: false, output: failureText };
    } finally {
      if (this.abortController?.signal === signal) {
        this.abortController = null;
      }
    }
  }
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + 1);
}

function toToolCall(part: { toolCallId: string; toolName: string; args?: unknown; input?: unknown }): ToolCall {
  return {
    id: part.toolCallId,
    type: "function",
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input ?? part.args ?? {}),
    },
  };
}

function notifyObserver<T>(listener: ((payload: T) => void) | undefined, payload: T): void {
  if (!listener) {
    return;
  }

  try {
    listener(payload);
  } catch {
    // Observer failures should never break generation.
  }
}

function getStepNumber(event: unknown, fallback: number): number {
  if (event && typeof event === "object" && "stepNumber" in event && typeof event.stepNumber === "number") {
    return event.stepNumber;
  }

  return fallback;
}

function getFinishReason(event: unknown): ProcessMessageFinishReason {
  if (event && typeof event === "object" && "finishReason" in event) {
    switch (event.finishReason) {
      case "stop":
      case "length":
      case "content-filter":
      case "tool-calls":
      case "error":
      case "other":
        return event.finishReason;
    }
  }

  return "other";
}

function getUsage(event: unknown): ProcessMessageUsage {
  if (!(event && typeof event === "object" && "usage" in event)) {
    return {};
  }

  const usage = event.usage;
  if (!usage || typeof usage !== "object") {
    return {};
  }

  const u = usage as Record<string, unknown>;
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
    totalTokens: typeof u.totalTokens === "number" ? u.totalTokens : undefined,
  };
}

function formatEntriesForRecap(entries: ChatEntry[], maxChars: number): string {
  const lines: string[] = [];
  let remaining = maxChars;

  for (let i = entries.length - 1; i >= 0 && remaining > 0; i--) {
    const line = formatRecapEntry(entries[i]!);
    if (!line) {
      continue;
    }

    const bounded = truncate(line, Math.min(remaining, 520));
    if (!bounded.trim()) {
      continue;
    }

    lines.unshift(bounded);
    remaining -= bounded.length + 1;
  }

  return lines.join("\n");
}

function formatRecapEntry(entry: ChatEntry): string | null {
  const content = entry.content.trim();
  if (!content) {
    return null;
  }

  switch (entry.type) {
    case "user":
      return `[User] ${truncate(content, 420)}`;
    case "assistant":
      return `[Assistant] ${truncate(content, 420)}`;
    case "tool_result":
      return `[Tool ${entry.toolResult?.success === false ? "error" : "result"}] ${truncate(content, 260)}`;
    default:
      return null;
  }
}

function withAbortTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal.timeout !== "function") {
    return signal;
  }
  return combineAbortSignals(signal, AbortSignal.timeout(timeoutMs));
}

function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (activeSignals.length === 0) return undefined;
  if (activeSignals.length === 1) return activeSignals[0];

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }

    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return controller.signal;
}
