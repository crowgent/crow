import { type ModelMessage, stepCountIs, streamText, type ToolSet } from "ai";
import { type CrowProvider, createProvider, resolveModelRuntime } from "../crow/client";
import { normalizeModelId } from "../crow/models";
import { createTools } from "../crow/tools";
import type { executeEventHooks } from "../hooks/index";
import { buildMcpToolSet } from "../mcp/runtime";
import { appendMessages, loadTranscript, type SessionStore } from "../storage/index";
import { BashTool } from "../tools/bash";
import type {
  AgentMode,
  SubagentRequest,
  SubagentStatus,
  TaskRequest,
  ToolResult,
  UsageSource,
  VerifyRecipe,
} from "../types/index";
import { builtinAgentDefinitions, findAgentDefinition, loadAgentDefinitions } from "../utils/agent-files";
import { findProvider } from "../utils/providers";
import {
  getProviderApiKey,
  loadCustomProviders,
  loadMcpServers,
  loadUserSettings,
  loadValidSubAgents,
  type SandboxSettings,
} from "../utils/settings";
import { prepareVerifySandbox } from "../verify/entrypoint";
import { type BatchContext, firstLine, runTaskRequestBatch } from "./batch";
import { applyModelConstraints, buildFileAgentPrompt, buildSubagentPrompt, findCustomSubagent } from "./prompts";
import { buildVisionUserMessages } from "./vision-input";

export interface SubagentContext {
  provider: CrowProvider;
  bash: BashTool;
  modelId: string;
  providerId: string | null;
  maxToolRounds: number;
  maxTokens: number;
  batchApi: boolean;
  batch: BatchContext;
  sessionId?: string;
  sessionStore?: SessionStore | null;
  fireHook: (
    input: Parameters<typeof executeEventHooks>[0],
    signal?: AbortSignal,
  ) => Promise<Awaited<ReturnType<typeof executeEventHooks>>>;
  emitSubagentStatus: (status: SubagentStatus | null) => void;
  recordUsage: (
    usage: { totalTokens?: number; inputTokens?: number; outputTokens?: number },
    source: UsageSource,
    modelId: string,
  ) => void;
}

export interface RunTaskRequestOptions {
  modelOverride?: string;
  history?: ModelMessage[];
}

