// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi, renderSettings, user } from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);

const totals = {
  totalUsers: 12,
  activeUsers: 9,
  neverLoggedIn: 2,
  queriesToday: 40,
  queries30d: 90,
  queriesTotal: 1500,
  dauToday: 5,
  wau: 7,
  mau: 9,
  phiUnmask30d: 3,
  phiDenied30d: 1,
  errors30d: 10,
  exports30d: 4,
  avgLatencyMs: 120,
  totalRows30d: 4000,
  aiGenerations30d: 8,
  aiSuccess30d: 6,
  aiTokens30d: 2500,
  savedQueries: 11,
};

const full = {
  generatedAt: "2026-06-05T00:00:00Z",
  totals,
  capabilityDistribution: [
    { capability: "admin", count: 2 },
    { capability: "custom_cap", count: 1 },
  ],
  daily: [
    { date: "2026-06-04", queries: 3, activeUsers: 0, aiQueries: 1 },
    { date: "2026-06-05", queries: 7, activeUsers: 2, aiQueries: 0 },
  ],
  actionBreakdown: [
    { action: "QUERY_EXECUTE", count: 30 },
    { action: "SOMETHING_NEW", count: 5 },
  ],
  topUsers: [{ email: "alice@example.com", queries: 30, lastActive: "" }],
  byConnection: [{ connectionId: "app_core-dev", count: 30 }],
};

const empty = {
  ...full,
  totals: {
    ...totals,
    aiGenerations30d: 0,
    queries30d: 0,
    errors30d: 0,
    savedQueries: undefined,
  },
  capabilityDistribution: [],
  daily: [],
  actionBreakdown: [],
  topUsers: [],
  byConnection: [],
};

const conns = [
  { id: "c1", name: "orders-qa", env: "QA", type: "postgres", live: false },
  {
    id: "c2",
    name: "app_core-dev",
    env: "DEV",
    type: "postgres",
    live: true,
    totalSockets: 3,
    lastUsedAt: "2026-06-05T10:00:00Z",
  },
  { id: "c3", name: "customers", env: "PROD", type: "mssql", live: true },
  { id: "c4", name: "billing", env: "QA", type: "mssql", live: false },
];

beforeEach(() => {
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
});

describe("Analytics tab", () => {
  it("renders KPIs, charts, breakdowns and live connections", async () => {
    mockApi.getAnalytics.mockResolvedValue(full);
    mockApi.getConnectionStatus.mockResolvedValue(conns);
    renderSettings("analytics");
    expect(await screen.findByText("Total users")).toBeTruthy();
    expect(screen.getByText("9 active in 30d")).toBeTruthy();
    expect(screen.getByText("75% success · 2,500 tokens (30d)")).toBeTruthy();
    expect(screen.getByText("10% error rate (30d)")).toBeTruthy();
    expect(screen.getByText("120 ms")).toBeTruthy();
    expect(screen.getByText("peak 7 · Jun 5")).toBeTruthy();
    expect(screen.getByText("peak 2 · Jun 5")).toBeTruthy();
    expect(screen.getByText("peak 1 · Jun 4")).toBeTruthy();
    expect(screen.getByText("SOMETHING_NEW")).toBeTruthy();
    expect(screen.getByText("custom_cap")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(screen.getByText("AL")).toBeTruthy();
    expect(screen.getByText("2 live · 4 configured")).toBeTruthy();
    expect(screen.getByText("3 open · 0 idle")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();

    // Live first, then by name.
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual([
      "app_core-dev",
      "customers",
      "billing",
      "orders-qa",
    ]);
  });

  it("shows empty states and zero rates", async () => {
    mockApi.getAnalytics.mockResolvedValue(empty);
    mockApi.getConnectionStatus.mockRejectedValue(new Error("status down"));
    renderSettings("analytics");
    expect(await screen.findByText("No activity yet")).toBeTruthy();
    expect(screen.getByText("No query activity yet")).toBeTruthy();
    expect(screen.getByText("No queries yet")).toBeTruthy();
    expect(screen.getByText("0% success · 2,500 tokens (30d)")).toBeTruthy();
    expect(screen.getByText("0% error rate (30d)")).toBeTruthy();
    expect(screen.getByText("0 live · 0 configured")).toBeTruthy();
    // With no days there is no peak to show, and no "Jan undefined".
    expect(screen.queryByText(/^peak /)).toBeNull();
    expect(screen.queryByText(/undefined/)).toBeNull();
  });

  it("disconnects a live pool and refreshes", async () => {
    mockApi.getAnalytics.mockResolvedValue(full);
    mockApi.getConnectionStatus.mockResolvedValue(conns);
    renderSettings("analytics");
    const u = user();
    await screen.findByText("Total users");

    mockApi.disconnectConnection.mockRejectedValueOnce(new Error("busy"));
    await u.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
    expect(await screen.findByText("busy")).toBeTruthy();

    mockApi.disconnectConnection.mockResolvedValue({});
    await u.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
    expect(await screen.findByText("Disconnected app_core-dev")).toBeTruthy();
    expect(mockApi.disconnectConnection).toHaveBeenLastCalledWith("c2");
    expect(mockApi.getConnectionStatus).toHaveBeenCalledTimes(2);

    await u.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mockApi.getAnalytics).toHaveBeenCalledTimes(2));
  });

  it("keeps the loader and reports when analytics fail", async () => {
    mockApi.getAnalytics.mockRejectedValue(new Error("analytics down"));
    mockApi.getConnectionStatus.mockResolvedValue([]);
    renderSettings("analytics");
    expect(await screen.findByText("analytics down")).toBeTruthy();
    expect(screen.getByText("Crunching usage data…")).toBeTruthy();
  });
});
