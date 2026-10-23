import { beforeEach, describe, expect, it, vi } from "vitest";

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
  isServerUnreachable,
  isUnreachableRejection,
  isUnreachableStatus,
  loadNetworkHint,
  saveNetworkHint,
} = await import("./server-reachability");
const { api, ApiError } = await import("./api-client");
const { useStore } = await import("../store");
const { notifyError, isReportable } = await import("./notify-error");

const reply = (status: number, body: unknown = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));
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

  it("does the same for a proxy 502/504, and for the public config fetch", async () => {
    vi.stubGlobal("fetch", reply(504));
    const err = await api.getConfig().catch((e) => e);
    expect(err.code).toBe("SERVER_UNREACHABLE");
    expect(err.status).toBe(504);
    expect(flagged()).toBe(true);
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
    expect(ok).toHaveBeenCalledWith("/api/health", undefined);
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
});
