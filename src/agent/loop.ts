import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { addBatchRequests, createBatch, getBatchChatCompletion, pollBatchRequestResult } from "../crow/batch";
import { type CrowProvider, createProvider, createReasoningCapture, resolveModelRuntime } from "../crow/client";
import type { getModelInfo } from "../crow/models";
import { toolSetToBatchTools } from "../crow/tool-schemas";
import { createTools } from "../crow/tools";
import type { executeEventHooks } from "../hooks/index";
import type {
  PostCompactHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  UserPromptSubmitHookInput,
} from "../hooks/types";
import { buildMcpToolSet } from "../mcp/runtime";
import {
  appendCompaction,
  appendMessages,
  getNextMessageSequence,
  recordThought,
  type SessionStore,
} from "../storage/index";
import type { BashTool } from "../tools/bash";
import type { ScheduleManager } from "../tools/schedule";
import type {
  AgentMode,
  SessionInfo,
  StreamChunk,
  SubagentRequest,
  SubagentStatus,
  ToolCall,
  ToolResult,
  UsageSource,
} from "../types/index";
import { loadAgentDefinitions } from "../utils/agent-files";
import { type CustomSubagentConfig, loadMcpServers, loadValidSubAgents } from "../utils/settings";
import type { ProcessMessageObserver } from "./agent";
import {
  accumulateUsage,
  type BatchContext,
  buildAssistantBatchMessage,
  buildBatchChatCompletionRequest,
  buildBatchName,
  buildToolBatchMessage,
  type ExecutedBatchTool,
  executeBatchToolCall,
  getBatchClientOptions,
  getBatchFinishReason,
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
  generateCompactionSummary,
  prepareCompaction,
  relaxCompactionSettings,
  shouldCompactContext,
} from "./compaction";
import { humanizeApiError, isAuthenticationError, isContextLimitError } from "./errors";
import { applyModelConstraints, buildSystemPrompt } from "./prompts";
import { sanitizeModelMessages } from "./reasoning";
import { ThoughtTracker } from "./thought";
import { buildVisionUserMessages } from "./vision-input";

