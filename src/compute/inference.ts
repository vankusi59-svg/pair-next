/**
 * Inference Client (automaton-pair fork)
 *
 * Routes chat completions to any OpenAI-compatible provider.
 * Provider endpoints are resolved from:
 *   1. Built-in map (groq, gemini, agnes, openai, together, ollama)
 *   2. ~/.automaton/inference-providers.json (same file the
 *      ProviderRegistry reads — one config for both registries)
 *   3. Config-provided keys (openaiApiKey, anthropicApiKey)
 */

import fs from "node:fs";
import path from "node:path";
import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

const INFERENCE_TIMEOUT_MS = 60_000;

interface ProviderEndpoint {
  baseUrl: string;
  apiKeyEnvVar: string;
}

/**
 * Built-in provider endpoints. All are OpenAI-compatible except
 * anthropic, which has a dedicated path below.
 */
const BUILTIN_PROVIDERS: Record<string, ProviderEndpoint> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnvVar: "OPENAI_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnvVar: "GROQ_API_KEY" },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    apiKeyEnvVar: "GEMINI_API_KEY",
  },
  agnes: {
    baseUrl: process.env.AGNES_BASE_URL || "https://api.agnesai.com/v1",
    apiKeyEnvVar: "AGNES_API_KEY",
  },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnvVar: "TOGETHER_API_KEY" },
};

interface InferenceClientOptions {
  /** Legacy Conway API URL — unused in the fork, kept for config compat. */
  apiUrl?: string;
  apiKey?: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** Extra providers from inference-providers.json (id -> endpoint). */
  extraProviders?: Record<string, ProviderEndpoint>;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
}

/** Load provider endpoints declared in inference-providers.json. */
export function loadProviderEndpoints(configPath: string): Record<string, ProviderEndpoint> {
  const endpoints: Record<string, ProviderEndpoint> = {};
  try {
    if (!fs.existsSync(configPath)) return endpoints;
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const providers = Array.isArray(raw?.providers) ? raw.providers : [];
    for (const p of providers) {
      if (p && typeof p.id === "string" && typeof p.baseUrl === "string") {
        endpoints[p.id] = {
          baseUrl: p.baseUrl,
          apiKeyEnvVar: typeof p.apiKeyEnvVar === "string" ? p.apiKeyEnvVar : `${p.id.toUpperCase()}_API_KEY`,
        };
      }
    }
  } catch {
    // invalid file → ignore, built-ins still apply
  }
  return endpoints;
}

/** Default providers file path (shared with ProviderRegistry). */
export function defaultProvidersPath(): string {
  return path.join(
    process.env.HOME || process.cwd(),
    ".automaton",
    "inference-providers.json",
  );
}

/** Is the given provider usable right now (key present, or keyless local)? */
export function isProviderAvailable(
  provider: string | undefined,
  opts: { extraProviders?: Record<string, ProviderEndpoint>; ollamaBaseUrl?: string } = {},
): boolean {
  if (!provider) return false;
  if (provider === "ollama") return Boolean(opts.ollamaBaseUrl);
  if (provider === "anthropic") return Boolean(process.env.ANTHROPIC_API_KEY);
  const endpoint = { ...BUILTIN_PROVIDERS, ...(opts.extraProviders ?? {}) }[provider];
  if (!endpoint) return false;
  if (provider === "local") return true;
  return Boolean(process.env[endpoint.apiKeyEnvVar]);
}

type InferenceBackend = "openai-compatible" | "anthropic" | "ollama";

