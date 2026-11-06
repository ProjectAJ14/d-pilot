import { beforeEach, describe, expect, it, vi } from "vitest";
import "./browser-request.testing";

// The store (pulled in lazily on logout / reachability) reads localStorage and
// hooks window at import time.
const mem: Record<string, string> = {};
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem[k] ?? null,
  setItem: (k: string, v: string) => (mem[k] = v),
  removeItem: (k: string) => delete mem[k],
});
vi.stubGlobal("window", { addEventListener: () => {} });

const { api, ApiError } = await import("./api-client");
const { useStore } = await import("../store");
const { PROXY_TIMEOUT_MESSAGE, SERVER_UNREACHABLE_MESSAGE } =
  await import("./server-reachability");

let sent: Request[] = [];
const reply = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  vi.fn(async (req: Request) => {
    sent.push(req);
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      { status, headers },
    );
  });
const last = () => sent[sent.length - 1];
const pathOf = (r: Request) => {
  const u = new URL(r.url);
  return decodeURIComponent(u.pathname + u.search);
};

beforeEach(async () => {
  for (const k of Object.keys(mem)) delete mem[k];
  vi.stubGlobal("fetch", reply(200));
  await api.ping(); // back to "reachable" through the client
  sent = [];
});

describe("request headers", () => {
  it("sends the source label, no auth and no PHI headers by default", async () => {
    await api.me();
    const h = last().headers;
    expect(h.get("Content-Type")).toBe("application/json");
    expect(h.get("X-DPilot-Source")).toBe("ui");
    expect(h.get("Authorization")).toBeNull();
    expect(h.get("X-PHI-Shield")).toBeNull();
  });

  it("adds the bearer token and encoded unmask reason/notes", async () => {
    mem.dbpilot_token = "tok";
    mem.phi_shield = "off";
    mem.phi_unmask_reason = "Audit — follow-up";
    mem.phi_unmask_notes = "line1\nline2";
    await api.me();
    const h = last().headers;
    expect(h.get("Authorization")).toBe("Bearer tok");
    expect(h.get("X-PHI-Shield")).toBe("off");
    expect(decodeURIComponent(h.get("X-PHI-Unmask-Reason")!)).toBe(
      "Audit — follow-up",
    );
    expect(decodeURIComponent(h.get("X-PHI-Unmask-Notes")!)).toBe(
      "line1\nline2",
    );
  });

  it("omits reason/notes headers when none were given", async () => {
    mem.phi_shield = "off";
    await api.me();
    expect(last().headers.get("X-PHI-Shield")).toBe("off");
    expect(last().headers.has("X-PHI-Unmask-Reason")).toBe(false);
    expect(last().headers.has("X-PHI-Unmask-Notes")).toBe(false);
  });
});

describe("responses", () => {
  it("returns CSV as text and everything else as JSON", async () => {
    vi.stubGlobal(
      "fetch",
      reply(200, "a,b\n1,2", { "Content-Type": "text/csv" }),
    );
    expect(await api.exportPhiRules()).toBe("a,b\n1,2");
    vi.stubGlobal("fetch", reply(200, { ok: 1 }));
    expect(await api.me()).toEqual({ ok: 1 });
  });

  it("throws the server's error, code and write request", async () => {
    const request = { id: "w1" };
    vi.stubGlobal(
      "fetch",
      reply(503, { error: "db down", code: "CONNECTION_FAILED", request }),
    );
    const err = await api.submitWriteRequest("w1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      name: "ApiError",
      message: "db down",
      status: 503,
      code: "CONNECTION_FAILED",
      request,
    });
  });

  it("falls back to the status when the body has no error", async () => {
    vi.stubGlobal("fetch", reply(500, {}));
    await expect(api.me()).rejects.toMatchObject({
      message: "Request failed: 500",
      status: 500,
    });
  });

  it("uses the status text when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>", { status: 500, statusText: "Server Error" }),
      ),
    );
    await expect(api.me()).rejects.toMatchObject({ message: "Server Error" });
  });

  it("logs out on a 401 when a token was sent", async () => {
    mem.dbpilot_token = "tok";
    useStore.setState({ token: "tok", isAuthenticated: true });
    vi.stubGlobal("fetch", reply(401, { error: "jwt expired" }));
    await expect(api.me()).rejects.toMatchObject({
      message: "Session expired",
      status: 401,
    });
    expect(useStore.getState().isAuthenticated).toBe(false);
    expect(mem.dbpilot_token).toBeUndefined();
  });

  it("passes a 401 without a token through (bad login)", async () => {
    useStore.setState({ isAuthenticated: false });
    vi.stubGlobal("fetch", reply(401, { error: "Invalid credentials" }));
    await expect(api.login("a", "b")).rejects.toMatchObject({
      message: "Invalid credentials",
      status: 401,
    });
  });
});