export interface LoopContext {
  bash: BashTool;
  modelId: string;
  providerId: string | null;
  mode: AgentMode;
  maxTokens: number;
  maxToolRounds: number;
  batchApi: boolean;
  apiKey: string | null;
  baseURL: string | null;
  sessionStore: SessionStore | null;
  schedules: ScheduleManager;
  sendTelegramFile: ((filePath: string) => Promise<ToolResult>) | null;
  batch: BatchContext;
  messages: ModelMessage[];
  messageSeqs: Array<number | null>;
  session: SessionInfo | null;
  planContext: string | null;
  abortController: AbortController | null;
  sessionStartHookFired: boolean;
  getSessionId(): string | null;
  requireProvider(): CrowProvider;
  fireHook(
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<typeof executeEventHooks>>>;
  recordUsage(usage: ProcessMessageUsage, source: UsageSource, modelId: string): void;
  emitSubagentStatus(status: SubagentStatus | null): void;
  discardAbortedTurn(userMessage: ModelMessage): void;
  refreshSessionRecap(signal?: AbortSignal): Promise<void>;
  consumeBackgroundNotifications(): Promise<string[]>;
  runSubagent(request: SubagentRequest, abortSignal?: AbortSignal): Promise<ToolResult>;
  readDelegation(id: string): Promise<ToolResult>;
  listDelegations(): Promise<ToolResult>;
}

function getCompactionSettings(maxTokens: number): CompactionSettings {
  return {
    reserveTokens: Math.max(maxTokens, DEFAULT_RESERVE_TOKENS),
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
  };
}

async function compactForContext(
  ctx: LoopContext,
  provider: CrowProvider,
  system: string,
  contextWindow: number,
  signal: AbortSignal,
  settings = getCompactionSettings(ctx.maxTokens),
  force = false,
): Promise<boolean> {
  if (!ctx.session) return false;

  const preparation = prepareCompaction(ctx.messages, system, settings);
  if (!preparation) return false;
  if (!force && !shouldCompactContext(preparation.tokensBefore, contextWindow, settings)) {
    return false;
  }

  const trigger = force ? "manual" : "auto";
  const preCompactInput: PreCompactHookInput = {
    hook_event_name: "PreCompact",
    trigger,
    session_id: ctx.session?.id,
    cwd: ctx.bash.getCwd(),
  };
  await ctx.fireHook(preCompactInput, signal).catch(() => {});

  const keptSeqs = ctx.messageSeqs.slice(preparation.firstKeptIndex);
  const firstKeptSeq = keptSeqs.find((seq): seq is number => seq !== null) ?? getNextMessageSequence(ctx.session.id);
  const summary = await generateCompactionSummary(provider, ctx.modelId, preparation, undefined, signal);

  appendCompaction(ctx.session.id, firstKeptSeq, summary, preparation.tokensBefore);
  ctx.messages = [createCompactionSummaryMessage(summary), ...preparation.keptMessages];
  ctx.messageSeqs = [null, ...keptSeqs];

  const postCompactInput: PostCompactHookInput = {
    hook_event_name: "PostCompact",
    trigger,
    session_id: ctx.session?.id,
    cwd: ctx.bash.getCwd(),
  };
  await ctx.fireHook(postCompactInput, signal).catch(() => {});

  return true;
}

async function* processMessageBatchTurn(
  ctx: LoopContext,
  args: {
    userModelMessage: ModelMessage;
    observer?: ProcessMessageObserver;
    provider: CrowProvider;
    subagents: CustomSubagentConfig[];
    system: string;
    runtime: ReturnType<typeof resolveModelRuntime>;
    modelInfo: ReturnType<typeof getModelInfo>;
    signal: AbortSignal;
  },
): AsyncGenerator<StreamChunk, void, unknown> {
  const { userModelMessage, observer, provider, subagents, system, runtime, modelInfo, signal } = args;
  let attemptedOverflowRecovery = false;

  while (true) {
    let closeMcp: (() => Promise<void>) | undefined;
    const turnMessages: ModelMessage[] = [];
    const totalUsage: ProcessMessageUsage = {};

    try {
      const settings = attemptedOverflowRecovery
        ? relaxCompactionSettings(getCompactionSettings(ctx.maxTokens))
        : getCompactionSettings(ctx.maxTokens);
      if (modelInfo) {
        await compactForContext(
          ctx,
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

      const baseTools = createTools(ctx.bash, provider, ctx.mode, {
        modelId: ctx.modelId,
        providerId: ctx.providerId ?? undefined,
        runSubagent: (request, abortSignal) => ctx.runSubagent(request, combineAbortSignals(signal, abortSignal)),
        readDelegation: (id) => ctx.readDelegation(id),
        listDelegations: () => ctx.listDelegations(),
        scheduleManager: ctx.schedules,
        subagents,
        agentDefinitions: loadAgentDefinitions(ctx.bash.getCwd()),
        sendTelegramFile: ctx.sendTelegramFile ?? undefined,
        sessionId: ctx.session?.id ?? undefined,
      });
      let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
      if (ctx.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
        const mcpBundle = await buildMcpToolSet(loadMcpServers());
        closeMcp = mcpBundle.close;
        tools = { ...baseTools, ...mcpBundle.tools };
        if (mcpBundle.errors.length > 0) {
          yield { type: "content", content: `MCP unavailable: ${mcpBundle.errors.join(" | ")}\n\n` };
        }
      }

      const batchTools = runtime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(tools);
      const batch = await createBatch({
        ...getBatchClientOptions(ctx.batch, signal),
        name: buildBatchName("session", ctx.getSessionId() || runtime.modelId),
      });

      for (let round = 0; round < ctx.maxToolRounds; round++) {
        const stepNumber = round + 1;
        notifyObserver(observer?.onStepStart, {
          stepNumber,
          timestamp: Date.now(),
        });

        const batchRequestId = `turn-${Date.now()}-${stepNumber}`;
        await addBatchRequests({
          ...getBatchClientOptions(ctx.batch, signal),
          batchId: batch.batch_id,
          batchRequests: [
            {
              batch_request_id: batchRequestId,
              batch_request: {
                chat_get_completion: buildBatchChatCompletionRequest({
                  modelId: runtime.modelId,
                  system,
                  messages: [...ctx.messages, ...turnMessages],
                  temperature: 0.7,
                  maxOutputTokens: runtime.modelInfo?.supportsMaxOutputTokens === false ? undefined : ctx.maxTokens,
                  reasoningEffort: undefined,
                  tools: batchTools,
                }),
              },
            },
          ],
        });

        const result = await pollBatchRequestResult({
          ...getBatchClientOptions(ctx.batch, signal),
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

        const requestMessages = [...ctx.messages, ...turnMessages];
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
            ctx.recordUsage(totalUsage, "message", runtime.modelId);
          }
          appendCompletedTurn(ctx, userModelMessage, turnMessages);
          await ctx.refreshSessionRecap(signal);
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

          const executed = await executeBatchToolCall(tools, toolCall, requestMessages, signal);
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

      const message = `Error: Reached max tool rounds (${ctx.maxToolRounds}) in batch mode.`;
      notifyObserver(observer?.onError, {
        message,
        timestamp: Date.now(),
      });
      if (hasUsage(totalUsage)) {
        ctx.recordUsage(totalUsage, "message", runtime.modelId);
      }
      appendCompletedTurn(ctx, userModelMessage, turnMessages);
      yield { type: "error", content: message };
      yield { type: "done" };
      return;
    } catch (err: unknown) {
      if (signal.aborted) {
        ctx.discardAbortedTurn(userModelMessage);
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
        ctx.recordUsage(totalUsage, "message", runtime.modelId);
      }
      appendCompletedTurn(ctx, userModelMessage, turnMessages);
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

export function appendCompletedTurn(
  ctx: LoopContext,
  userMessage: ModelMessage,
  newMessages: ModelMessage[],
  thought?: { durationMs: number; text: string },
): void {
  if (newMessages.length === 0) return;

  const userIndex = ctx.messages.lastIndexOf(userMessage);
  if (!ctx.sessionStore || !ctx.session) {
    if (userIndex >= 0 && ctx.messageSeqs[userIndex] == null) {
      ctx.messageSeqs[userIndex] = null;
    }
    ctx.messages.push(...newMessages);
    ctx.messageSeqs.push(...newMessages.map(() => null));
    return;
  }

  const insertedSeqs = appendMessages(ctx.session.id, [userMessage, ...newMessages]);
  if (userIndex >= 0) {
    ctx.messageSeqs[userIndex] = insertedSeqs[0] ?? ctx.messageSeqs[userIndex];
  }
  ctx.messages.push(...newMessages);
  ctx.messageSeqs.push(...insertedSeqs.slice(1));
  if (thought != null) {
    const firstAssistantIndex = newMessages.findIndex((message) => message.role === "assistant");
    const firstAssistantSeq = firstAssistantIndex >= 0 ? insertedSeqs[1 + firstAssistantIndex] : undefined;
    if (firstAssistantSeq != null) {
      recordThought(ctx.session.id, firstAssistantSeq, thought.durationMs, thought.text);
    }
  }
  ctx.sessionStore.touchSession(ctx.session.id, ctx.bash.getCwd());
  ctx.session = ctx.sessionStore.getRequiredSession(ctx.session.id);
}

export async function* processMessage(
  ctx: LoopContext,
  userMessage: string,
  observer?: ProcessMessageObserver,
): AsyncGenerator<StreamChunk, void, unknown> {
  ctx.abortController = new AbortController();
  const signal = ctx.abortController.signal;
  ctx.emitSubagentStatus(null);

  if (!ctx.sessionStartHookFired) {
    ctx.sessionStartHookFired = true;
    const isResume = ctx.messages.length > 0;
    const sessionStartInput: SessionStartHookInput = {
      hook_event_name: "SessionStart",
      source: isResume ? "resume" : "startup",
      session_id: ctx.session?.id,
      cwd: ctx.bash.getCwd(),
    };
    await ctx.fireHook(sessionStartInput, signal).catch(() => {});
  }

  const promptInput: UserPromptSubmitHookInput = {
    hook_event_name: "UserPromptSubmit",
    user_prompt: userMessage,
    session_id: ctx.session?.id,
    cwd: ctx.bash.getCwd(),
  };
  await ctx.fireHook(promptInput, signal).catch(() => {});

  await ctx.consumeBackgroundNotifications();
  const userModelMessages = await buildVisionUserMessages(userMessage, ctx.bash.getCwd(), signal);
  const userModelMessage = userModelMessages[0] ?? ({ role: "user", content: userMessage } satisfies ModelMessage);
  ctx.messages.push(userModelMessage);
  ctx.messageSeqs.push(null);

  ctx.requireProvider();
  const thoughtTracker = new ThoughtTracker();
  const reasoningCapture = createReasoningCapture((text) => {
    thoughtTracker.capture(text);
  });
  const provider = createProvider(ctx.apiKey ?? "", ctx.baseURL ?? undefined, reasoningCapture.fetch);
  const subagents = loadValidSubAgents();
  const system = applyModelConstraints(
    buildSystemPrompt(
      ctx.bash.getCwd(),
      ctx.mode,
      ctx.bash.getSandboxMode(),
      ctx.planContext,
      subagents,
      ctx.bash.getSandboxSettings(),
    ),
    ctx.modelId,
  );
  const runtime = resolveModelRuntime(provider, ctx.modelId);
  const modelInfo = runtime.modelInfo;
  ctx.planContext = null;
  let attemptedOverflowRecovery = false;

  if (ctx.batchApi) {
    try {
      yield* processMessageBatchTurn(ctx, {
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
      if (ctx.abortController?.signal === signal) {
        ctx.abortController = null;
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
          ? relaxCompactionSettings(getCompactionSettings(ctx.maxTokens))
          : getCompactionSettings(ctx.maxTokens);
        if (modelInfo) {
          await compactForContext(
            ctx,
            provider,
            system,
            modelInfo.contextWindow,
            signal,
            settings,
            attemptedOverflowRecovery,
          );
        }

        const baseTools = createTools(ctx.bash, provider, ctx.mode, {
          modelId: ctx.modelId,
          providerId: ctx.providerId ?? undefined,
          runSubagent: (request, abortSignal) => ctx.runSubagent(request, combineAbortSignals(signal, abortSignal)),
          readDelegation: (id) => ctx.readDelegation(id),
          listDelegations: () => ctx.listDelegations(),
          scheduleManager: ctx.schedules,
          subagents,
          agentDefinitions: loadAgentDefinitions(ctx.bash.getCwd()),
          sendTelegramFile: ctx.sendTelegramFile ?? undefined,
          sessionId: ctx.session?.id ?? undefined,
        });
        let tools: ToolSet = runtime.modelInfo?.supportsClientTools === false ? {} : baseTools;
        if (ctx.mode === "agent" && runtime.modelInfo?.supportsClientTools !== false) {
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
          messages: ctx.messages,
          tools,
          stopWhen: stepCountIs(ctx.maxToolRounds),
          maxRetries: 0,
          abortSignal: signal,
          temperature: 0.7,
          ...(runtime.modelInfo?.supportsMaxOutputTokens === false ? {} : { maxOutputTokens: ctx.maxTokens }),
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
            ctx.recordUsage(totalUsage, "message", runtime.modelId);
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
          ctx.discardAbortedTurn(userModelMessage);
          yield { type: "done" };
          return;
        }

        await reasoningCapture.settled();
        const thought = thoughtTracker.finish();
        try {
          const response = await result.response;
          if (!signal.aborted) {
            appendCompletedTurn(ctx, userModelMessage, sanitizeModelMessages(response.messages), thought);
            await ctx.refreshSessionRecap(signal);
            streamOk = true;
          }
        } catch (responseError: unknown) {
          if (!attemptedOverflowRecovery && !assistantText.trim() && modelInfo && isContextLimitError(responseError)) {
            attemptedOverflowRecovery = true;
            continue;
          }
        }

        if (signal.aborted) {
          ctx.discardAbortedTurn(userModelMessage);
          yield { type: "done" };
          return;
        }

        if (!streamOk && assistantText.trim()) {
          appendCompletedTurn(ctx, userModelMessage, [{ role: "assistant", content: assistantText }], thought);
          await ctx.refreshSessionRecap(signal);
        }

        const stopInput: StopHookInput = {
          hook_event_name: "Stop",
          session_id: ctx.session?.id,
          cwd: ctx.bash.getCwd(),
        };
        await ctx.fireHook(stopInput, signal).catch(() => {});

        yield { type: "done" };
        return;
      } catch (err: unknown) {
        if (signal.aborted) {
          ctx.discardAbortedTurn(userModelMessage);
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
          appendCompletedTurn(ctx, userModelMessage, [{ role: "assistant", content: assistantText }]);
        }

        const stopFailureInput: StopFailureHookInput = {
          hook_event_name: "StopFailure",
          error: friendly,
          session_id: ctx.session?.id,
          cwd: ctx.bash.getCwd(),
        };
        await ctx.fireHook(stopFailureInput, signal).catch(() => {});

        yield { type: "done" };
        return;
      } finally {
        await closeMcp?.().catch(() => {});
      }
    }
  } finally {
    if (ctx.abortController?.signal === signal) {
      ctx.abortController = null;
    }
  }
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

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
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
