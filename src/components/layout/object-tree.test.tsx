// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { JobTree, ObjectTree } from "./object-tree";

const { api } = vi.hoisted(() => ({
  api: { getObjects: vi.fn(), getJobs: vi.fn() },
}));
vi.mock("@src/utils/api-client", () => ({ api }));
vi.mock("@src/components/query/drift-report", () => ({
  DriftReportModal: ({
    schema,
    onClose,
  }: {
    schema: string;
    onClose: () => void;
  }) => <button onClick={onClose}>close drift {schema}</button>,
}));

const openObjectTab = vi.fn();
const openJobTab = vi.fn();
beforeEach(() => {
  useStore.setState({ openObjectTab, openJobTab });
});
afterEach(() => vi.clearAllMocks());

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

const objects = [
  {
    schema: "public",
    name: "refresh_orders",
    kind: "procedure",
    args: "integer",
  },
  { schema: "public", name: "order_total", kind: "function", args: "" },
  { schema: "public", name: "active_customers", kind: "view" },
  { schema: "public", name: "orders_audit", kind: "trigger", parent: "orders" },
];

describe("ObjectTree", () => {
  it("loads once on first expand, groups by kind and opens objects", async () => {
    const load = deferred<typeof objects>();
    api.getObjects.mockReturnValue(load.promise);
    renderUi(
      <ObjectTree connId="c1" dbType="postgres" schema="public" query="" />,
    );
    const node = screen.getByRole("button", { name: /Procedures, functions/ });
    expect(node.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(node);
    // A second toggle while loading collapses without refetching.
    fireEvent.click(node);
    fireEvent.click(node);
    expect(api.getObjects).toHaveBeenCalledTimes(1);
    expect(api.getObjects).toHaveBeenCalledWith("c1", "public");
    await act(async () => load.resolve(objects));
    expect(node.textContent).toContain("(4)");
    expect(screen.getByText("Procedures (1)")).toBeTruthy();
    expect(screen.getByText("Triggers (1)")).toBeTruthy();
    expect(screen.queryByText(/Indexes/)).toBeNull();
    expect(screen.getByText("(integer)")).toBeTruthy();
    expect(screen.getByTitle("on orders").textContent).toContain("orders");

    fireEvent.click(screen.getByText("active_customers"));
    expect(openObjectTab).toHaveBeenCalledWith("c1", objects[2]);

    // Collapse and re-expand: cached, no refetch.
    fireEvent.click(node);
    expect(screen.queryByText("active_customers")).toBeNull();
    fireEvent.keyDown(node, { key: "Enter" });
    expect(screen.getByText("active_customers")).toBeTruthy();
    expect(api.getObjects).toHaveBeenCalledTimes(1);
  });

  it("filters by the search query and opens the drift report", async () => {
    api.getObjects.mockResolvedValue(objects);
    renderUi(<ObjectTree connId="c1" dbType="mssql" schema="" query="order" />);
    fireEvent.click(screen.getByRole("button", { name: /Procedures/ }));
    expect(await screen.findByText("refresh_orders")).toBeTruthy();
    expect(api.getObjects).toHaveBeenCalledWith("c1", undefined);
    expect(screen.queryByText("active_customers")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Drift report…" }));
    fireEvent.click(screen.getByRole("button", { name: "close drift" }));
    expect(screen.queryByRole("button", { name: "close drift" })).toBeNull();
  });

  it("says when there are no objects", async () => {
    api.getObjects.mockResolvedValue([]);
    renderUi(
      <ObjectTree connId="c1" dbType="mongodb" schema="app_core" query="" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Views, indexes/ }));
    expect(await screen.findByText("None here")).toBeTruthy();
  });

  it("shows the load error and retries on the next expand", async () => {
    api.getObjects.mockRejectedValueOnce(new Error("permission denied"));
    renderUi(
      <ObjectTree connId="c1" dbType="elasticsearch" schema="" query="" />,
    );
    const node = screen.getByRole("button", { name: /Templates, pipelines/ });
    fireEvent.click(node);
    expect(await screen.findByText("permission denied")).toBeTruthy();
    fireEvent.click(node);
    expect(screen.queryByText("permission denied")).toBeNull();
    api.getObjects.mockResolvedValueOnce([
      { schema: "", name: "logs-*", kind: "index_template" },
    ]);
    fireEvent.click(node);
    expect(await screen.findByText("logs-*")).toBeTruthy();
    expect(api.getObjects).toHaveBeenCalledTimes(2);
  });
});

const job = (
  id: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  name,
  enabled: true,
  schedule: "every day",
  ...extra,
});

describe("JobTree", () => {
  it("lists jobs, marks failed and disabled ones, and opens a job", async () => {
    const load = deferred<unknown>();
    api.getJobs.mockReturnValue(load.promise);
    renderUi(<JobTree connId="c1" query="" />);
    const node = screen.getByRole("button", { name: /Scheduled jobs/ });
    fireEvent.click(node);
    fireEvent.click(node);
    fireEvent.click(node);
    expect(api.getJobs).toHaveBeenCalledTimes(1);
    await act(async () =>
      load.resolve({
        available: true,
        jobs: [
          job("1", "nightly_orders", { lastRun: { status: "failed" } }),
          job("2", "purge_customers", {
            enabled: false,
            lastRun: { status: "succeeded" },
          }),
        ],
      }),
    );
    expect(node.textContent).toContain("(2)");
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getAllByTitle("every day")).toHaveLength(2);
    fireEvent.click(screen.getByText("purge_customers"));
    expect(openJobTab).toHaveBeenCalledWith("c1", {
      id: "2",
      name: "purge_customers",
    });
    fireEvent.click(node);
    fireEvent.click(node);
    expect(api.getJobs).toHaveBeenCalledTimes(1);
  });

  it("says when no job matches the search", async () => {
    api.getJobs.mockResolvedValue({
      available: true,
      jobs: [job("1", "nightly_orders")],
    });
    renderUi(<JobTree connId="c1" query="zzz" />);
    fireEvent.click(screen.getByRole("button", { name: /Scheduled jobs/ }));
    expect(
      await screen.findByText("No jobs run against this database"),
    ).toBeTruthy();
  });

  it("names the missing grant", async () => {
    api.getJobs.mockResolvedValue({
      available: false,
      reason: "needs SQLAgentReaderRole",
      jobs: [],
    });
    renderUi(<JobTree connId="c1" query="" />);
    fireEvent.click(screen.getByRole("button", { name: /Scheduled jobs/ }));
    expect(await screen.findByText("needs SQLAgentReaderRole")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Scheduled jobs/ }).textContent,
    ).toBe("Scheduled jobs");
  });

  it("shows a load error", async () => {
    api.getJobs.mockRejectedValue(new Error("timeout"));
    renderUi(<JobTree connId="c1" query="" />);
    fireEvent.click(screen.getByRole("button", { name: /Scheduled jobs/ }));
    expect(await screen.findByText("timeout")).toBeTruthy();
  });

  it("disappears when the database has no job scheduler", async () => {
    api.getJobs.mockResolvedValue({ available: false, jobs: [] });
    renderUi(<JobTree connId="c1" query="" />);
    fireEvent.click(screen.getByRole("button", { name: /Scheduled jobs/ }));
    await waitFor(() =>
      expect(screen.queryByText(/Scheduled jobs/)).toBeNull(),
    );
  });
});