export async function runTaskRequest(
  ctx: SubagentContext,
  request: TaskRequest,
  onActivity?: (detail: string) => void,
  abortSignal?: AbortSignal,
  opts?: RunTaskRequestOptions,
): Promise<ToolResult> {
  const provider = ctx.provider;
  const signal = abortSignal;
  const agentKey = String(request.agent);
  const isExplore = agentKey === "explore";
  const isGeneral = agentKey === "general";
  const isVision = agentKey === "vision";
  const isVerify = agentKey === "verify";
  const isVerifyDetect = agentKey === "verify-detect";
  const isVerifyManifest = agentKey === "verify-manifest";
  const isComputer = agentKey === "computer";
  const subagents = loadValidSubAgents();
  const definitions = loadAgentDefinitions(ctx.bash.getCwd());
  const definition = findAgentDefinition(definitions, agentKey);
  const fileDefinition = definition && definition.source !== "settings" ? definition : undefined;
  const custom =
    !isExplore && !isGeneral && !isVision && !isVerify && !isVerifyDetect && !isVerifyManifest && !isComputer
      ? findCustomSubagent(agentKey, subagents)
      : undefined;

  if (definition && !definition.enabled) {
    const message = `Sub-agent "${agentKey}" is disabled.`;
    return {
      success: false,
      output: message,
      task: {
        agent: agentKey,
        description: request.description,
        summary: message,
      },
    };
  }

  if (definition && definition.mode === "primary") {
    const message = `Sub-agent "${agentKey}" is a primary-session agent and cannot be delegated work.`;
    return {
      success: false,
      output: message,
      task: {
        agent: agentKey,
        description: request.description,
        summary: message,
      },
    };
  }

  if (
    !isExplore &&
    !isGeneral &&
    !isVision &&
    !isVerify &&
    !isVerifyDetect &&
    !isVerifyManifest &&
    !isComputer &&
    !custom &&
    !fileDefinition
  ) {
    const message = `Unknown sub-agent "${agentKey}". Use general, explore, vision, verify, verify-detect, verify-manifest, computer, a configured name from ~/.crow/user-settings.json, or a Markdown agent from .crow/agents.`;
    return {
      success: false,
      output: message,
      task: {
        agent: agentKey,
        description: request.description,
        summary: message,
      },
    };
  }

  const childMode: AgentMode = isExplore || isVerifyDetect ? "ask" : "agent";
  const verifySandboxOverrides: SandboxSettings = isVerify
    ? { allowNet: true, allowedHosts: undefined, allowEphemeralInstall: true, hostBrowserCommandsOnHost: true }
    : {};
  let verifyPreparedSettings: SandboxSettings | null = null;
  let verifyPreparedRecipe: VerifyRecipe | null = null;
  if (isVerify) {
    const prepared = await prepareVerifySandbox(
      ctx.bash.getCwd(),
      { ...ctx.bash.getSandboxSettings(), ...verifySandboxOverrides },
      undefined,
      onActivity,
    );
    verifyPreparedSettings = prepared.sandboxSettings;
    verifyPreparedRecipe = prepared.profile.recipe;
  }
  const childBash = new BashTool(ctx.bash.getCwd(), {
    sandboxMode: isVerify ? "shuru" : ctx.bash.getSandboxMode(),
    sandboxSettings: isVerify
      ? (verifyPreparedSettings ?? { ...ctx.bash.getSandboxSettings(), ...verifySandboxOverrides })
      : ctx.bash.getSandboxSettings(),
  });
  const childModelId = normalizeModelId(
    opts?.modelOverride ??
      (fileDefinition && fileDefinition.model !== "inherit"
        ? fileDefinition.model
        : custom
          ? custom.model
          : ctx.modelId),
  );
  const settingsDefaultMaxTurns = (() => {
    const value = loadUserSettings().subagents?.defaultMaxTurns;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  })();
  const turnCap = fileDefinition?.maxTurns ?? settingsDefaultMaxTurns ?? Number.POSITIVE_INFINITY;
  const maxChildSteps = Math.min(ctx.maxToolRounds, isExplore ? 60 : 120, turnCap);
  const childBaseTools = createTools(childBash, provider, childMode, {
    modelId: childModelId,
    providerId: ctx.providerId ?? undefined,
  });
  const initialDetail = isExplore
    ? "Scanning the codebase"
    : isVerifyDetect
      ? "Detecting verification recipe"
      : isVerifyManifest
        ? "Creating verification manifest"
        : isVerify
          ? "Preparing verification pass"
          : isComputer
            ? "Preparing computer control pass"
            : "Planning delegated work";
  let assistantText = "";
  let lastActivity = initialDetail;
  let childTools: ToolSet = childBaseTools;
  let closeMcp: (() => Promise<void>) | undefined;
  const childRuntime = resolveModelRuntime(provider, childModelId);
  if (isComputer && childRuntime.modelInfo?.supportsClientTools === false) {
    return {
      success: false,
      output:
        "Computer sub-agent requires a tool-capable model, but the selected runtime does not support client tools.",
      task: {
        agent: agentKey,
        description: request.description,
        summary: "Computer sub-agent could not start because the chosen model does not support tools.",
      },
    };
  }
  const builtinBaseBody =
    builtinAgentDefinitions().find((item) => item.name.toLowerCase() === agentKey.toLowerCase())?.body ?? null;
  const legacyPrompt =
    fileDefinition && fileDefinition.promptMode === "append" && !builtinBaseBody
      ? buildSubagentPrompt(
          request,
          childBash.getCwd(),
          null,
          childBash.getSandboxMode(),
          subagents,
          childBash.getSandboxSettings(),
        )
      : null;
  const childSystem = applyModelConstraints(
    fileDefinition
      ? buildFileAgentPrompt(
          request,
          childBash.getCwd(),
          fileDefinition,
          childMode,
          childBash.getSandboxMode(),
          subagents,
          childBash.getSandboxSettings(),
          builtinBaseBody,
          legacyPrompt,
        )
      : buildSubagentPrompt(
          request,
          childBash.getCwd(),
          custom ?? null,
          childBash.getSandboxMode(),
          subagents,
          childBash.getSandboxSettings(),
        ),
    childRuntime.modelId,
  );

  onActivity?.(initialDetail);

  try {
    if (childMode === "agent" && childRuntime.modelInfo?.supportsClientTools !== false) {
      const mcpBundle = await buildMcpToolSet(loadMcpServers());
      closeMcp = mcpBundle.close;
      childTools = { ...childBaseTools, ...mcpBundle.tools };
      if (mcpBundle.errors.length > 0) {
        lastActivity = `MCP unavailable: ${mcpBundle.errors.join(" | ")}`;
        onActivity?.(lastActivity);
      }
    }

    if (fileDefinition?.tools) {
      const allowedTools = new Set(fileDefinition.tools);
      childTools = Object.fromEntries(Object.entries(childTools).filter(([toolName]) => allowedTools.has(toolName)));
    }

    const childPrompt =
      isVerify && verifyPreparedRecipe
        ? `${request.prompt}\n\nPrepared verify recipe JSON (use this as the primary execution recipe and keep .crow/environment.json aligned with it if present):\n${JSON.stringify(verifyPreparedRecipe, null, 2)}`
        : request.prompt;

    const baseMessages = isVision
      ? await buildVisionUserMessages(request.prompt, childBash.getCwd(), signal)
      : [{ role: "user" as const, content: childPrompt }];
    const childMessages = [...(opts?.history ?? []), ...baseMessages];

    if (ctx.batchApi) {
      return await runTaskRequestBatch(ctx.batch, {
        request,
        childMessages,
        childSystem,
        childRuntime,
        childTools,
        maxSteps: maxChildSteps,
        initialDetail,
        onActivity,
        signal,
      });
    }

    const result = streamText({
      model: childRuntime.model,
      system: childSystem,
      messages: childMessages,
      tools: childRuntime.modelInfo?.supportsClientTools === false ? {} : childTools,
      stopWhen: stepCountIs(maxChildSteps),
      maxRetries: 0,
      abortSignal: signal,
      temperature: isExplore ? 0.2 : 0.5,
      ...(childRuntime.modelInfo?.supportsMaxOutputTokens === false
        ? {}
        : { maxOutputTokens: Math.min(ctx.maxTokens, 8_192) }),
      ...(childRuntime.providerOptions ? { providerOptions: childRuntime.providerOptions } : {}),
      onFinish: ({ totalUsage }) => {
        ctx.recordUsage(totalUsage, "task", childRuntime.modelId);
      },
    });

    for await (const part of result.fullStream) {
      if (signal?.aborted) {
        break;
      }

      if (part.type === "text-delta") {
        assistantText += part.text;
        continue;
      }

      if (part.type === "tool-call") {
        lastActivity = formatSubagentActivity(part.toolName, part.input);
        onActivity?.(lastActivity);
      }
    }

    if (signal?.aborted) {
      return { success: false, output: "[Cancelled]" };
    }

    await result.response;

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
  } catch (err: unknown) {
    if (signal?.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const output = `Task failed: ${msg}`;
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
  } finally {
    await closeMcp?.().catch(() => {});
  }
}

export async function runSubagentSession(
  ctx: SubagentContext,
  request: SubagentRequest,
  onActivity?: (detail: string) => void,
  abortSignal?: AbortSignal,
): Promise<ToolResult> {
  let runCtx = ctx;
  let modelOverride: string | undefined;
  const rawModel = request.model?.trim();
  if (rawModel) {
    const slash = rawModel.indexOf("/");
    if (slash > 0) {
      const providerId = rawModel.slice(0, slash);
      const modelId = rawModel.slice(slash + 1);
      const providerDef = findProvider(providerId, loadCustomProviders());
      if (!providerDef) {
        return {
          success: false,
          output: `Unknown provider "${providerId}". Use "providerID/modelID" with a configured provider.`,
        };
      }
      const apiKey = getProviderApiKey(providerId);
      if (!apiKey) {
        return {
          success: false,
          output: `No API key for provider "${providerId}". Set it with /connect.`,
        };
      }
      runCtx = { ...ctx, provider: createProvider(apiKey, providerDef.baseUrl), providerId, modelId };
      modelOverride = modelId;
    } else {
      modelOverride = rawModel;
    }
  }

  const store = ctx.sessionStore ?? null;
  let childId: string | null = null;
  let history: ModelMessage[] = [];
  if (store && request.sessionID) {
    const existing = store.getSessionById(request.sessionID);
    if (!existing) {
      return { success: false, output: `Unknown subagent session "${request.sessionID}".` };
    }
    if (existing.parentId !== null && ctx.sessionId !== undefined && existing.parentId !== ctx.sessionId) {
      return { success: false, output: `Subagent session "${request.sessionID}" belongs to another conversation.` };
    }
    childId = existing.id;
    history = loadTranscript(existing.id);
  }

  const result = await runTaskRequest(
    runCtx,
    { agent: request.agent, description: request.description, prompt: request.prompt },
    onActivity,
    abortSignal,
    { modelOverride, history },
  );
  if (!result.success) {
    return result;
  }

  if (store) {
    try {
      if (!childId) {
        const child = store.createSession(runCtx.modelId, "agent", ctx.bash.getCwd(), ctx.sessionId ?? null);
        store.setTitle(child.id, request.description);
        childId = child.id;
      }
      appendMessages(childId, [
        { role: "user", content: request.prompt },
        { role: "assistant", content: result.output || "" },
      ]);
      store.touchSession(childId, ctx.bash.getCwd());
    } catch {
      childId = null;
    }
  }

  if (!childId) {
    return result;
  }
  return {
    ...result,
    output: `${result.output}\n\n[subagent session: ${childId} — pass sessionID to continue this subagent.]`,
    task: result.task ? { ...result.task, sessionId: childId } : undefined,
  };
}

export function formatSubagentActivity(toolName: string, args?: unknown): string {
  const parsed = parseToolArgs(args);
  if (toolName === "read_file") return `Read ${parsed.path || "file"}`;
  if (toolName === "lsp") return `LSP ${parsed.operation || "query"} ${parsed.filePath || ""}`.trim();
  if (toolName === "write_file") return `Write ${parsed.path || "file"}`;
  if (toolName === "edit_file") return `Edit ${parsed.path || "file"}`;
  if (toolName === "search_web") return `Web search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "search_x") return `X search "${truncate(parsed.query || "", 50)}"`;
  if (toolName === "generate_image") return `Generate image "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "generate_video") return `Generate video "${truncate(parsed.prompt || "", 50)}"`;
  if (toolName === "computer_snapshot") return `Snapshot ${parsed.app || "desktop"}`;
  if (toolName === "computer_screenshot") return "Capture desktop screenshot";
  if (toolName === "computer_click")
    return parsed.ref ? `Click ${parsed.ref}` : `Click at ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_mouse_move")
    return parsed.ref ? `Hover ${parsed.ref}` : `Move mouse to ${parsed.x || "?"},${parsed.y || "?"}`;
  if (toolName === "computer_type") return `Type into ${parsed.ref || "element"}`;
  if (toolName === "computer_press") return `Press ${parsed.key || "key"}`;
  if (toolName === "computer_scroll") return `Scroll ${parsed.ref || "element"} ${parsed.direction || "down"}`;
  if (toolName === "computer_launch") return `Launch ${parsed.app || "app"}`;
  if (toolName === "computer_list_windows") return `List windows${parsed.app ? ` for ${parsed.app}` : ""}`;
  if (toolName === "computer_focus_window")
    return `Focus window ${parsed.window_id || parsed.title || parsed.app || ""}`.trim();
  if (toolName === "computer_wait") return "Wait for desktop state";
  if (toolName === "computer_get") return `Read ${parsed.property || "text"} from ${parsed.ref || "element"}`;
  if (toolName === "bash") return truncate(parsed.command || "Run command", 70);
  return truncate(`${toolName}`, 70);
}

export function parseToolArgs(args: unknown): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    result[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return result;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
