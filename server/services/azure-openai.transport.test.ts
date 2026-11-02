import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

const settings: Record<string, string | undefined> = {};
let insecure = false;
vi.mock("../config/settings.js", () => ({
  getConfig: (k: string) => settings[k],
  getConfigBool: () => insecure,
}));
vi.mock("undici", async (orig) => ({
  ...(await orig<object>()),
  fetch: vi.fn(),
}));
const fetchMock = vi.mocked(undiciFetch);

const { getAzureConfig, azureChat, parseGeneration, AzureOpenAIError } =
  await import("./azure-openai.js");

const CONFIG = {
  endpoint: "https://example.invalid/",
  apiKey: "k",
  deployment: "d",
  apiVersion: "v",
  model: "cfg-model",
};
const MSG = [{ role: "user" as const, content: "x" }];
const respond = (status: number, body: unknown, statusText = "Bad Request") =>
  ({
    ok: status < 400,
    status,
    statusText,
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  }) as never;
const sentBody = (i: number) =>
  JSON.parse(fetchMock.mock.calls[i][1]!.body as string);
const sentDispatcher = (i: number) => fetchMock.mock.calls[i][1]!.dispatcher;

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

beforeEach(() => {
  fetchMock.mockReset();
  for (const v of PROXY_VARS) vi.stubEnv(v, "");
});
afterEach(() => vi.unstubAllEnvs());

describe("getAzureConfig", () => {
  it("lists every missing required key", () => {
    for (const k of Object.keys(settings)) delete settings[k];
    expect(getAzureConfig()).toEqual({
      config: null,
      missing: [
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_KEY",
        "AZURE_OPENAI_DEPLOYMENT",
      ],
    });
  });

  it("defaults the API version and leaves the model unset", () => {
    Object.assign(settings, {
      AZURE_OPENAI_ENDPOINT: "https://e",
      AZURE_OPENAI_KEY: "key",
      AZURE_OPENAI_DEPLOYMENT: "dep",
      AZURE_OPENAI_MODEL: "",
      AZURE_OPENAI_API_VERSION: "",
    });
    expect(getAzureConfig()).toEqual({
      config: {
        endpoint: "https://e",
        apiKey: "key",
        deployment: "dep",
        model: undefined,
        apiVersion: "2024-08-01-preview",
      },
      missing: [],
    });
    settings.AZURE_OPENAI_MODEL = "m";
    settings.AZURE_OPENAI_API_VERSION = "2025-01-01";
    expect(getAzureConfig().config).toMatchObject({
      model: "m",
      apiVersion: "2025-01-01",
    });
  });
});

