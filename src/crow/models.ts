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

export function getSupportedReasoningEfforts(_modelId: string): ReasoningEffort[] {
  return [];
}

export function getEffectiveReasoningEffort(
  _modelId: string,
  _override?: ReasoningEffort,
): ReasoningEffort | undefined {
  return undefined;
}
