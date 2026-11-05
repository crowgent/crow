import { convertToBase64 } from "@ai-sdk/provider-utils";
import type { ModelMessage, ToolSet } from "ai";
import {
  addBatchRequests,
  type BatchChatCompletionRequest,
  type BatchChatCompletionResponse,
  type BatchChatMessage,
  type BatchClientOptions,
  type BatchFunctionTool,
  type BatchToolCall,
  createBatch,
  getBatchChatCompletion,
  pollBatchRequestResult,
} from "../crow/batch";
import type { resolveModelRuntime } from "../crow/client";
import { toolSetToBatchTools } from "../crow/tool-schemas";
import type { Plan, TaskRequest, ToolCall, ToolResult, UsageSource } from "../types/index";
import { getReasoningEffortForModel } from "../utils/settings";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface BatchContext {
  apiKey: string | null | undefined;
  baseURL?: string;
  maxTokens: number;
  recordUsage: (usage: ProcessMessageUsage, source: UsageSource, modelId: string) => void;
  formatActivity: (toolName: string, args?: unknown) => string;
}

export type ProcessMessageFinishReason = "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";

export interface ProcessMessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsdTicks?: number;
}

export interface ExecutedBatchTool {
  toolCall: ToolCall;
  input: unknown;
  toolResult: ToolResult;
}

export function getBatchClientOptions(ctx: BatchContext, signal?: AbortSignal): BatchClientOptions {
  if (!ctx.apiKey) {
    throw new Error("API key required. Add an API key to continue.");
  }

  return {
    apiKey: ctx.apiKey,
    baseURL: ctx.baseURL,
    signal,
  };
}

export async function executeBatchToolCall(
  tools: ToolSet,
  toolCall: ToolCall,
  messages: ModelMessage[],
  signal?: AbortSignal,
): Promise<{ input: unknown; result: ToolResult }> {
  const tool = tools[toolCall.function.name];
  if (!tool || tool.type === "provider" || typeof tool.execute !== "function") {
    return {
      input: parseToolArgumentsOrRaw(toolCall.function.arguments),
      result: {
        success: false,
        output: `Tool "${toolCall.function.name}" is unavailable in batch mode.`,
      },
    };
  }

  let parsedInput: unknown;
  try {
    parsedInput = toolCall.function.arguments.trim() ? JSON.parse(toolCall.function.arguments) : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: toolCall.function.arguments,
      result: {
        success: false,
        output: `Tool "${toolCall.function.name}" received invalid JSON arguments: ${message}`,
      },
    };
  }

  try {
    const output = await tool.execute(parsedInput as never, {
      toolCallId: toolCall.id,
      messages,
      abortSignal: signal,
    });
    return {
      input: parsedInput,
      result: toToolResult(output),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      input: parsedInput,
      result: {
        success: false,
        output: `Tool "${toolCall.function.name}" failed: ${message}`,
      },
    };
  }
}