describe("reachability", () => {
  it("raises the banner on a rejected fetch and lowers it on any response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api.me()).rejects.toMatchObject({
      message: SERVER_UNREACHABLE_MESSAGE,
      status: 0,
      code: "SERVER_UNREACHABLE",
    });
    expect(useStore.getState().serverUnreachable).toBe(true);
    expect(await api.ping()).toBe(false);

    vi.stubGlobal("fetch", reply(404, { error: "nope" }));
    await expect(api.me()).rejects.toMatchObject({ status: 404 });
    expect(useStore.getState().serverUnreachable).toBe(false);
  });

  it("rethrows our own abort untouched", async () => {
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(api.me()).rejects.toBe(abort);
    expect(useStore.getState().serverUnreachable).toBe(false);
  });

  it("reads a proxy's 502 page as unreachable, but D-Pilot's own 502 as an error", async () => {
    vi.stubGlobal("fetch", reply(502, "<html>bad gateway</html>"));
    await expect(api.me()).rejects.toMatchObject({
      status: 502,
      code: "SERVER_UNREACHABLE",
    });
    expect(useStore.getState().serverUnreachable).toBe(true);

    vi.stubGlobal("fetch", reply(502, { error: "upstream said no" }));
    await expect(api.me()).rejects.toMatchObject({
      message: "upstream said no",
      status: 502,
    });
    expect(useStore.getState().serverUnreachable).toBe(false);
  });

  it("turns a 504 into a timeout error plus one health ping", async () => {
    vi.stubGlobal("fetch", reply(504));
    await expect(api.me()).rejects.toMatchObject({
      message: PROXY_TIMEOUT_MESSAGE,
      status: 504,
    });
    await vi.waitFor(() =>
      expect(useStore.getState().serverUnreachable).toBe(true),
    );
    expect(sent.map(pathOf)).toEqual(["/api/auth/me", "/api/health"]);
  });

  it("getConfig is unauthenticated and parses JSON", async () => {
    mem.dbpilot_token = "tok";
    vi.stubGlobal("fetch", reply(200, { appName: "D-Pilot" }));
    expect(await api.getConfig()).toEqual({ appName: "D-Pilot" });
    expect(pathOf(last())).toBe("/api/config");
    expect(last().headers.get("Authorization")).toBeNull();
  });
});

const obj = {
  schema: "app_core",
  name: "fn x",
  kind: "function" as const,
  args: "",
  argTypes: "int4",
  parent: "orders",
};