describe("azureChat transport", () => {
  const ok = () => respond(200, { choices: [{ message: { content: "hi" } }] });

  it("picks a dispatcher from the proxy env and TLS setting, rebuilding only when the setting flips", async () => {
    fetchMock.mockImplementation(async () => ok());

    insecure = false;
    await azureChat(CONFIG, MSG);
    await azureChat(CONFIG, MSG); // cached
    expect(sentDispatcher(0)).toBeUndefined();
    expect(sentDispatcher(1)).toBeUndefined();

    insecure = true;
    await azureChat(CONFIG, MSG);
    await azureChat(CONFIG, MSG);
    expect(sentDispatcher(2)).toBeInstanceOf(Agent);
    expect(sentDispatcher(3)).toBe(sentDispatcher(2));

    // Each proxy variable is honoured, with or without relaxed TLS.
    let i = 4;
    for (const v of PROXY_VARS) {
      for (const v2 of PROXY_VARS) vi.stubEnv(v2, "");
      vi.stubEnv(v, "http://proxy.invalid:3128");
      insecure = !insecure;
      await azureChat(CONFIG, MSG);
      expect(sentDispatcher(i++)).toBeInstanceOf(ProxyAgent);
    }
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.invalid/openai/deployments/d/chat/completions?api-version=v",
    );
  });

  it("returns content, model and usage, falling back to the configured model", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(200, {
        model: "served",
        choices: [{ message: { content: "SELECT 1" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    expect(await azureChat(CONFIG, MSG, { maxTokens: 10 })).toEqual({
      content: "SELECT 1",
      model: "served",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    expect(sentBody(0)).toEqual({ messages: MSG, max_completion_tokens: 10 });

    fetchMock.mockResolvedValueOnce(respond(200, {}));
    expect(await azureChat(CONFIG, MSG)).toEqual({
      content: "",
      model: "cfg-model",
      usage: undefined,
    });
  });

  it("adapts the body to each unsupported parameter and retries", async () => {
    fetchMock
      .mockResolvedValueOnce(
        respond(400, {
          error: {
            message:
              "Unsupported parameter: 'max_completion_tokens'. Use 'max_tokens' instead.",
          },
        }),
      )
      .mockResolvedValueOnce(
        respond(400, { message: "Unsupported value: 'temperature'" }),
      )
      .mockResolvedValueOnce(
        respond(400, { error: { message: "response_format not supported" } }),
      )
      .mockResolvedValueOnce(ok());
    const res = await azureChat(CONFIG, MSG, {
      maxTokens: 50,
      temperature: 0.2,
      jsonMode: true,
    });
    expect(res.content).toBe("hi");
    expect(sentBody(0)).toEqual({
      messages: MSG,
      max_completion_tokens: 50,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    expect(sentBody(1)).toEqual({
      messages: MSG,
      max_tokens: 50,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    expect(sentBody(2)).toEqual({
      messages: MSG,
      max_tokens: 50,
      response_format: { type: "json_object" },
    });
    expect(sentBody(3)).toEqual({ messages: MSG, max_tokens: 50 });
  });

  it("gives up when the same complaint repeats after the parameter is gone", async () => {
    const err400 = (message: string) => respond(400, { error: { message } });
    fetchMock
      .mockResolvedValueOnce(err400("max_tokens vs max_completion_tokens"))
      .mockResolvedValueOnce(err400("max_tokens vs max_completion_tokens"));
    let err = await azureChat(CONFIG, MSG).catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(err.message).toBe(
      "Azure OpenAI returned 400: max_tokens vs max_completion_tokens",
    );

    for (const msg of ["temperature", "response_format"]) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValue(err400(`bad ${msg}`));
      err = await azureChat(CONFIG, MSG).catch((e) => e);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(err.message).toBe(`Azure OpenAI returned 400: bad ${msg}`);
    }
  });

  it("uses the status text when the error body is unreadable or empty", async () => {
    fetchMock.mockResolvedValueOnce(
      respond(500, new Error("not json"), "Internal Server Error"),
    );
    let err = await azureChat(CONFIG, MSG).catch((e) => e);
    expect(err).toBeInstanceOf(AzureOpenAIError);
    expect(err.status).toBe(500);
    expect(err.message).toBe(
      "Azure OpenAI returned 500: Internal Server Error",
    );

    fetchMock.mockResolvedValueOnce(respond(503, {}, "Unavailable"));
    err = await azureChat(CONFIG, MSG).catch((e) => e);
    expect(err.message).toBe("Azure OpenAI returned 503: Unavailable");
  });

  it("reports a timeout when the request is aborted", async () => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_, reject) =>
          init!.signal!.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          }),
        ),
    );
    const err = await azureChat(CONFIG, MSG, { timeoutMs: 5 }).catch((e) => e);
    expect(err.message).toBe("Azure OpenAI request timed out");
  });

  it("surfaces the network cause behind 'fetch failed'", async () => {
    const fail = (cause?: object) =>
      Object.assign(new Error("fetch failed"), { cause });
    fetchMock.mockRejectedValueOnce(fail({ code: "ECONNREFUSED" }));
    expect((await azureChat(CONFIG, MSG).catch((e) => e)).message).toBe(
      "Failed to reach Azure OpenAI endpoint: ECONNREFUSED",
    );
    fetchMock.mockRejectedValueOnce(fail({ message: "self-signed cert" }));
    expect((await azureChat(CONFIG, MSG).catch((e) => e)).message).toBe(
      "Failed to reach Azure OpenAI endpoint: self-signed cert",
    );
    fetchMock.mockRejectedValueOnce(fail({ message: "fetch failed" }));
    expect((await azureChat(CONFIG, MSG).catch((e) => e)).message).toBe(
      "Failed to reach Azure OpenAI endpoint",
    );
    fetchMock.mockRejectedValueOnce(fail());
    expect((await azureChat(CONFIG, MSG).catch((e) => e)).message).toBe(
      "Failed to reach Azure OpenAI endpoint",
    );
    fetchMock.mockRejectedValueOnce(undefined);
    expect((await azureChat(CONFIG, MSG).catch((e) => e)).message).toBe(
      "Failed to reach Azure OpenAI endpoint",
    );
  });
});

describe("parseGeneration field types", () => {
  it("blanks non-string query and explanation fields", () => {
    expect(parseGeneration('{"query": 1, "explanation": null}')).toEqual({
      query: "",
      explanation: "",
    });
  });
});
