import { describe, it, expect, vi } from "vitest";
import { DPilotApiClient, DPilotApiError } from "./mcp-client.js";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const clientWith = (fetchImpl: typeof fetch) =>
  new DPilotApiClient({
    baseUrl: "http://dpilot.test/",
    username: "agent@example.com",
    password: "secret",
    fetchImpl,
  });

describe("DPilotApiClient", () => {
  it("logs in lazily, then reuses the token", async () => {
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).endsWith("/api/auth/login")
        ? jsonResponse(200, { token: "tok-1" })
        : jsonResponse(200, { ok: true }),
    ) as unknown as typeof fetch;

    const client = clientWith(fetchImpl);
    await client.get("/connections");
    await client.get("/connections");

    const calls = (fetchImpl as any).mock.calls;
    expect(calls.map((c: any[]) => String(c[0]))).toEqual([
      "http://dpilot.test/api/auth/login",
      "http://dpilot.test/api/connections",
      "http://dpilot.test/api/connections",
    ]);
    expect(calls[1][1].headers.Authorization).toBe("Bearer tok-1");
  });

  // The audit log tells an agent's queries from the UI's by this header
  // (services/request-source.ts). Login is not audited, so only API calls need it.
  it("marks every API call as coming from MCP", async () => {
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).endsWith("/api/auth/login")
        ? jsonResponse(200, { token: "tok-1" })
        : jsonResponse(200, { ok: true }),
    ) as unknown as typeof fetch;

    const client = clientWith(fetchImpl);
    await client.get("/connections");
    await client.post("/query/execute", { sql: "SELECT 1" });

    const calls = (fetchImpl as any).mock.calls.slice(1);
    for (const [, init] of calls)
      expect(init.headers["X-DPilot-Source"]).toBe("mcp");
  });

  it("re-logs in and replays once when the token has expired", async () => {
    let issued = 0;
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      if (String(url).endsWith("/api/auth/login")) {
        return jsonResponse(200, { token: `tok-${++issued}` });
      }
      return init.headers.Authorization === "Bearer tok-1"
        ? jsonResponse(401, { error: "Token expired" })
        : jsonResponse(200, { rows: [] });
    }) as unknown as typeof fetch;

    const client = clientWith(fetchImpl);
    await client.get("/connections"); // primes tok-1
    await expect(
      client.post("/query/execute", { sql: "SELECT 1" }),
    ).resolves.toEqual({
      rows: [],
    });
    expect(issued).toBe(2);
  });

  it("gives up after a second 401 instead of looping", async () => {
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).endsWith("/api/auth/login")
        ? jsonResponse(200, { token: "tok" })
        : jsonResponse(401, { error: "Invalid token" }),
    ) as unknown as typeof fetch;

    await expect(clientWith(fetchImpl).get("/connections")).rejects.toThrow(
      "Invalid token",
    );
  });

  it("issues a single login for concurrent requests", async () => {
    let logins = 0;
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).endsWith("/api/auth/login")) {
        logins++;
        return jsonResponse(200, { token: "tok" });
      }
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;

    const client = clientWith(fetchImpl);
    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);
    expect(logins).toBe(1);
  });

  it("surfaces the server's error message and code", async () => {
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).endsWith("/api/auth/login")
        ? jsonResponse(200, { token: "tok" })
        : jsonResponse(503, {
            error: "Unable to connect to the database.",
            code: "CONNECTION_FAILED",
          }),
    ) as unknown as typeof fetch;

    await expect(
      clientWith(fetchImpl).get("/schema/x/tables"),
    ).rejects.toMatchObject({
      name: "DPilotApiError",
      status: 503,
      code: "CONNECTION_FAILED",
    });
  });

  it("reports a failed login clearly", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: "Invalid credentials" }),
    ) as unknown as typeof fetch;

    const err: unknown = await clientWith(fetchImpl)
      .get("/connections")
      .catch((e: DPilotApiError) => e);
    expect(err).toBeInstanceOf(DPilotApiError);
    expect((err as DPilotApiError).message).toBe("Invalid credentials");
  });
});

describe("DPilotApiClient fallbacks", () => {
  it("uses the global fetch when none is given, and PUTs JSON", async () => {
    const globalFetch = vi.fn(async (url: any) =>
      String(url).endsWith("/api/auth/login")
        ? jsonResponse(200, { token: "tok-g" })
        : jsonResponse(200, { saved: true }),
    );
    vi.stubGlobal("fetch", globalFetch);
    try {
      const client = new DPilotApiClient({
        baseUrl: "http://dpilot.test",
        username: "u",
        password: "p",
      });
      expect(await client.put("/artifacts/1", { title: "t" })).toEqual({
        saved: true,
      });
      const [url, init] = globalFetch.mock.calls[1] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toBe("http://dpilot.test/api/artifacts/1");
      expect(init.method).toBe("PUT");
      expect(init.body).toBe('{"title":"t"}');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names the status when a failed login or request has no readable error", async () => {
    const badLogin = clientWith(
      vi.fn(
        async () => new Response("<html>", { status: 503 }),
      ) as unknown as typeof fetch,
    );
    const loginErr: DPilotApiError = await badLogin
      .get<never>("/x")
      .catch((e: DPilotApiError) => e);
    expect(loginErr).toBeInstanceOf(DPilotApiError);
    expect(loginErr.message).toBe("Login failed (503)");
    expect(loginErr.status).toBe(503);

    const badRequest = clientWith(
      vi.fn(async (url: any) =>
        String(url).endsWith("/api/auth/login")
          ? jsonResponse(200, { token: "t" })
          : new Response("oops", { status: 500 }),
      ) as unknown as typeof fetch,
    );
    const reqErr: DPilotApiError = await badRequest
      .get<never>("/x")
      .catch((e: DPilotApiError) => e);
    expect(reqErr.message).toBe("Request failed (500)");
    expect(reqErr.code).toBeUndefined();
  });
});
