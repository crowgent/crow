import { createOpenAI } from "@ai-sdk/openai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { generateText } from "ai";
import { getModelInfo, normalizeModelId, type ProviderModelInfo } from "./models";

export type CrowProvider = ReturnType<typeof createOpenAI>;
export type CrowRuntimeModel = ReturnType<CrowProvider["chat"]>;

interface GeneratedTextResult {
  modelId: string;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface GeneratedTitle extends GeneratedTextResult {
  title: string;
}

export interface GeneratedRecap extends GeneratedTextResult {
  recap: string;
}

export interface ResolvedModelRuntime {
  model: CrowRuntimeModel;
  modelId: string;
  modelInfo?: ProviderModelInfo;
  providerOptions?: SharedV3ProviderOptions;
}

export function createProvider(apiKey: string, baseURL?: string, fetchOverride?: typeof fetch): CrowProvider {
  return createOpenAI({
    apiKey,
    baseURL: baseURL || undefined,
    ...(fetchOverride ? { fetch: fetchOverride } : {}),
  });
}

export interface ReasoningCapture {
  fetch: typeof fetch;
  settled: () => Promise<void>;
}

export function createReasoningCapture(onReasoning: (text: string) => void): ReasoningCapture {
  let pending: Promise<void> = Promise.resolve();
  const fetchWithCapture: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;
    const [sdkBranch, parseBranch] = response.body.tee();
    pending = consumeReasoningStream(parseBranch, onReasoning).then(
      () => undefined,
      () => undefined,
    );
    return new Response(sdkBranch, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch: fetchWithCapture,
    settled: () => Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 2000))]),
  };
}

async function consumeReasoningStream(
  stream: ReadableStream<Uint8Array>,
  onReasoning: (text: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let parsed: {
            choices?: Array<{ delta?: { reasoning_content?: unknown; reasoning?: unknown } }>;
          } | null = null;
          try {
            parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { reasoning_content?: unknown; reasoning?: unknown } }>;
            };
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
          const delta = parsed.choices?.[0]?.delta;
          const text = delta?.reasoning_content ?? delta?.reasoning;
          if (typeof text === "string" && text) onReasoning(text);
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function resolveModelRuntime(provider: CrowProvider, requestedModelId: string): ResolvedModelRuntime {
  const modelId = normalizeModelId(requestedModelId);
  const modelInfo = getModelInfo(modelId);
  return {
    model: provider.chat(modelId),
    modelId,
    modelInfo,
    providerOptions: undefined,
  };
}

export async function generateTitle(
  provider: CrowProvider,
  userMessage: string,
  modelId?: string,
): Promise<GeneratedTitle> {
  const runtime = resolveModelRuntime(provider, modelId || "gpt-5");
  try {
    const { text, usage } = await generateText({
      model: runtime.model,
      temperature: 0.5,
      maxOutputTokens: 60,
      system: [
        "You are a title generator. Output ONLY a short title. Nothing else.",
        "Rules:",
        "- Single line, ≤50 characters",
        "- Use the same language as the user message",
        "- Focus on the main topic or intent",
        "- Keep technical terms, filenames, numbers exact",
        "- Remove filler words (the, this, my, a, an)",
        "- Never use tools or explain anything",
        "- If the message is a greeting, output something like 'Quick chat'",
      ].join("\n"),
      prompt: userMessage,
    });
    return {
      title: text?.trim().replace(/^["']|["']$/g, "") || "New session",
      modelId: runtime.modelId,
      usage,
    };
  } catch {
    return { title: "New session", modelId: runtime.modelId };
  }
}

export async function generateRecap(
  provider: CrowProvider,
  transcript: string,
  signal?: AbortSignal,
  modelId?: string,
): Promise<GeneratedRecap> {
  const runtime = resolveModelRuntime(provider, modelId || "gpt-5");
  try {
    const { text, usage } = await generateText({
      model: runtime.model,
      abortSignal: signal,
      temperature: 0.3,
      maxOutputTokens: 120,
      system: [
        "You write terse coding-session recaps.",
        "Output ONLY the recap text. No bullets, headings, labels, or preamble.",
        "Rules:",
        "- Maximum 3 sentences total",
        "- Focus on what changed, what remains, and the most useful next step",
        "- Preserve exact file paths, function names, errors, and technical terms when present",
        "- Avoid filler, hedging, and repetition",
        "- Never mention being an AI, assistant, or summarizer",
      ].join("\n"),
      prompt: transcript,
    });
    return {
      recap: normalizeRecap(text),
      modelId: runtime.modelId,
      usage,
    };
  } catch {
    return { recap: "", modelId: runtime.modelId };
  }
}

function normalizeRecap(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ");
}
