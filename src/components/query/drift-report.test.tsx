// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { api } from "../../utils/api-client";
import { useStore } from "../../store";
import type { ConnectionInfo, DriftReport } from "../../types";
import { DriftReportModal } from "./drift-report";

vi.mock("../../utils/api-client", async (orig) => {
  const mod = await orig<typeof import("../../utils/api-client")>();
  return { ...mod, api: { getDrift: vi.fn() } };
});

const getDrift = vi.mocked(api.getDrift);
const openObjectTab = vi.fn();
const onClose = vi.fn();

const connections: ConnectionInfo[] = [
  { id: "qa", name: "app_core QA", env: "QA", type: "postgres" },
  { id: "prod", name: "app_core PROD", env: "PROD", type: "postgres" },
  { id: "dev", name: "app_core DEV", env: "DEV", type: "postgres" },
  { id: "mongo", name: "docs", env: "QA", type: "mongodb" },
];

const report: DriftReport = {
  schema: "app_core",
  identical: 5,
  items: [
    {
      schema: "app_core",
      name: "calc",
      kind: "function",
      args: "integer",
      status: "different",
    },
    { schema: "app_core", name: "v_orders", kind: "view", status: "only_left" },
    {
      schema: "app_core",
      name: "trg",
      kind: "trigger",
      parent: "customers",
      status: "only_right",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ connections, openObjectTab });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pickConnection(label: string) {
  fireEvent.click(screen.getByRole("textbox", { name: "Compare with" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

const renderModal = (connId = "qa", schema = "app_core") =>
  renderUi(
    <DriftReportModal
      connId={connId}
      schema={schema}
      opened
      onClose={onClose}
    />,
  );

describe("DriftReportModal", () => {
  it("offers only other connections of the same type", () => {
    renderModal();
    expect(
      screen.getByText("Drift report — app_core QA · app_core"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("textbox", { name: "Compare with" }));
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["PROD · app_core PROD", "DEV · app_core DEV"]);
  });

  it("lists differences and opens each where it exists, diffed against the other side", async () => {
    getDrift.mockResolvedValue(report);
    renderModal();
    pickConnection("PROD · app_core PROD");
    expect(getDrift).toHaveBeenCalledWith("qa", "prod", "app_core");
    await waitFor(() =>
      expect(screen.getByText("3 differ, 5 identical.")).toBeTruthy(),
    );
    expect(screen.getByText("(integer)", { exact: false })).toBeTruthy();
    expect(screen.getByText(/on customers/)).toBeTruthy();
    expect(screen.getByText("differs")).toBeTruthy();
    expect(screen.getByText("only on app_core QA")).toBeTruthy();
    expect(screen.getByText("only on app_core PROD")).toBeTruthy();

    // A one-sided right object opens on the other connection.
    fireEvent.click(screen.getByText("trg"));
    const { status: _s, ...trg } = report.items[2];
    expect(openObjectTab).toHaveBeenLastCalledWith("prod", trg, "qa");
    expect(onClose).toHaveBeenCalledTimes(1);

    // Keyboard on the name opens a both-sided object here.
    fireEvent.keyDown(screen.getByLabelText("Compare calc"), { key: "Enter" });
    const { status: _t, ...calc } = report.items[0];
    expect(openObjectTab).toHaveBeenLastCalledWith("qa", calc, "prod");
  });

  it("says when everything matches, and passes no schema when none is set", async () => {
    getDrift.mockResolvedValue({ schema: "", identical: 4, items: [] });
    renderModal("qa", "");
    expect(screen.getByText("Drift report — app_core QA")).toBeTruthy();
    pickConnection("DEV · app_core DEV");
    expect(getDrift).toHaveBeenCalledWith("qa", "dev", undefined);
    await waitFor(() =>
      expect(
        screen.getByText("All 4 objects are identical on app_core DEV."),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows an error, and clears the report when the pick is cleared", async () => {
    getDrift.mockRejectedValueOnce(new Error("permission denied"));
    renderModal();
    pickConnection("PROD · app_core PROD");
    await waitFor(() =>
      expect(screen.getByText("permission denied")).toBeTruthy(),
    );
    // Picking the same option again deselects it.
    fireEvent.click(screen.getByRole("textbox", { name: "Compare with" }));
    fireEvent.click(
      screen.getByRole("option", {
        name: "PROD · app_core PROD",
        hidden: true,
      }),
    );
    expect(screen.queryByText("permission denied")).toBeNull();
    expect(getDrift).toHaveBeenCalledTimes(1);
  });

  it("ignores an earlier answer that arrives after a later pick", async () => {
    const first = deferred<DriftReport>();
    const second = deferred<DriftReport>();
    getDrift
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    renderModal();
    pickConnection("PROD · app_core PROD");
    pickConnection("DEV · app_core DEV");
    first.resolve(report);
    await first.promise;
    await Promise.resolve();
    expect(screen.queryByText(/differ,/)).toBeNull();
    second.resolve({ schema: "app_core", identical: 9, items: [] });
    await waitFor(() =>
      expect(
        screen.getByText("All 9 objects are identical on app_core DEV."),
      ).toBeTruthy(),
    );
  });

  it("ignores an earlier failure that arrives after a later pick", async () => {
    const first = deferred<DriftReport>();
    getDrift
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ schema: "app_core", identical: 2, items: [] });
    renderModal();
    pickConnection("PROD · app_core PROD");
    pickConnection("DEV · app_core DEV");
    await waitFor(() =>
      expect(
        screen.getByText("All 2 objects are identical on app_core DEV."),
      ).toBeTruthy(),
    );
    first.reject(new Error("stale failure"));
    await first.promise.catch(() => {});
    await Promise.resolve();
    expect(screen.queryByText("stale failure")).toBeNull();
  });

  it("falls back to the connection id when the connection is unknown", () => {
    renderModal("gone", "app_core");
    expect(screen.getByText("Drift report — gone · app_core")).toBeTruthy();
  });
});
