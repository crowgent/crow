import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelMessage } from "ai";
import {
  type CrowProvider,
  createProvider,
  generateRecap as genRecap,
  generateTitle as genTitle,
} from "../crow/client";
import { normalizeModelId } from "../crow/models";
import { type PermissionResolver, type PermissionRule, PermissionStore } from "../crow/permissions";
import type { QuestionItem, QuestionResolver } from "../crow/tools";
import { executeEventHooks } from "../hooks/index";
import type {
  NotificationHookInput,
  SessionEndHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from "../hooks/types";
import { shutdownWorkspaceLspManager } from "../lsp/runtime";
import {
  appendMessages,
  appendSystemMessage,
  buildChatEntries,
  clearInbox,
  clearTurnClaim,
  deleteInboxItem,
  deletePersistedMessage,
  deleteTurnDraft as deleteStoredTurnDraft,
  enqueueInbox,
  forkSession as forkStoredSession,
  getSessionTotalTokens,
  listInbox,
  loadTranscript,
  loadTranscriptState,
  recordUsageEvent,
  SessionStore,
  setTurnClaim,
  upsertTurnDraft as storeTurnDraft,
  sweepInterruptedTurn,
} from "../storage/index";
import { BashTool } from "../tools/bash";
import { type ScheduleDaemonStatus, ScheduleManager, type StoredSchedule } from "../tools/schedule";
import type {
  AgentMode,
  ChatEntry,
  SessionInfo,
  SessionSnapshot,
  StreamChunk,
  SubagentRequest,
  SubagentStatus,
  TaskRequest,
  ToolCall,
  ToolResult,
  UsageSource,
  VerifyRecipe,
  WorkspaceInfo,
} from "../types/index";
import {
  getCurrentModel,
  getModeSpecificModel,
  loadRecapsEnabled,
  loadUserSettings,
  type SandboxMode,
  type SandboxSettings,
  saveUserSettings,
} from "../utils/settings";
import { runSideQuestion, type SideQuestionResult } from "../utils/side-question";
import { buildVerifyDetectPrompt, normalizeVerifyRecipe } from "../verify/entrypoint";
import { runVerifyOrchestration } from "../verify/orchestrator";
import type { BatchContext, ProcessMessageFinishReason, ProcessMessageUsage } from "./batch";
import { estimateConversationTokens } from "./compaction";
import {
  type DelegationContext,
  DelegationManager,
  listDelegations as listDelegationResults,
  readDelegation as readDelegationResult,
  runDelegation as runDelegationTask,
} from "./delegations";
import {
  appendCompletedTurn as appendCompletedTurnLoop,
  combineAbortSignals,
  type LoopContext,
  processMessage as processMessageLoop,
} from "./loop";

import { buildSystemPrompt } from "./prompts";
import {
  formatSubagentActivity,
  type RunTaskRequestOptions,
  runSubagentSession as runSubagentSessionTask,
  runTaskRequest as runSubagentTaskRequest,
  type SubagentContext,
  truncate,
} from "./subagents";

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
  private permissionStore = new PermissionStore();
  private permissionResolver: PermissionResolver | null = null;
  private questionResolver: QuestionResolver | null = null;
  private sessionTokenBudget = 0;

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
    this.sessionTokenBudget = loadUserSettings().sessionTokenBudget ?? 0;

    if (options.persistSession !== false) {
      this.sessionStore = new SessionStore(this.bash.getCwd());
      this.workspace = this.sessionStore.getWorkspace();
      this.session = this.sessionStore.openSession(options.session, this.modelId, this.mode, this.bash.getCwd());
      this.mode = this.session.mode;
      sweepInterruptedTurn(this.session.id);
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

  setPermissionResolver(resolver: PermissionResolver | null): void {
    this.permissionResolver = resolver;
  }

  setQuestionResolver(resolver: QuestionResolver | null): void {
    this.questionResolver = resolver;
  }

  async askQuestion(questions: QuestionItem[], abortSignal?: AbortSignal): Promise<string[]> {
    if (!this.questionResolver) return [];
    return this.questionResolver(questions, abortSignal);
  }

  getSessionTokenBudget(): number {
    return this.sessionTokenBudget;
  }

  setSessionTokenBudget(budget: number): void {
    this.sessionTokenBudget = budget;
    saveUserSettings({ sessionTokenBudget: budget });
  }

  forkSession(): SessionSnapshot | null {
    if (!this.sessionStore || !this.session) return null;
    const newId = forkStoredSession(this.session.id);
    if (!newId) return null;
    this.session = this.sessionStore.getRequiredSession(newId);
    const transcript = loadTranscriptState(newId);
    this.messages = transcript.messages;
    this.messageSeqs = transcript.seqs;
    this.sessionStartHookFired = false;
    return this.getSessionSnapshot();
  }

  transferSession(newCwd: string): SessionSnapshot | null {
    if (!this.sessionStore || !this.session) return null;
    const resolved = path.resolve(newCwd);
    fs.mkdirSync(resolved, { recursive: true });
    this.sessionStore.moveSession(this.session.id, resolved);
    this.sessionStore = new SessionStore(resolved);
    this.workspace = this.sessionStore.getWorkspace();
    this.session = this.sessionStore.getRequiredSession(this.session.id);
    this.bash.setCwd(resolved);
    return this.getSessionSnapshot();
  }

  addPermissionRule(rule: PermissionRule): void {
    this.permissionStore.addRule(rule);
  }

  persistTurnUser(userMessage: ModelMessage): number | null {
    if (!this.sessionStore || !this.session) return null;
    return appendMessages(this.session.id, [userMessage])[0] ?? null;
  }

  updateTurnDraft(text: string): void {
    if (!this.sessionStore || !this.session) return;
    storeTurnDraft(this.session.id, text);
  }

  deleteTurnDraft(): void {
    if (!this.sessionStore || !this.session) return;
    deleteStoredTurnDraft(this.session.id);
  }

  abandonPersistedTurn(userSeq: number | null): void {
    if (!this.sessionStore || !this.session) return;
    if (userSeq != null) deletePersistedMessage(this.session.id, userSeq);
    deleteStoredTurnDraft(this.session.id);
  }

  enqueueFollowUp(text: string, displayText: string): number | null {
    if (!this.sessionStore || !this.session) return null;
    return enqueueInbox(this.session.id, text, displayText);
  }

  acknowledgeFollowUp(id: number): void {
    deleteInboxItem(id);
  }

  listPendingFollowUps(): Array<{ id: number; text: string; displayText: string }> {
    if (!this.sessionStore || !this.session) return [];
    return listInbox(this.session.id);
  }

  clearPendingFollowUps(): void {
    if (!this.sessionStore || !this.session) return;
    clearInbox(this.session.id);
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
      sessionStore: this.sessionStore,
      fireHook: (input, signal) => this.fireHook(input, signal),
      emitSubagentStatus: (status) => this.emitSubagentStatus(status),
      recordUsage: (usage, source, modelId) => this.recordUsage(usage, source, modelId),
    };
  }

  async runTaskRequest(
    request: TaskRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
    opts?: RunTaskRequestOptions,
  ): Promise<ToolResult> {
    return runSubagentTaskRequest(this.subagentContext, request, onActivity, abortSignal, opts);
  }

  async runSubagentForeground(
    request: SubagentRequest,
    onActivity?: (detail: string) => void,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    return runSubagentSessionTask(this.subagentContext, request, onActivity, abortSignal);
  }

  private async runSubagent(request: SubagentRequest, abortSignal?: AbortSignal): Promise<ToolResult> {
    if (request.background) {
      const store = this.sessionStore;
      let childId: string | undefined;
      if (store && request.sessionID) {
        const existing = store.getSessionById(request.sessionID);
        if (existing) childId = existing.id;
      }
      if (store && !childId) {
        const child = store.createSession(this.modelId, "agent", this.bash.getCwd(), this.session?.id ?? null);
        store.setTitle(child.id, request.description);
        childId = child.id;
      }
      const result = await runDelegationTask(
        this.delegationContext,
        { agent: request.agent, description: request.description, prompt: request.prompt },
        abortSignal,
        childId,
      );
      if (!result.success) {
        return result;
      }
      return {
        ...result,
        output: [
          `The subagent is working in the background${childId ? ` (sessionID: ${childId})` : ""}. You will be notified automatically when it finishes.`,
          "DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; avoid working with the same files or topics it is using.",
          "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
          "To send it follow-ups or change its instructions while it runs, call subagent again with this sessionID.",
        ].join("\n"),
      };
    }

    const startInput: SubagentStartHookInput = {
      hook_event_name: "SubagentStart",
      agent_type: request.agent,
      description: request.description,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(startInput, abortSignal).catch(() => {});

    let result: ToolResult;
    try {
      result = await runSubagentSessionTask(
        this.subagentContext,
        request,
        (detail) => {
          if (abortSignal?.aborted) return;
          this.emitSubagentStatus({
            agent: request.agent,
            description: request.description,
            detail,
          });
        },
        abortSignal,
      );
    } finally {
      this.emitSubagentStatus(null);
    }

    const stopInput: SubagentStopHookInput = {
      hook_event_name: "SubagentStop",
      agent_type: request.agent,
      description: request.description,
      success: result.success,
      session_id: this.session?.id,
      cwd: this.bash.getCwd(),
    };
    await this.fireHook(stopInput, abortSignal).catch(() => {});

    return result;
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

  private async readDelegation(id: string): Promise<ToolResult> {
    return readDelegationResult(this.delegationContext, id);
  }

  private async listDelegations(): Promise<ToolResult> {
    return listDelegationResults(this.delegationContext);
  }

  private fireHook(
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeEventHooks>>> {
    return executeEventHooks(input, this.bash.getCwd(), signal);
  }

  private get loopContext(): LoopContext {
    const agent = this;
    return {
      bash: this.bash,
      modelId: this.modelId,
      providerId: this.providerId,
      mode: this.mode,
      maxTokens: this.maxTokens,
      maxToolRounds: this.maxToolRounds,
      batchApi: this.batchApi,
      apiKey: this.apiKey,
      baseURL: this.baseURL,
      sessionStore: this.sessionStore,
      schedules: this.schedules,
      sendTelegramFile: this.sendTelegramFile,
      batch: this.batchContext,
      get messages() {
        return agent.messages;
      },
      set messages(value) {
        agent.messages = value;
      },
      get messageSeqs() {
        return agent.messageSeqs;
      },
      set messageSeqs(value) {
        agent.messageSeqs = value;
      },
      get session() {
        return agent.session;
      },
      set session(value) {
        agent.session = value;
      },
      get planContext() {
        return agent.planContext;
      },
      set planContext(value) {
        agent.planContext = value;
      },
      get abortController() {
        return agent.abortController;
      },
      set abortController(value) {
        agent.abortController = value;
      },
      get sessionStartHookFired() {
        return agent.sessionStartHookFired;
      },
      set sessionStartHookFired(value) {
        agent.sessionStartHookFired = value;
      },
      getSessionId: () => this.getSessionId(),
      requireProvider: () => this.requireProvider(),
      evaluatePermission: (action, resource) => agent.permissionStore.evaluate(action, resource),
      get resolvePermission() {
        return agent.permissionResolver ?? undefined;
      },
      persistTurnUser: (userMessage) => agent.persistTurnUser(userMessage),
      updateTurnDraft: (text) => agent.updateTurnDraft(text),
      deleteTurnDraft: () => agent.deleteTurnDraft(),
      abandonPersistedTurn: (userSeq) => agent.abandonPersistedTurn(userSeq),
      askQuestion: (questions, abortSignal) => agent.askQuestion(questions, abortSignal),
      get sessionTokenBudget() {
        return agent.sessionTokenBudget;
      },
      fireHook: (input, signal) => this.fireHook(input, signal),
      recordUsage: (usage, source, model) => this.recordUsage(usage, source, model),
      emitSubagentStatus: (status) => this.emitSubagentStatus(status),
      discardAbortedTurn: (userMessage) => this.discardAbortedTurn(userMessage),
      refreshSessionRecap: (signal) => this.refreshSessionRecap(signal),
      consumeBackgroundNotifications: () => this.consumeBackgroundNotifications(),
      runSubagent: (request, abortSignal) => this.runSubagent(request, abortSignal),
      readDelegation: (id) => this.readDelegation(id),
      listDelegations: () => this.listDelegations(),
    };
  }

  async *processMessage(
    userMessage: string,
    observer?: ProcessMessageObserver,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const sessionId = this.session?.id ?? null;
    const hasStore = !!this.sessionStore && !!sessionId;
    if (hasStore && sessionId) {
      setTurnClaim(sessionId, userMessage.slice(0, 200));
    }
    try {
      yield* processMessageLoop(this.loopContext, userMessage, observer);
    } finally {
      if (hasStore && sessionId) {
        clearTurnClaim(sessionId);
      }
    }
  }

  private appendCompletedTurn(
    userMessage: ModelMessage,
    newMessages: ModelMessage[],
    thought?: { durationMs: number; text: string },
  ): void {
    appendCompletedTurnLoop(this.loopContext, userMessage, newMessages, thought);
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