// [call, method, path (decoded), JSON body or undefined]
const endpoints: [() => Promise<unknown>, string, string, unknown?][] = [
  [() => api.me(), "GET", "/api/auth/me"],
  [
    () => api.login("ann", "pw"),
    "POST",
    "/api/auth/login",
    { username: "ann", password: "pw" },
  ],
  [() => api.getConnections(), "GET", "/api/connections"],
  [() => api.getWritableConnections(), "GET", "/api/connections/writable"],
  [() => api.getConnectionsGrouped(), "GET", "/api/connections/grouped"],
  [() => api.testConnection("c1"), "GET", "/api/connections/c1/test"],
  [() => api.getConnectionStatus(), "GET", "/api/connections/status"],
  [
    () => api.disconnectConnection("c1"),
    "POST",
    "/api/connections/c1/disconnect",
  ],
  [() => api.getWritePolicy(), "GET", "/api/write-requests/policy"],
  [
    () => api.updateWritePolicy({ writeModeEnabled: true }),
    "PUT",
    "/api/write-requests/policy",
    { writeModeEnabled: true },
  ],
  [() => api.getWriteRequests(), "GET", "/api/write-requests"],
  [() => api.getWriteRequest("w1"), "GET", "/api/write-requests/w1"],
  [
    () =>
      api.createWriteRequest({
        title: "t",
        connectionId: "c1",
        writeSql: "x",
      }),
    "POST",
    "/api/write-requests",
    { title: "t", connectionId: "c1", writeSql: "x" },
  ],
  [
    () => api.analyzeWrite({ connectionId: "c1", writeSql: "x" }),
    "POST",
    "/api/write-requests/analyze",
    { connectionId: "c1", writeSql: "x" },
  ],
  [
    () => api.previewWriteRequest("w1", 10),
    "POST",
    "/api/write-requests/w1/preview",
    { defaultLimit: 10 },
  ],
  [
    () => api.aiReviewWriteRequest("w1"),
    "POST",
    "/api/write-requests/w1/ai-review",
  ],
  [
    () => api.reviewWriteDraft({ connectionId: "c1", writeSql: "x" }),
    "POST",
    "/api/write-requests/ai-review",
    { connectionId: "c1", writeSql: "x" },
  ],
  [
    () => api.suggestWriteQuery({ connectionId: "c1", selectSql: "s" }),
    "POST",
    "/api/write-requests/suggest-write",
    { connectionId: "c1", selectSql: "s" },
  ],
  [
    () => api.suggestSelectQuery({ connectionId: "c1", writeSql: "w" }),
    "POST",
    "/api/write-requests/suggest-select",
    { connectionId: "c1", writeSql: "w" },
  ],
  [
    () => api.approveWriteRequest("w1", "ok"),
    "POST",
    "/api/write-requests/w1/approve",
    { notes: "ok" },
  ],
  [
    () => api.overrideWriteRequest("w1", "urgent"),
    "POST",
    "/api/write-requests/w1/override",
    { notes: "urgent" },
  ],
  [
    () => api.rejectWriteRequest("w1", "no"),
    "POST",
    "/api/write-requests/w1/reject",
    { notes: "no" },
  ],
  [() => api.submitWriteRequest("w1"), "POST", "/api/write-requests/w1/submit"],
  [() => api.cancelWriteRequest("w1"), "POST", "/api/write-requests/w1/cancel"],
  [() => api.deleteWriteRequest("w1"), "DELETE", "/api/write-requests/w1"],
  [
    () => api.reviseWriteRequest("w1", { note: "n" }),
    "POST",
    "/api/write-requests/w1/revise",
    { note: "n" },
  ],
  [
    () => api.executeQuery("c1", "select 1", 100, "app_core"),
    "POST",
    "/api/query/execute",
    {
      connectionId: "c1",
      sql: "select 1",
      defaultLimit: 100,
      schema: "app_core",
    },
  ],
  [() => api.getQueryHistory(), "GET", "/api/query/history?limit=50&offset=0"],
  [
    () => api.getQueryHistory(10, 20),
    "GET",
    "/api/query/history?limit=10&offset=20",
  ],
  [
    () => api.exportQueryHistory("2026-01-01", "2026-01-02"),
    "GET",
    "/api/query/history/export?from=2026-01-01&to=2026-01-02",
  ],
  [() => api.getSavedQueries(), "GET", "/api/saved-queries"],
  [() => api.getSavedQuery("s1"), "GET", "/api/saved-queries/s1"],
  [
    () => api.createSavedQuery({ name: "q" }),
    "POST",
    "/api/saved-queries",
    { name: "q" },
  ],
  [
    () => api.updateSavedQuery("s1", { name: "q" }),
    "PUT",
    "/api/saved-queries/s1",
    { name: "q" },
  ],
  [() => api.deleteSavedQuery("s1"), "DELETE", "/api/saved-queries/s1"],
  [() => api.getArtifacts(), "GET", "/api/artifacts"],
  [() => api.getArtifact("a1"), "GET", "/api/artifacts/a1"],
  [
    () => api.createArtifact({ title: "t", blocks: [] }),
    "POST",
    "/api/artifacts",
    { title: "t", blocks: [] },
  ],
  [
    () => api.updateArtifact("a1", { title: "t" }),
    "PUT",
    "/api/artifacts/a1",
    { title: "t" },
  ],
  [
    () => api.setArtifactArchived("a1", true),
    "PUT",
    "/api/artifacts/a1",
    { archived: true },
  ],
  [() => api.getSchemas("c1"), "GET", "/api/schema/c1/schemas"],
  [() => api.getTables("c1"), "GET", "/api/schema/c1/tables"],
  [() => api.getTables("c1", "a b"), "GET", "/api/schema/c1/tables?schema=a b"],
  [() => api.getObjects("c1"), "GET", "/api/schema/c1/objects"],
  [
    () => api.getObjects("c1", "app_core"),
    "GET",
    "/api/schema/c1/objects?schema=app_core",
  ],
  [
    () => api.getObjectDefinition("c1", obj),
    "GET",
    "/api/schema/c1/objects/function/fn x/definition?schema=app_core&args=&argTypes=int4&parent=orders",
  ],
  [
    () =>
      api.getObjectDependencies("c1", {
        schema: "app_core",
        name: "v",
        kind: "view",
      }),
    "GET",
    "/api/schema/c1/objects/view/v/dependencies?schema=app_core",
  ],
  [() => api.getJobs("c1"), "GET", "/api/schema/c1/jobs"],
  [() => api.getJob("c1", "a/b"), "GET", "/api/schema/c1/jobs/a/b"],
  [() => api.getDrift("c1", "c2"), "GET", "/api/schema/c1/drift?against=c2"],
  [
    () => api.getDrift("c1", "c2", "app_core"),
    "GET",
    "/api/schema/c1/drift?against=c2&schema=app_core",
  ],
  [() => api.getFullSchema("c1"), "GET", "/api/schema/c1/full"],
  [
    () => api.getFullSchema("c1", "app_core"),
    "GET",
    "/api/schema/c1/full?schema=app_core",
  ],
  [
    () => api.getColumns("c1", "orders"),
    "GET",
    "/api/schema/c1/tables/orders/columns",
  ],
  [
    () => api.getColumns("c1", "orders", "app_core"),
    "GET",
    "/api/schema/c1/tables/orders/columns?schema=app_core",
  ],
  [
    () => api.logPhiUnmask({ reason: "r" }),
    "POST",
    "/api/phi-config/unmask",
    { reason: "r" },
  ],
  [() => api.getPhiRules(), "GET", "/api/phi-config"],
  [() => api.createPhiRule({ f: 1 }), "POST", "/api/phi-config", { f: 1 }],
  [
    () => api.updatePhiRule("p1", { f: 1 }),
    "PUT",
    "/api/phi-config/p1",
    { f: 1 },
  ],
  [() => api.deletePhiRule("p1"), "DELETE", "/api/phi-config/p1"],
  [() => api.exportPhiRules(), "GET", "/api/phi-config/export"],
  [
    () => api.importPhiRules("a,b"),
    "POST",
    "/api/phi-config/import",
    { csv: "a,b" },
  ],
  [
    () => api.deleteAllPhiRules(true),
    "DELETE",
    "/api/phi-config?includeLocked=true",
  ],
  [() => api.getMaskedEnvironments(), "GET", "/api/phi-config/masked-envs"],
  [
    () => api.updateMaskedEnvironments(["PROD"]),
    "PUT",
    "/api/phi-config/masked-envs",
    { environments: ["PROD"] },
  ],
  [() => api.getAuditLog(), "GET", "/api/audit"],
  [
    () =>
      api.getAuditLog({
        limit: 5,
        offset: 10,
        from: "f",
        to: "t",
        action: "QUERY",
        userId: "u1",
        phi: true,
        q: "a b",
      }),
    "GET",
    "/api/audit?limit=5&offset=10&from=f&to=t&action=QUERY&userId=u1&phi=1&q=a+b",
  ],
  [() => api.getArchiveLog({ q: "x" }), "GET", "/api/audit/archive?q=x"],
  [
    () => api.exportAuditLog({ from: "f", to: "t", source: "live", q: "x" }),
    "GET",
    "/api/audit/export?from=f&to=t&q=x&source=live",
  ],
  [() => api.getArchiveLog(), "GET", "/api/audit/archive"],
  [() => api.getArchiveLog({ limit: 1 }), "GET", "/api/audit/archive?limit=1"],
  [
    () => api.exportAuditLog({ from: "f", to: "t", source: "live" }),
    "GET",
    "/api/audit/export?from=f&to=t&source=live",
  ],
  [() => api.triggerArchive(), "POST", "/api/audit/archive"],
  [() => api.getAnalytics(), "GET", "/api/analytics"],
  [
    () => api.exportCsv("c1", "select 1", null),
    "POST",
    "/api/export/csv",
    { connectionId: "c1", sql: "select 1", defaultLimit: null },
  ],
  [
    () => api.exportJson("c1", "select 1", 5),
    "POST",
    "/api/export/json",
    { connectionId: "c1", sql: "select 1", defaultLimit: 5 },
  ],
  [
    () => api.changePassword("old", "new"),
    "POST",
    "/api/auth/change-password",
    { currentPassword: "old", newPassword: "new" },
  ],
  [
    () => api.updateProfile({ displayName: "Ann" }),
    "PUT",
    "/api/auth/profile",
    { displayName: "Ann" },
  ],
  [() => api.getUsers(), "GET", "/api/users"],
  [
    () => api.createUser({ email: "e", displayName: "d", password: "p" }),
    "POST",
    "/api/users",
    { email: "e", displayName: "d", password: "p" },
  ],
  [
    () => api.updateUser("u1", { isAdmin: true }),
    "PUT",
    "/api/users/u1",
    { isAdmin: true },
  ],
  [() => api.deleteUser("u1"), "DELETE", "/api/users/u1"],
  [
    () => api.resetUserPassword("u1", "pw"),
    "POST",
    "/api/users/u1/reset-password",
    { newPassword: "pw" },
  ],
  [() => api.testAzureConnection(), "POST", "/api/azure-ai/test"],
  [
    () => api.generateQuery({ connectionId: "c1", prompt: "p" }),
    "POST",
    "/api/azure-ai/generate-query",
    { connectionId: "c1", prompt: "p" },
  ],
  [() => api.getAiSettings(), "GET", "/api/azure-ai/settings"],
  [
    () => api.updateAiSettings({ endpoint: "e" } as never),
    "PUT",
    "/api/azure-ai/settings",
    { endpoint: "e" },
  ],
  [
    () => api.clearSchemaCache(),
    "POST",
    "/api/azure-ai/schema-cache/clear",
    {},
  ],
  [
    () => api.clearSchemaCache("c1"),
    "POST",
    "/api/azure-ai/schema-cache/clear",
    { connectionId: "c1" },
  ],
  [() => api.getAiChatLog(), "GET", "/api/azure-ai/chat-log"],
  [
    () =>
      api.getAiChatLog({
        limit: 5,
        offset: 10,
        from: "f",
        to: "t",
        status: "error",
        q: "boom",
      }),
    "GET",
    "/api/azure-ai/chat-log?q=boom&limit=5&offset=10&from=f&to=t&status=error",
  ],
  [() => api.getAppSettings(), "GET", "/api/settings"],
  [
    () => api.updateAppSettings({ APP_NAME: "x" }),
    "PUT",
    "/api/settings",
    { values: { APP_NAME: "x" } },
  ],
  [() => api.resetAppSetting("a/b"), "DELETE", "/api/settings/a/b"],
  [() => api.getAdminConnections(), "GET", "/api/settings/connections"],
  [
    () => api.createConnection({ id: "c1" } as never),
    "POST",
    "/api/settings/connections",
    { id: "c1" },
  ],
  [
    () => api.updateConnection("c 1", { name: "n" } as never),
    "PUT",
    "/api/settings/connections/c 1",
    { name: "n" },
  ],
  [
    () => api.checkConnectionImport([{ id: "c1" }]),
    "POST",
    "/api/settings/connections/import",
    { connections: [{ id: "c1" }], dryRun: true },
  ],
  [
    () => api.importConnections([{ id: "c1" }]),
    "POST",
    "/api/settings/connections/import",
    { connections: [{ id: "c1" }] },
  ],
  [
    () => api.testConnectionDraft({ id: "c1" } as never),
    "POST",
    "/api/settings/connections/test",
    { id: "c1" },
  ],
  [() => api.deleteConnection("c1"), "DELETE", "/api/settings/connections/c1"],
];

describe("endpoints", () => {
  it.each(
    endpoints.map(([call, method, path, body]) => ({
      call,
      method,
      path,
      body,
    })),
  )("$method $path", async ({ call, method, path, body }) => {
    await call();
    const req = last();
    expect(req.method).toBe(method);
    expect(pathOf(req)).toBe(path);
    if (body === undefined) {
      if (method !== "GET") expect(await req.text()).toBe("");
    } else {
      expect(JSON.parse(await req.text())).toEqual(body);
    }
  });
});
