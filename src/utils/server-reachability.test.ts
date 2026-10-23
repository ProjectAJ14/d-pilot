import { beforeEach, describe, expect, it, vi } from "vitest";
import "./browser-request.testing";

const shown = vi.hoisted(() => [] as unknown[]);
vi.mock("@mantine/notifications", () => ({
  notifications: { show: (n: unknown) => shown.push(n) },
}));

// The store reads localStorage and hooks window at import time.
const mem: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => (mem[k] = v),
  removeItem: (k: string) => delete mem[k],
});
vi.stubGlobal("window", { addEventListener: () => {} });

const {
  bannerMessage,
  isDpilotErrorBody,
  isServerUnreachable,
  isUnreachableRejection,
  isUnreachableStatus,
  loadNetworkHint,
  loginErrorMessage,
  saveNetworkHint,
} = await import("./server-reachability");
const { api, ApiError } = await import("./api-client");
const { useStore } = await import("../store");
const { notifyError, isReportable } = await import("./notify-error");

// Like a real fetch, it builds a Request first — so a header fetch refuses to
// send throws a TypeError before any network activity.
const reply = (status: number, body: unknown = {}) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    new Request(input, init);
    return new Response(JSON.stringify(body), { status });
  });
const flagged = () => useStore.getState().serverUnreachable;

beforeEach(async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  // Back to reachable through the client, so its own record agrees.
  vi.stubGlobal("fetch", reply(200));
  await api.ping();
});

describe("classifying a fetch outcome", () => {
  it("treats a proxy's 502/504 as the server being unreachable", () => {
    expect(isUnreachableStatus(502)).toBe(true);
    expect(isUnreachableStatus(504)).toBe(true);
  });

  it("knows D-Pilot's own error body from a proxy's page", () => {
    expect(isDpilotErrorBody({ error: "boom" })).toBe(true);
    expect(isDpilotErrorBody({})).toBe(false);
    expect(isDpilotErrorBody(null)).toBe(false);
    expect(isDpilotErrorBody("<html>")).toBe(false);
  });

  it("leaves 503 (an unreachable database) and other errors to the caller", () => {
    for (const s of [200, 401, 403, 404, 500, 503]) {
      expect(isUnreachableStatus(s)).toBe(false);
    }
  });

  it("treats a network rejection as unreachable, but not our own abort", () => {
    expect(isUnreachableRejection(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isUnreachableRejection(new DOMException("aborted", "AbortError")),
    ).toBe(false);
  });
});

describe("bannerMessage", () => {
  it("says offline when the browser is offline, whatever the hint", () => {
    expect(bannerMessage(false, "Connect to the VPN.")).toMatch(
      /^You're offline/,
    );
  });
  it("uses the deployment's hint, else the generic advice", () => {
    expect(bannerMessage(true, "Connect to the VPN.")).toBe(
      "Can't reach the D-Pilot server. Connect to the VPN.",
    );
    expect(bannerMessage(true, "  ")).toBe(
      "Can't reach the D-Pilot server. Check your network or VPN connection.",
    );
  });
});

describe("loginErrorMessage", () => {
  it("gives sign-in the banner's text, hint included, when the server is unreachable", () => {
    const err = new ApiError(
      "Can't reach the D-Pilot server.",
      0,
      "SERVER_UNREACHABLE",
    );
    expect(loginErrorMessage(err, true, "Connect to the VPN.")).toBe(
      "Can't reach the D-Pilot server. Connect to the VPN.",
    );
    expect(loginErrorMessage(err, false, "Connect to the VPN.")).toMatch(
      /^You're offline/,
    );
  });
  it("keeps any other error's own message", () => {
    expect(
      loginErrorMessage(new ApiError("Invalid credentials", 401), true, "x"),
    ).toBe("Invalid credentials");
    expect(loginErrorMessage(new Error(""), true, "x")).toBe(
      "Invalid credentials",
    );
  });
});

describe("network hint persistence", () => {
  it("keeps the last hint from /api/config for when it can't be fetched", () => {
    useStore.getState().setConfig({
      ...useStore.getState().config,
      networkHint: "Connect to the VPN.",
    });
    expect(loadNetworkHint()).toBe("Connect to the VPN.");
    saveNetworkHint("");
    expect(loadNetworkHint()).toBe("");
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadNetworkHint()).toBe("");
    expect(() => saveNetworkHint("x")).not.toThrow();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => mem[k] ?? null,
      setItem: (k: string, v: string) => (mem[k] = v),
      removeItem: (k: string) => delete mem[k],
    });
  });
});

