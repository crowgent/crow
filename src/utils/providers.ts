export interface ProviderModel {
  id: string;
  name: string;
  contextWindow?: number;
  reasoning?: boolean;
  description?: string;
}

export interface ProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  models: ProviderModel[];
}

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  modelNames?: Record<string, string>;
}

export interface ProviderApiKeyEnv {
  providerId: string;
  envVars: string[];
}

export const PROVIDER_API_KEY_ENVS: ProviderApiKeyEnv[] = [
  { providerId: "openai", envVars: ["OPENAI_API_KEY"] },
  { providerId: "deepseek", envVars: ["DEEPSEEK_API_KEY"] },
  { providerId: "qwen", envVars: ["DASHSCOPE_API_KEY", "QWEN_API_KEY"] },
  { providerId: "moonshot", envVars: ["MOONSHOT_API_KEY"] },
  { providerId: "zhipu", envVars: ["ZHIPU_API_KEY"] },
  { providerId: "groq", envVars: ["GROQ_API_KEY"] },
  { providerId: "together", envVars: ["TOGETHER_API_KEY"] },
  { providerId: "openrouter", envVars: ["OPENROUTER_API_KEY"] },
  { providerId: "mistral", envVars: ["MISTRAL_API_KEY"] },
  { providerId: "gemini", envVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"] },
  { providerId: "minimax", envVars: ["MINIMAX_API_KEY"] },
  { providerId: "stepfun", envVars: ["STEPFUN_API_KEY"] },
  { providerId: "cerebras", envVars: ["CEREBRAS_API_KEY"] },
  { providerId: "fireworks", envVars: ["FIREWORKS_API_KEY"] },
  { providerId: "deepinfra", envVars: ["DEEPINFRA_API_KEY"] },
  { providerId: "nebius", envVars: ["NEBIUS_API_KEY"] },
  { providerId: "sambanova", envVars: ["SAMBANOVA_API_KEY"] },
  { providerId: "perplexity", envVars: ["PERPLEXITY_API_KEY"] },
  { providerId: "cohere", envVars: ["COHERE_API_KEY"] },
  { providerId: "venice", envVars: ["VENICE_API_KEY"] },
  { providerId: "alibaba", envVars: ["DASHSCOPE_API_KEY"] },
  { providerId: "moonshot-cn", envVars: ["MOONSHOT_API_KEY"] },
  { providerId: "zai", envVars: ["ZHIPU_API_KEY"] },
  { providerId: "minimax-cn", envVars: ["MINIMAX_API_KEY"] },
  { providerId: "stepfun-ai", envVars: ["STEPFUN_API_KEY"] },
  { providerId: "opencode", envVars: ["OPENCODE_API_KEY"] },
  { providerId: "opencode-go", envVars: ["OPENCODE_API_KEY"] },
  { providerId: "nvidia", envVars: ["NVIDIA_API_KEY"] },
  { providerId: "baseten", envVars: ["BASETEN_API_KEY"] },
  { providerId: "digitalocean", envVars: ["DIGITALOCEAN_ACCESS_TOKEN"] },
];

export const BUILTIN_PROVIDERS: ProviderDefinition[] = [
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5", name: "GPT-5", contextWindow: 400000, reasoning: true },
      { id: "gpt-5-mini", name: "GPT-5 Mini", contextWindow: 400000, reasoning: true },
      { id: "gpt-5-nano", name: "GPT-5 Nano", contextWindow: 400000, reasoning: true },
      { id: "gpt-4.1", name: "GPT-4.1", contextWindow: 1047576 },
      { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", contextWindow: 1047576 },
      { id: "gpt-4.1-nano", name: "GPT-4.1 Nano", contextWindow: 1047576 },
      { id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", contextWindow: 128000 },
      { id: "o4-mini", name: "o4-mini", contextWindow: 200000, reasoning: true },
      { id: "o3", name: "o3", contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: [
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1048576, reasoning: true },
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1048576, reasoning: true },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", contextWindow: 1048576 },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", contextWindow: 1048576 },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat", contextWindow: 128000 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "qwen",
    name: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen3-max", name: "Qwen3 Max", contextWindow: 262144, reasoning: true },
      { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus", contextWindow: 262144, reasoning: true },
      { id: "qwen3-235b-a22b", name: "Qwen3 235B", contextWindow: 262144, reasoning: true },
      { id: "qwen3-32b", name: "Qwen3 32B", contextWindow: 262144, reasoning: true },
      { id: "qwen-plus", name: "Qwen Plus", contextWindow: 131072 },
      { id: "qwen-turbo", name: "Qwen Turbo", contextWindow: 131072 },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot",
    baseUrl: "https://api.moonshot.ai/v1",
    models: [
      { id: "kimi-k2", name: "Kimi K2", contextWindow: 200000, reasoning: true },
      { id: "moonshot-v1-128k", name: "Moonshot v1 128K", contextWindow: 131072 },
      { id: "moonshot-v1-32k", name: "Moonshot v1 32K", contextWindow: 32768 },
      { id: "moonshot-v1-8k", name: "Moonshot v1 8K", contextWindow: 8192 },
    ],
  },
  {
    id: "zhipu",
    name: "Zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: [
      { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200000, reasoning: true },
      { id: "glm-4.5", name: "GLM-4.5", contextWindow: 131072, reasoning: true },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 131072, reasoning: true },
      { id: "glm-4-plus", name: "GLM-4 Plus", contextWindow: 131072 },
    ],
  },
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [
      { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 131072, reasoning: true },
      { id: "openai/gpt-oss-20b", name: "GPT OSS 20B", contextWindow: 131072, reasoning: true },
      { id: "llama-3.3-70b-versatile", name: "Llama 3.3 70B Versatile", contextWindow: 131072 },
      { id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", contextWindow: 131072 },
      { id: "qwen-qwq-32b", name: "Qwen QwQ 32B", contextWindow: 131072, reasoning: true },
      {
        id: "deepseek-r1-distill-llama-70b",
        name: "DeepSeek R1 Distill Llama 70B",
        contextWindow: 131072,
        reasoning: true,
      },
    ],
  },
  {
    id: "together",
    name: "Together",
    baseUrl: "https://api.together.xyz/v1",
    models: [
      { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", name: "Llama 3.3 70B Instruct Turbo", contextWindow: 131072 },
      {
        id: "Qwen/Qwen3-235B-A22B-Instruct-2507-tput",
        name: "Qwen3 235B Instruct",
        contextWindow: 262144,
        reasoning: true,
      },
      { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1", contextWindow: 163840, reasoning: true },
      { id: "moonshotai/Kimi-K2-Instruct", name: "Kimi K2 Instruct", contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "openai/gpt-5", name: "OpenAI GPT-5", contextWindow: 400000, reasoning: true },
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Anthropic Claude Sonnet 4.5",
        contextWindow: 200000,
        reasoning: true,
      },
      { id: "google/gemini-2.5-pro", name: "Google Gemini 2.5 Pro", contextWindow: 1048576, reasoning: true },
      { id: "deepseek/deepseek-chat-v3.1", name: "DeepSeek Chat v3.1", contextWindow: 163840 },
      { id: "qwen/qwen3-coder", name: "Qwen3 Coder", contextWindow: 262144, reasoning: true },
      { id: "moonshotai/kimi-k2", name: "Moonshot Kimi K2", contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: "mistral",
    name: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    models: [
      { id: "mistral-large-latest", name: "Mistral Large", contextWindow: 131072, reasoning: true },
      { id: "mistral-medium-latest", name: "Mistral Medium", contextWindow: 131072 },
      { id: "mistral-small-latest", name: "Mistral Small", contextWindow: 131072 },
      { id: "codestral-latest", name: "Codestral", contextWindow: 262144 },
      { id: "devstral-medium-latest", name: "Devstral Medium", contextWindow: 131072, reasoning: true },
    ],
  },
  {
    id: "minimax",
    name: "MiniMax",
    baseUrl: "https://api.minimax.chat/v1",
    models: [
      { id: "MiniMax-M2.1", name: "MiniMax M2.1", contextWindow: 200000, reasoning: true },
      { id: "MiniMax-M2", name: "MiniMax M2", contextWindow: 200000, reasoning: true },
      { id: "MiniMax-Text-01", name: "MiniMax Text 01", contextWindow: 1000000 },
    ],
  },
  {
    id: "stepfun",
    name: "StepFun",
    baseUrl: "https://api.stepfun.com/v1",
    models: [
      { id: "step-3.5-flash", name: "Step 3.5 Flash", contextWindow: 256000, reasoning: true },
      { id: "step-3.5-turbo", name: "Step 3.5 Turbo", contextWindow: 256000 },
    ],
  },
  {
    id: "cerebras",
    name: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    models: [
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 128000 },
      { id: "llama-4-scout-17b-16e-instruct", name: "Llama 4 Scout 17B", contextWindow: 131072 },
      { id: "llama-4-maverick-17b-128e-instruct", name: "Llama 4 Maverick 17B", contextWindow: 131072 },
      { id: "qwen-3-235b-a22b-instruct-2507", name: "Qwen3 235B Instruct", contextWindow: 131072, reasoning: true },
      { id: "gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 131072, reasoning: true },
    ],
  },
  {
    id: "fireworks",
    name: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    models: [
      {
        id: "accounts/fireworks/models/llama-v3p1-405b-instruct",
        name: "Llama 3.1 405B Instruct",
        contextWindow: 128000,
      },
      {
        id: "accounts/fireworks/models/llama-v3p3-70b-instruct",
        name: "Llama 3.3 70B Instruct",
        contextWindow: 128000,
      },
      {
        id: "accounts/fireworks/models/qwen3-235b-a22b-instruct-2507",
        name: "Qwen3 235B Instruct",
        contextWindow: 262144,
        reasoning: true,
      },
      { id: "accounts/fireworks/models/deepseek-v3p1", name: "DeepSeek V3.1", contextWindow: 128000, reasoning: true },
      { id: "accounts/fireworks/models/gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    models: [
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct", name: "Llama 3.1 70B Instruct", contextWindow: 128000 },
      { id: "meta-llama/Meta-Llama-3.3-70B-Instruct", name: "Llama 3.3 70B Instruct", contextWindow: 128000 },
      { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1", contextWindow: 128000, reasoning: true },
      { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B Instruct", contextWindow: 262144, reasoning: true },
      { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "nebius",
    name: "Nebius",
    baseUrl: "https://api.studio.nebius.com/v1",
    models: [
      { id: "meta-llama/Meta-Llama-3.1-70B-Instruct", name: "Llama 3.1 70B Instruct", contextWindow: 128000 },
      { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B Instruct", contextWindow: 262144, reasoning: true },
      { id: "deepseek-ai/DeepSeek-V3.1", name: "DeepSeek V3.1", contextWindow: 128000, reasoning: true },
      { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 128000, reasoning: true },
      { id: "moonshotai/Kimi-K2-Instruct", name: "Kimi K2 Instruct", contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: "sambanova",
    name: "SambaNova",
    baseUrl: "https://api.sambanova.ai/v1",
    models: [
      { id: "Meta-Llama-3.3-70B-Instruct", name: "Llama 3.3 70B Instruct", contextWindow: 128000 },
      { id: "DeepSeek-V3.1", name: "DeepSeek V3.1", contextWindow: 128000, reasoning: true },
      { id: "Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B Instruct", contextWindow: 262144, reasoning: true },
      { id: "Llama-4-Maverick-17B-128E-Instruct", name: "Llama 4 Maverick 17B", contextWindow: 131072 },
    ],
  },
  {
    id: "perplexity",
    name: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    models: [
      { id: "sonar", name: "Sonar", contextWindow: 128000 },
      { id: "sonar-pro", name: "Sonar Pro", contextWindow: 200000 },
      { id: "sonar-reasoning", name: "Sonar Reasoning", contextWindow: 128000, reasoning: true },
      { id: "sonar-deep-research", name: "Sonar Deep Research", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "cohere",
    name: "Cohere",
    baseUrl: "https://api.cohere.com/compatibility/v1",
    models: [
      { id: "command-a-03-2025", name: "Command A", contextWindow: 256000 },
      { id: "command-r-plus-08-2024", name: "Command R+", contextWindow: 128000 },
      { id: "command-r-08-2024", name: "Command R", contextWindow: 128000 },
    ],
  },
  {
    id: "venice",
    name: "Venice",
    baseUrl: "https://api.venice.ai/api/v1",
    models: [
      { id: "venice-uncensored", name: "Venice Uncensored", contextWindow: 128000 },
      { id: "llama-3.3-70b", name: "Llama 3.3 70B", contextWindow: 128000 },
      { id: "qwen-3-235b", name: "Qwen3 235B", contextWindow: 262144, reasoning: true },
      { id: "deepseek-r1-671b", name: "DeepSeek R1 671B", contextWindow: 128000, reasoning: true },
      { id: "dolphin-mistral-24b-venice-edition", name: "Dolphin Mistral 24B Venice Edition", contextWindow: 128000 },
    ],
  },
  {
    id: "alibaba",
    name: "Alibaba",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    models: [
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 262144, reasoning: true },
      { id: "qwen3.5-397b-a17b", name: "Qwen3.5 397B", contextWindow: 262144, reasoning: true },
      { id: "qwen3.8-27b", name: "Qwen3.8 27B", contextWindow: 262144, reasoning: true },
      { id: "qwen3.7-plus", name: "Qwen3.7 Plus", contextWindow: 262144, reasoning: true },
      { id: "qwen-mt-plus", name: "Qwen MT Plus", contextWindow: 262144 },
      { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "moonshot-cn",
    name: "Moonshot China",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro", contextWindow: 200000, reasoning: true },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", contextWindow: 200000, reasoning: true },
      { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code Highspeed", contextWindow: 200000, reasoning: true },
      { id: "kimi-k3", name: "Kimi K3", contextWindow: 200000, reasoning: true },
      { id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 200000, reasoning: true },
      { id: "kimi-k3.1-pro-highspeed", name: "Kimi K3.1 Pro Highspeed", contextWindow: 200000, reasoning: true },
    ],
  },
  {
    id: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/paas/v4",
    models: [
      { id: "glm-4.6", name: "GLM-4.6", contextWindow: 200000, reasoning: true },
      { id: "glm-4.5", name: "GLM-4.5", contextWindow: 128000, reasoning: true },
      { id: "glm-4.5-air", name: "GLM-4.5 Air", contextWindow: 128000, reasoning: true },
      { id: "glm-4-plus", name: "GLM-4 Plus", contextWindow: 128000 },
    ],
  },
  {
    id: "minimax-cn",
    name: "MiniMax China",
    baseUrl: "https://api.minimax.cn/v1",
    models: [
      { id: "MiniMax-M3.1-Flash", name: "MiniMax M3.1 Flash", contextWindow: 262144, reasoning: true },
      { id: "MiniMax-M3", name: "MiniMax M3", contextWindow: 262144, reasoning: true },
    ],
  },
  {
    id: "stepfun-ai",
    name: "StepFun Global",
    baseUrl: "https://api.stepfun.ai/v1",
    models: [
      { id: "step-3.5-flash", name: "Step 3.5 Flash", contextWindow: 256000, reasoning: true },
      { id: "step-3.7-flash", name: "Step 3.7 Flash", contextWindow: 256000, reasoning: true },
      { id: "step-5-preview", name: "Step 5 Preview", contextWindow: 256000, reasoning: true },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    baseUrl: "https://opencode.ai/inference/openai/v1",
    models: [
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000, reasoning: true },
      { id: "gpt-5.5", name: "GPT-5.5", contextWindow: 400000, reasoning: true },
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 262144, reasoning: true },
      { id: "kimi-k2.5", name: "Kimi K2.5", contextWindow: 200000, reasoning: true },
      { id: "gpt-5.1", name: "GPT-5.1", contextWindow: 400000, reasoning: true },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", contextWindow: 400000, reasoning: true },
    ],
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
    models: [
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000, reasoning: true },
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 262144, reasoning: true },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextWindow: 200000 },
      { id: "gpt-6-luna", name: "GPT-6 Luna", contextWindow: 400000, reasoning: true },
      { id: "minimax-m3.1-flash", name: "MiniMax M3.1 Flash", contextWindow: 262144, reasoning: true },
    ],
  },
  {
    id: "nvidia",
    name: "Nvidia",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: [
      { id: "openai/gpt-oss-20b", name: "GPT OSS 20B", contextWindow: 128000, reasoning: true },
      { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000, reasoning: true },
      { id: "meta/llama-3.2-90b-vision-instruct", name: "Llama 3.2 90B Vision Instruct", contextWindow: 128000 },
      { id: "meta/llama-3.2-11b-vision-instruct", name: "Llama 3.2 11B Vision Instruct", contextWindow: 128000 },
      { id: "meta/muse-glimmer-30b", name: "Muse Glimmer 30B", contextWindow: 128000, reasoning: true },
    ],
  },
  {
    id: "baseten",
    name: "Baseten",
    baseUrl: "https://inference.baseten.co/v1",
    models: [
      { id: "openai/gpt-oss-120b", name: "GPT OSS 120B", contextWindow: 128000, reasoning: true },
      { id: "moonshotai/Kimi-K3", name: "Kimi K3", contextWindow: 200000, reasoning: true },
      { id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash", contextWindow: 128000, reasoning: true },
      { id: "deepseek-ai/DeepSeek-V4-Pro-0813", name: "DeepSeek V4 Pro", contextWindow: 128000, reasoning: true },
      {
        id: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
        name: "Nemotron 3 Ultra 550B",
        contextWindow: 128000,
        reasoning: true,
      },
    ],
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    baseUrl: "https://inference.do-ai.run/v1",
    models: [
      { id: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro", contextWindow: 128000, reasoning: true },
      { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000, reasoning: true },
      { id: "qwen3.8-max", name: "Qwen3.8 Max", contextWindow: 262144, reasoning: true },
      { id: "openai-gpt-5.6-sol", name: "GPT-5.6 Sol", contextWindow: 400000, reasoning: true },
    ],
  },
];

export function customProviderToDefinition(custom: CustomProvider): ProviderDefinition {
  return {
    id: custom.id,
    name: custom.name,
    baseUrl: custom.baseUrl,
    models: custom.models.map((id) => ({ id, name: custom.modelNames?.[id] ?? id })),
  };
}

export function getAllProviders(customProviders: CustomProvider[]): ProviderDefinition[] {
  const seen = new Set(BUILTIN_PROVIDERS.map((provider) => provider.id));
  const customs = customProviders.filter((custom) => custom.id && !seen.has(custom.id)).map(customProviderToDefinition);
  return [...BUILTIN_PROVIDERS, ...customs];
}

export function findProvider(providerId: string, customProviders: CustomProvider[]): ProviderDefinition | undefined {
  return getAllProviders(customProviders).find((provider) => provider.id === providerId);
}

export function getProviderModelIds(provider: ProviderDefinition): string[] {
  return provider.models.map((model) => model.id);
}

export function getAllModelIds(customProviders: CustomProvider[]): string[] {
  const ids: string[] = [];
  for (const provider of getAllProviders(customProviders)) {
    for (const model of provider.models) {
      if (!ids.includes(model.id)) ids.push(model.id);
    }
  }
  return ids;
}

export function getProviderModelInfo(
  providerId: string,
  modelId: string,
  customProviders: CustomProvider[],
): ProviderModel | undefined {
  const provider = findProvider(providerId, customProviders);
  return provider?.models.find((model) => model.id === modelId);
}

export function getProviderApiKeyFromEnv(providerId: string): string | undefined {
  const entry = PROVIDER_API_KEY_ENVS.find((item) => item.providerId === providerId);
  if (!entry) return undefined;
  for (const envVar of entry.envVars) {
    const value = process.env[envVar]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function createCustomProviderId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `custom-${slug || "provider"}`;
}

export function parseModelsResponse(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .map((id) => id.trim());
  return [...new Set(ids)].sort();
}

export async function fetchProviderModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/models`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch models from ${url}: ${response.status} ${response.statusText}`);
  }
  return parseModelsResponse(await response.json());
}
