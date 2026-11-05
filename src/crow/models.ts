import type { ModelInfo, ReasoningEffort } from "../types/index";
import { BUILTIN_PROVIDERS, type ProviderModel } from "../utils/providers";

export interface ProviderModelInfo extends ModelInfo {
  provider: string;
}

function toModelInfo(providerId: string, model: ProviderModel): ProviderModelInfo {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow ?? 128000,
    inputPrice: 0,
    outputPrice: 0,
    reasoning: model.reasoning ?? false,
    supportsReasoningEffort: model.reasoning ?? false,
    description: model.description ?? "",
    provider: providerId,
  };
}

export const MODELS: ProviderModelInfo[] = BUILTIN_PROVIDERS.flatMap((provider) =>
  provider.models.map((model) => toModelInfo(provider.id, model)),
);

export const DEFAULT_MODEL = MODELS[0]?.id ?? "";

export function normalizeModelId(modelId: string): string {
  return modelId.trim();
}

export function getModelInfo(modelId: string): ProviderModelInfo | undefined {
  const normalized = normalizeModelId(modelId);
  return MODELS.find((m) => m.id === normalized);
}

export function getModelIds(): string[] {
  return MODELS.map((m) => m.id);
}

export function isKnownModelId(modelId: string): boolean {
  return !!getModelInfo(modelId);
}

export function getModelsForProvider(providerId: string): ProviderModelInfo[] {
  return MODELS.filter((model) => model.provider === providerId);
}

const BASE_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high"];
const EXTENDED_REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export function getSupportedReasoningEfforts(modelId: string): ReasoningEffort[] {
  const info = getModelInfo(modelId);
  if (!info?.supportsReasoningEffort) return [];
  return info.provider === "openai" || info.provider === "anthropic"
    ? EXTENDED_REASONING_EFFORTS
    : BASE_REASONING_EFFORTS;
}

export function getEffectiveReasoningEffort(modelId: string, override?: ReasoningEffort): ReasoningEffort | undefined {
  const supported = getSupportedReasoningEfforts(modelId);
  const candidate = override ?? getModelInfo(modelId)?.defaultReasoningEffort;
  if (!candidate || !supported.includes(candidate)) return undefined;
  return candidate;
}
