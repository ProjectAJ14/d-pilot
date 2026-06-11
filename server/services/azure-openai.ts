// Shared Azure OpenAI client helper.
//
// Azure deployments vary in which chat-completion parameters they accept:
//   - Newer reasoning models (gpt-5.x, o-series) require `max_completion_tokens`
//     and reject `max_tokens`; older models are the opposite.
//   - Some reasoning models reject a non-default `temperature`.
//   - Not every deployment supports `response_format: { type: "json_object" }`.
// To stay portable across whatever deployment is configured, we send the modern
// parameters first and transparently retry, stripping/swapping the offending
// parameter when the API tells us it is unsupported.

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export interface AzureConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  model?: string;
  apiVersion: string;
}

// Build an undici dispatcher for the Azure fetch so we can support corporate
// networks: an explicit HTTP(S) proxy and/or TLS-inspecting firewalls whose
// re-signed certificates Node doesn't trust (UNABLE_TO_GET_ISSUER_CERT_LOCALLY).
// Mirrors the existing relaxed-TLS handling for Elasticsearch/MSSQL connections.
let cachedDispatcher: Dispatcher | null | undefined;
function getAzureDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher !== undefined) return cachedDispatcher ?? undefined;

  const insecure = /^(1|true|yes|on)$/i.test(process.env.AZURE_OPENAI_INSECURE_TLS || "");
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

  if (proxy) {
    cachedDispatcher = new ProxyAgent({
      uri: proxy,
      requestTls: insecure ? { rejectUnauthorized: false } : undefined,
    });
  } else if (insecure) {
    cachedDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  } else {
    cachedDispatcher = null;
  }
  return cachedDispatcher ?? undefined;
}

export interface AzureChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AzureChatOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export interface AzureChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface AzureChatResult {
  content: string;
  model?: string;
  usage?: AzureChatUsage;
}

/** Reads Azure OpenAI config from env, reporting any missing required vars. */
export function getAzureConfig(): { config: AzureConfig | null; missing: string[] } {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiKey = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  const missing: string[] = [];
  if (!endpoint) missing.push("AZURE_OPENAI_ENDPOINT");
  if (!apiKey) missing.push("AZURE_OPENAI_KEY");
  if (!deployment) missing.push("AZURE_OPENAI_DEPLOYMENT");

  if (missing.length > 0) return { config: null, missing };

  return {
    config: {
      endpoint: endpoint!,
      apiKey: apiKey!,
      deployment: deployment!,
      model: process.env.AZURE_OPENAI_MODEL,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview",
    },
    missing: [],
  };
}

export class AzureOpenAIError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "AzureOpenAIError";
    this.status = status;
  }
}

async function parseErrorMessage(response: { json(): Promise<any>; statusText: string }): Promise<string> {
  try {
    const body = (await response.json()) as any;
    return body?.error?.message || body?.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Sends a chat completion request to the configured Azure OpenAI deployment.
 * Throws AzureOpenAIError on failure.
 */
export async function azureChat(
  config: AzureConfig,
  messages: AzureChatMessage[],
  options: AzureChatOptions = {}
): Promise<AzureChatResult> {
  const url = `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deployment}/chat/completions?api-version=${config.apiVersion}`;

  // Build the initial request body with the modern parameter set.
  const body: Record<string, unknown> = {
    messages,
    max_completion_tokens: options.maxTokens ?? 2048,
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.jsonMode) body.response_format = { type: "json_object" };

  // Each entry: a test against the API's error message + how to mutate the body.
  // Returns true if it mutated the body (so we should retry).
  const adaptations: Array<(detail: string) => boolean> = [
    (detail) => {
      if (/max_tokens/i.test(detail) && /max_completion_tokens/i.test(detail) && "max_completion_tokens" in body) {
        body.max_tokens = body.max_completion_tokens;
        delete body.max_completion_tokens;
        return true;
      }
      return false;
    },
    (detail) => {
      if (/temperature/i.test(detail) && "temperature" in body) {
        delete body.temperature;
        return true;
      }
      return false;
    },
    (detail) => {
      if (/response_format/i.test(detail) && "response_format" in body) {
        delete body.response_format;
        return true;
      }
      return false;
    },
  ];

  const maxAttempts = adaptations.length + 1;
  let lastDetail = "";
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);

    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      const dispatcher = getAzureDispatcher();
      // Use undici's own fetch so a userland-created dispatcher (Agent/ProxyAgent)
      // is actually honored — Node's global fetch ignores dispatchers from the
      // separately-installed undici package.
      response = await undiciFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": config.apiKey },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher,
      });
    } catch (err: any) {
      clearTimeout(timeout);
      if (err?.name === "AbortError") {
        throw new AzureOpenAIError("Azure OpenAI request timed out");
      }
      // Node's fetch collapses network errors to "fetch failed"; the real reason
      // (e.g. a TLS/cert or DNS code) lives on err.cause — surface it.
      const cause = err?.cause?.code || err?.cause?.message;
      const detail = cause && cause !== err?.message ? `: ${cause}` : "";
      throw new AzureOpenAIError(`Failed to reach Azure OpenAI endpoint${detail}`);
    }
    clearTimeout(timeout);

    if (response.ok) {
      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content ?? "";
      const u = data?.usage;
      return {
        content,
        model: data?.model || config.model,
        usage: u
          ? {
              promptTokens: u.prompt_tokens,
              completionTokens: u.completion_tokens,
              totalTokens: u.total_tokens,
            }
          : undefined,
      };
    }

    lastStatus = response.status;
    lastDetail = await parseErrorMessage(response);

    // Try to adapt the body to a parameter incompatibility and retry.
    const adapted = adaptations.some((fn) => fn(lastDetail));
    if (!adapted) break;
  }

  throw new AzureOpenAIError(
    `Azure OpenAI returned ${lastStatus ?? "error"}: ${lastDetail}`,
    lastStatus
  );
}