function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol.toLowerCase() === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch {
    return false;
  }
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiKey, openaiApiKey, anthropicApiKey, ollamaBaseUrl, getModelProvider } = options;
  const endpoints: Record<string, ProviderEndpoint> = {
    ...BUILTIN_PROVIDERS,
    ...(options.extraProviders ?? {}),
  };
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
    allowHttpOnLoopback: isLoopbackHttpUrl(ollamaBaseUrl),
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const resolveEndpoint = (provider: string): ProviderEndpoint | undefined => {
    const ep = endpoints[provider];
    if (!ep) return undefined;
    // config-provided OpenAI key wins over env for provider "openai"
    if (provider === "openai" && openaiApiKey) {
      return { baseUrl: ep.baseUrl, apiKeyEnvVar: "__config__" };
    }
    return ep;
  };

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const provider = resolveModelProvider(model, { getModelProvider });

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens =
      provider !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (provider === "anthropic") {
      if (!anthropicApiKey) throw new Error("Provider 'anthropic' selected but ANTHROPIC_API_KEY is not set");
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        anthropicApiKey,
        httpClient,
      });
    }

    let apiUrl: string;
    let resolvedKey: string;

    if (provider === "ollama") {
      if (!ollamaBaseUrl) throw new Error("Provider 'ollama' selected but no Ollama base URL is configured");
      apiUrl = ollamaBaseUrl.replace(/\/$/, "");
      resolvedKey = "ollama";
    } else {
      const ep = resolveEndpoint(provider);
      if (!ep) {
        throw new Error(`No endpoint configured for provider '${provider}' (model: ${model})`);
      }
      apiUrl = ep.baseUrl.replace(/\/$/, "");
      resolvedKey =
        ep.apiKeyEnvVar === "__config__"
          ? (openaiApiKey as string)
          : (process.env[ep.apiKeyEnvVar] || "");
      // Legacy compat: a config apiKey acts as a last-resort OpenAI-compatible key.
      if (!resolvedKey && apiKey) resolvedKey = apiKey;
      if (!resolvedKey) {
        throw new Error(
          `Provider '${provider}' requires env var ${ep.apiKeyEnvVar} (model: ${model})`,
        );
      }
    }

    return chatViaOpenAiCompatible({
      model,
      body,
      apiUrl,
      apiKey: resolvedKey,
      provider,
      httpClient,
    });
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which provider serves a model.
 * Registry lookup first (exact), then name heuristics.
 */
function resolveModelProvider(
  model: string,
  keys: {
    getModelProvider?: (modelId: string) => string | undefined;
  },
): string {
  const provider = keys.getModelProvider?.(model);
  if (provider) return provider;

  // Heuristic fallback (model not in registry yet)
  if (/^claude/i.test(model)) return "anthropic";
  // Groq-hosted model ids are namespaced (openai/, meta-llama/, qwen/, ...)
  // or bare family names.
  if (/^(openai|meta-llama|qwen|canopylabs|moonshotai|deepseek|mistralai|allam)\//i.test(model)) return "groq";
  if (/^(gpt-oss|llama|mixtral|deepseek|qwen|moonshot|kimi)/i.test(model)) return "groq";
  if (/^gemini/i.test(model)) return "gemini";
  if (/^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  if (model.includes(":")) return "ollama";
  return "openai";
}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  provider: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const resp = await params.httpClient.request(`${params.apiUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.provider}): ${resp.status}: ${text}`,
    );
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages:
      transformed.messages.length > 0
        ? transformed.messages
        : (() => { throw new Error("Cannot send empty message array to Anthropic API"); })(),
  };

  if (transformed.system) {
    body.system = transformed.system;
  }

  if (params.temperature !== undefined) {
    body.temperature = params.temperature;
  }

  if (params.tools && params.tools.length > 0) {
    body.tools = params.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
    body.tool_choice = { type: "auto" };
  }

  const resp = await params.httpClient.request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": params.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Inference error (anthropic): ${resp.status}: ${text}`);
  }

  const data = await resp.json() as any;
  const content = Array.isArray(data.content) ? data.content : [];
  const textBlocks = content.filter((c: any) => c?.type === "text");
  const toolUseBlocks = content.filter((c: any) => c?.type === "tool_use");

  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool: any) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const textContent = textBlocks
    .map((block: any) => String(block.text || ""))
    .join("\n")
    .trim();

  if (!textContent && !toolCalls?.length) {
    throw new Error("No completion content returned from anthropic inference");
  }

  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeAnthropicFinishReason(data.stop_reason),
  };
}

function transformMessagesForAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const transformed: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Merge consecutive user messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = last.content + "\n" + msg.content;
        continue;
      }
      transformed.push({
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      for (const toolCall of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      if (content.length === 0) {
        content.push({ type: "text", text: "" });
      }
      // Merge consecutive assistant messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(...content);
        continue;
      }
      transformed.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool messages into a single user message
      // with multiple tool_result content blocks
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown_tool_call",
        content: msg.content,
      };

      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append tool_result to existing user message with content blocks
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
        continue;
      }

      transformed.push({
        role: "user",
        content: [toolResultBlock],
      });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: transformed,
  };
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeAnthropicFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  if (reason === "tool_use") return "tool_calls";
  return reason;
}
