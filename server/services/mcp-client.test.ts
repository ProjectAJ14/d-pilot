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
      .catch((e) => e);
    expect(err).toBeInstanceOf(DPilotApiError);
    expect((err as DPilotApiError).message).toBe("Invalid credentials");
  });
});