export async function runTaskRequestBatch(
  ctx: BatchContext,
  args: {
    request: TaskRequest;
    childMessages: ModelMessage[];
    childSystem: string;
    childRuntime: ReturnType<typeof resolveModelRuntime>;
    childTools: ToolSet;
    maxSteps: number;
    initialDetail: string;
    onActivity?: (detail: string) => void;
    signal?: AbortSignal;
  },
): Promise<ToolResult> {
  const { request, childMessages, childSystem, childRuntime, childTools, maxSteps, initialDetail, onActivity, signal } =
    args;

  if (childRuntime.modelInfo?.responsesOnly) {
    throw new Error("Batch mode currently supports chat-completions models only.");
  }

  const batchTools = childRuntime.modelInfo?.supportsClientTools === false ? [] : await toolSetToBatchTools(childTools);
  const batch = await createBatch({
    ...getBatchClientOptions(ctx, signal),
    name: buildBatchName(`task-${request.agent}`, request.description),
  });

  const turnMessages: ModelMessage[] = [];
  const totalUsage: ProcessMessageUsage = {};
  let assistantText = "";
  let lastActivity = initialDetail;

  for (let round = 0; round < maxSteps; round++) {
    const batchRequestId = `task-${Date.now()}-${round + 1}`;
    await addBatchRequests({
      ...getBatchClientOptions(ctx, signal),
      batchId: batch.batch_id,
      batchRequests: [
        {
          batch_request_id: batchRequestId,
          batch_request: {
            chat_get_completion: buildBatchChatCompletionRequest({
              modelId: childRuntime.modelId,
              system: childSystem,
              messages: [...childMessages, ...turnMessages],
              temperature: request.agent === "explore" ? 0.2 : 0.5,
              maxOutputTokens:
                childRuntime.modelInfo?.supportsMaxOutputTokens === false ? undefined : Math.min(ctx.maxTokens, 8_192),
              reasoningEffort: getReasoningEffortForModel(childRuntime.modelId),
              tools: batchTools,
            }),
          },
        },
      ],
    });

    const result = await pollBatchRequestResult({
      ...getBatchClientOptions(ctx, signal),
      batchId: batch.batch_id,
      batchRequestId,
    });
    const response = getBatchChatCompletion(result);
    accumulateUsage(totalUsage, getBatchUsage(response));

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("Batch response did not contain any choices.");
    }
    const content = choice?.message.content ?? "";
    if (content) {
      assistantText += content;
    }

    const requestMessages = [...childMessages, ...turnMessages];
    const toolCalls = (choice?.message.tool_calls ?? []).map(toLocalToolCall);
    const assistantMessage = buildAssistantBatchMessage(content, toolCalls);
    if (assistantMessage) {
      turnMessages.push(assistantMessage);
    }

    if (toolCalls.length === 0) {
      if (hasUsage(totalUsage)) {
        ctx.recordUsage(totalUsage, "task", childRuntime.modelId);
      }
      const output = assistantText.trim() || `Task completed. Last action: ${lastActivity}`;
      return {
        success: true,
        output,
        task: {
          agent: request.agent,
          description: request.description,
          summary: firstLine(output),
          activity: lastActivity,
        },
      };
    }

    const toolParts: ExecutedBatchTool[] = [];
    for (const toolCall of toolCalls) {
      const nextActivity = ctx.formatActivity(
        toolCall.function.name,
        parseToolArgumentsOrRaw(toolCall.function.arguments),
      );
      lastActivity = nextActivity;
      onActivity?.(nextActivity);

      const executed = await executeBatchToolCall(childTools, toolCall, requestMessages, signal);
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
  }

  if (hasUsage(totalUsage)) {
    ctx.recordUsage(totalUsage, "task", childRuntime.modelId);
  }
  const output = assistantText.trim() || `Task stopped after ${maxSteps} batch rounds. Last action: ${lastActivity}`;
  return {
    success: false,
    output,
    task: {
      agent: request.agent,
      description: request.description,
      summary: output,
      activity: lastActivity,
    },
  };
}

export function buildBatchName(prefix: string, label: string): string {
  const compact =
    label
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9._-]+/g, "")
      .slice(0, 48) || "run";
  return `crow-${prefix}-${compact}`;
}

export function buildBatchChatCompletionRequest(args: {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens?: number;
  reasoningEffort?: BatchChatCompletionRequest["reasoning_effort"];
  tools: BatchFunctionTool[];
}): BatchChatCompletionRequest {
  return {
    model: args.modelId,
    messages: toBatchChatMessages(args.system, args.messages),
    temperature: args.temperature,
    ...(args.maxOutputTokens != null ? { max_completion_tokens: args.maxOutputTokens } : {}),
    ...(args.reasoningEffort ? { reasoning_effort: args.reasoningEffort } : {}),
    ...(args.tools.length > 0 ? { tools: args.tools } : {}),
  };
}

export function toBatchChatMessages(system: string, messages: ModelMessage[]): BatchChatMessage[] {
  const batchMessages: BatchChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const { role, content } = message;

    switch (role) {
      case "system":
        batchMessages.push({ role: "system", content });
        break;

      case "user": {
        if (typeof content === "string") {
          batchMessages.push({ role: "user", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        if (content.length === 1 && content[0]?.type === "text") {
          batchMessages.push({ role: "user", content: content[0].text });
          break;
        }

        const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
          [];
        for (const part of content) {
          switch (part.type) {
            case "text":
              userContent.push({ type: "text", text: part.text });
              break;

            case "image": {
              const mediaType = part.mediaType === "image/*" || !part.mediaType ? "image/jpeg" : part.mediaType;
              const data =
                part.image instanceof URL
                  ? part.image.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.image)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }

            case "file": {
              if (!part.mediaType.startsWith("image/")) {
                break;
              }
              const mediaType = part.mediaType === "image/*" ? "image/jpeg" : part.mediaType;
              const data =
                part.data instanceof URL
                  ? part.data.toString()
                  : `data:${mediaType};base64,${toBase64DataContent(part.data)}`;
              userContent.push({ type: "image_url", image_url: { url: data } });
              break;
            }
          }
        }
        batchMessages.push({
          role: "user",
          content: userContent,
        });
        break;
      }

      case "assistant": {
        if (typeof content === "string") {
          batchMessages.push({ role: "assistant", content });
          break;
        }

        if (!Array.isArray(content)) {
          break;
        }

        let assistantText = "";
        const toolCalls: BatchToolCall[] = [];
        for (const part of content) {
          if (part.type === "text") {
            assistantText += part.text;
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.toolCallId,
              type: "function",
              function: {
                name: part.toolName,
                arguments: JSON.stringify(part.input),
              },
            });
          }
        }

        if (assistantText || toolCalls.length > 0) {
          batchMessages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
        break;
      }

      case "tool":
        for (const part of content) {
          if (part.type === "tool-approval-response") {
            continue;
          }
          batchMessages.push({
            role: "tool",
            tool_call_id: part.toolCallId,
            content: toolOutputToText(part.output),
          });
        }
        break;
    }
  }

  return batchMessages;
}