describe("api-client when the server is unreachable", () => {
  it("throws SERVER_UNREACHABLE and raises the flag when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await api.getConnections().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("SERVER_UNREACHABLE");
    expect(err.status).toBe(0);
    expect(isServerUnreachable(err)).toBe(true);
    expect(flagged()).toBe(true);
  });

  it("does the same for a proxy's 502, and for the public config fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      ),
    );
    const err = await api.getConfig().catch((e) => e);
    expect(err.code).toBe("SERVER_UNREACHABLE");
    expect(err.status).toBe(502);
    expect(flagged()).toBe(true);
  });

  it("reads a 502 carrying D-Pilot's own JSON error as an ordinary error", async () => {
    vi.stubGlobal("fetch", reply(502, { error: "The AI provider failed" }));
    const err = await api.getConnections().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(502);
    expect(err.message).toBe("The AI provider failed");
    expect(isServerUnreachable(err)).toBe(false);
    expect(flagged()).toBe(false);
  });

  // A proxy timing out a long query says nothing about the server's health.
  const timeoutThenHealth = (health: () => Promise<Response>) =>
    vi.fn(async (req: Request) =>
      req.url.endsWith("/api/health")
        ? health()
        : new Response("<html>Gateway Timeout</html>", { status: 504 }),
    );

  it("reads a 504 as the proxy giving up, and keeps the banner down while health answers", async () => {
    const fetchMock = timeoutThenHealth(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const err = await api.getConnections().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(504);
    expect(err.message).toMatch(/took too long/);
    expect(isServerUnreachable(err)).toBe(false);
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([r]) => r.url.endsWith("/api/health")),
      ).toHaveLength(1),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(flagged()).toBe(false);
  });

  it("counts a 504 on the health check itself as unreachable, once", async () => {
    const fetchMock = reply(504);
    vi.stubGlobal("fetch", fetchMock);
    expect(await api.ping()).toBe(false);
    expect(flagged()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("raises the banner after a 504 only when the health check fails too", async () => {
    vi.stubGlobal(
      "fetch",
      timeoutThenHealth(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const err = await api.getConnections().catch((e) => e);
    expect(isServerUnreachable(err)).toBe(false);
    await vi.waitFor(() => expect(flagged()).toBe(true));
  });

  it("keeps a 503 as the server's own CONNECTION_FAILED, banner down", async () => {
    vi.stubGlobal(
      "fetch",
      reply(503, { error: "Can't reach orders-db", code: "CONNECTION_FAILED" }),
    );
    const err = await api.getConnections().catch((e) => e);
    expect(err.code).toBe("CONNECTION_FAILED");
    expect(err.message).toBe("Can't reach orders-db");
    expect(flagged()).toBe(false);
  });

  it("clears the flag on the next response, error or not", async () => {
    vi.stubGlobal("fetch", reply(502));
    await api.getConnections().catch(() => {});
    expect(flagged()).toBe(true);
    vi.stubGlobal("fetch", reply(500, { error: "boom" }));
    await api.getConnections().catch(() => {});
    expect(flagged()).toBe(false);
  });

  it("ping reports health without throwing, and recovers the flag", async () => {
    vi.stubGlobal("fetch", reply(502));
    expect(await api.ping()).toBe(false);
    expect(flagged()).toBe(true);
    const ok = reply(200);
    vi.stubGlobal("fetch", ok);
    expect(await api.ping()).toBe(true);
    expect(
      String((ok.mock.calls[0][0] as Request).url ?? ok.mock.calls[0][0]),
    ).toMatch(/\/api\/health$/);
    expect(flagged()).toBe(false);
  });
});

describe("a request fetch refuses to send", () => {
  it("is an ordinary error, not the server being unreachable", async () => {
    vi.stubGlobal("fetch", reply(200));
    // Unmask notes are free text; a header can't carry an em dash or a newline.
    mem["phi_shield"] = "off";
    mem["phi_unmask_notes"] = "ticket 42 — line one\nline two";
    const err = await api.getConnections().catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isServerUnreachable(err)).toBe(false);
    expect(flagged()).toBe(false);
  });
});

describe("notifyError", () => {
  it("leaves an unreachable server to the banner, but toasts anything else", () => {
    shown.length = 0;
    notifyError(new ApiError("x", 0, "SERVER_UNREACHABLE"), "Test");
    expect(shown).toHaveLength(0);
    notifyError(
      new ApiError("Can't reach orders-db", 503, "CONNECTION_FAILED"),
      "Test",
    );
    expect(shown).toHaveLength(1);
  });
});

describe("isReportable", () => {
  it("offers no bug report for an unreachable server, even behind a 502", () => {
    expect(isReportable(new ApiError("x", 502, "SERVER_UNREACHABLE"))).toBe(
      false,
    );
    expect(isReportable(new ApiError("boom", 500))).toBe(true);
  });

  it("offers no bug report for an unreachable database (503 CONNECTION_FAILED)", () => {
    expect(isReportable(new ApiError("x", 503, "CONNECTION_FAILED"))).toBe(
      false,
    );
  });
});