export function toBase64DataContent(value: string | Uint8Array | ArrayBuffer): string {
  return convertToBase64(value instanceof ArrayBuffer ? new Uint8Array(value) : value);
}

export function toolOutputToText(output: {
  type: "text" | "json" | "execution-denied" | "error-text" | "error-json" | "content";
  value?: unknown;
  reason?: string;
}): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return String(output.value ?? "");
    case "execution-denied":
      return output.reason ?? "Tool execution denied.";
    case "json":
    case "error-json":
    case "content":
      return JSON.stringify(output.value ?? null);
  }
}

export function getBatchUsage(response: BatchChatCompletionResponse): ProcessMessageUsage {
  const usage = response.usage ?? {};
  const inputTokens = asNumber(usage.input_tokens) ?? asNumber(usage.prompt_tokens);
  const outputTokens = asNumber(usage.output_tokens) ?? asNumber(usage.completion_tokens);
  const totalTokens = asNumber(usage.total_tokens) ?? sumDefined(inputTokens, outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsdTicks: asNumber(usage.cost_in_usd_ticks),
  };
}

export function accumulateUsage(target: ProcessMessageUsage, usage: ProcessMessageUsage): void {
  target.inputTokens = (target.inputTokens ?? 0) + (usage.inputTokens ?? 0);
  target.outputTokens = (target.outputTokens ?? 0) + (usage.outputTokens ?? 0);
  target.totalTokens = (target.totalTokens ?? 0) + (usage.totalTokens ?? 0);
  target.costUsdTicks = (target.costUsdTicks ?? 0) + (usage.costUsdTicks ?? 0);
}

export function hasUsage(usage: ProcessMessageUsage): boolean {
  return Boolean(
    (usage.inputTokens ?? 0) || (usage.outputTokens ?? 0) || (usage.totalTokens ?? 0) || (usage.costUsdTicks ?? 0),
  );
}

export function getBatchFinishReason(finishReason: string | null | undefined): ProcessMessageFinishReason {
  switch (finishReason) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
      return finishReason;
    case "tool_calls":
      return "tool-calls";
    default:
      return "other";
  }
}

export function toLocalToolCall(toolCall: BatchToolCall): ToolCall {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  };
}

export function buildAssistantBatchMessage(content: string, toolCalls: ToolCall[]): ModelMessage | null {
  if (toolCalls.length === 0) {
    return content ? { role: "assistant", content } : null;
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  > = [];
  if (content) {
    parts.push({ type: "text", text: content });
  }
  for (const toolCall of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      input: parseToolArgumentsOrRaw(toolCall.function.arguments),
    });
  }
  return { role: "assistant", content: parts };
}

export function buildToolBatchMessage(toolParts: ExecutedBatchTool[]): ModelMessage | null {
  if (toolParts.length === 0) {
    return null;
  }

  return {
    role: "tool",
    content: toolParts.map((part) => ({
      type: "tool-result" as const,
      toolCallId: part.toolCall.id,
      toolName: part.toolCall.function.name,
      output: part.toolResult.success
        ? ({ type: "json", value: toSerializableValue(part.toolResult) } as const)
        : ({ type: "error-json", value: toSerializableValue(part.toolResult) } as const),
    })),
  };
}

export function parseToolArgumentsOrRaw(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

export function toToolResult(output: unknown): ToolResult {
  if (output && typeof output === "object" && "success" in output) {
    const r = output as {
      success: boolean;
      output?: string;
      error?: string;
      diff?: ToolResult["diff"];
      plan?: Plan;
      task?: ToolResult["task"];
      delegation?: ToolResult["delegation"];
      backgroundProcess?: ToolResult["backgroundProcess"];
      media?: ToolResult["media"];
      computer?: ToolResult["computer"];
      lspDiagnostics?: ToolResult["lspDiagnostics"];
    };
    return {
      success: r.success,
      output: r.output,
      error: r.error ?? (r.success ? undefined : r.output),
      diff: r.diff,
      plan: r.plan,
      task: r.task,
      delegation: r.delegation,
      backgroundProcess: r.backgroundProcess,
      media: r.media,
      computer: r.computer,
      lspDiagnostics: r.lspDiagnostics,
    };
  }
  return { success: true, output: String(output) };
}

export function firstLine(text: string): string {
  return text.trim().split("\n").find(Boolean)?.trim() || "Task completed.";
}

export function toSerializableValue(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
  } catch {
    return String(value);
  }
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function sumDefined(left?: number, right?: number): number | undefined {
  if (left == null && right == null) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}
