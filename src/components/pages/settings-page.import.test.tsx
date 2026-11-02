// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dialog, mockApi, renderSettings, user } from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);
vi.mock("../../utils/app-config", () => ({
  loadAppConfig: vi.fn().mockResolvedValue(undefined),
  loadConnections: vi.fn().mockResolvedValue(undefined),
}));

const rows = [
  {
    id: "orders-qa",
    name: "Orders QA",
    env: "QA",
    type: "postgres",
    host: "db.local",
    port: 5432,
    database: "orders",
    password: "pw",
  },
  { name: "Mongo", env: "DEV", type: "mongodb", uri: "mongodb://x" },
  { id: "plain", name: "Plain", type: "mssql", host: "sql.local" },
];

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  mockApi.getAdminConnections.mockResolvedValue([]);
});

async function openImport() {
  renderSettings("connections");
  await screen.findByText(/No connections yet/);
  await user().click(screen.getByRole("button", { name: "Import" }));
  const d = await dialog();
  const area = d.getByLabelText("Connections JSON");
  const paste = (text: string) =>
    fireEvent.change(area, { target: { value: text } });
  return { d, paste };
}

describe("Import connections", () => {
  it("previews rows, validates on the server, and imports", async () => {
    mockApi.checkConnectionImport.mockResolvedValue({ errors: [] });
    const { d, paste } = await openImport();
    const u = user();
    expect(
      (d.getByRole("button", { name: /^Import/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    paste(JSON.stringify(rows));
    // Preview follows the text at once; the check waits for a pause.
    expect(d.getByText("Validating…")).toBeTruthy();
    expect(d.getAllByText("Checking…")).toHaveLength(3);
    expect(d.getByText("db.local:5432 / orders")).toBeTruthy();
    expect(d.getByText("URI")).toBeTruthy();
    expect(d.getByText("sql.local")).toBeTruthy();
    expect(d.getByText("—")).toBeTruthy(); // the row without an id

    expect(await d.findByText("3 connections ready")).toBeTruthy();
    expect(mockApi.checkConnectionImport).toHaveBeenCalledWith(rows);
    expect(d.getAllByText("Ready")).toHaveLength(3);

    mockApi.importConnections.mockRejectedValueOnce(new Error("id taken"));
    await u.click(d.getByRole("button", { name: "Import 3" }));
    expect(await d.findByText("id taken")).toBeTruthy();

    mockApi.importConnections.mockResolvedValueOnce([{}, {}, {}]);
    await u.click(d.getByRole("button", { name: "Import 3" }));
    expect(await screen.findByText("Imported 3 connections")).toBeTruthy();
    expect(mockApi.importConnections).toHaveBeenLastCalledWith(rows);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.getAdminConnections).toHaveBeenCalledTimes(2);
  });

  it("imports a single object, with singular wording", async () => {
    mockApi.checkConnectionImport.mockResolvedValue({ errors: [] });
    const { d, paste } = await openImport();
    paste(JSON.stringify({ id: "nohost", name: "No host", type: "mssql" }));
    expect(await d.findByText("1 connection ready")).toBeTruthy();
    // No host and no URI: the target column says so.
    expect(d.getByText("—")).toBeTruthy();
    mockApi.importConnections.mockResolvedValueOnce([{}]);
    await user().click(d.getByRole("button", { name: "Import 1" }));
    expect(await screen.findByText("Imported 1 connection")).toBeTruthy();
  });

  it("shows per-row errors and syntax errors", async () => {
    mockApi.checkConnectionImport.mockResolvedValue({
      errors: [{ index: 1, error: "uri: unsupported" }],
    });
    const { d, paste } = await openImport();
    paste(JSON.stringify(rows));
    expect(await d.findByText("1 of 3 rows need fixing")).toBeTruthy();
    expect(d.getByText("uri: unsupported")).toBeTruthy();
    expect(
      (d.getByRole("button", { name: /^Import/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // The failing row cannot be tested.
    expect(
      (
        d.getByRole("button", {
          name: "Test connection 2",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    paste(JSON.stringify([rows[1]]));
    expect(await d.findByText("1 of 1 row need fixing")).toBeTruthy();

    paste("[1, 2,]");
    expect(await d.findByText(/Trailing comma/)).toBeTruthy();
    paste("   ");
    await waitFor(() => expect(d.queryByText(/Trailing comma/)).toBeNull());
  });

  it("shows a failed server check and ignores a stale one", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    let rejectThird: (e: Error) => void = () => {};
    mockApi.checkConnectionImport
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockRejectedValueOnce(new Error("check failed"))
      .mockImplementationOnce(
        () => new Promise((_, rej) => (rejectThird = rej)),
      )
      .mockResolvedValue({ errors: [] });
    const { d, paste } = await openImport();
    paste(JSON.stringify(rows[0]));
    await waitFor(() =>
      expect(mockApi.checkConnectionImport).toHaveBeenCalledTimes(1),
    );
    paste(JSON.stringify(rows[2]));
    expect(await d.findByText("check failed")).toBeTruthy();
    // The first check answering late is dropped.
    resolveFirst({ errors: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(d.getByText("check failed")).toBeTruthy();
    expect(d.queryByText("Ready")).toBeNull();

    // A failure that lands after the text changed is dropped too.
    paste(JSON.stringify(rows[0]));
    await waitFor(() =>
      expect(mockApi.checkConnectionImport).toHaveBeenCalledTimes(3),
    );
    paste(JSON.stringify(rows[1]));
    expect(await d.findByText("1 connection ready")).toBeTruthy();
    rejectThird(new Error("late"));
    await new Promise((r) => setTimeout(r, 0));
    expect(d.queryByText("late")).toBeNull();
    expect(d.getByText("1 connection ready")).toBeTruthy();
  });

  it("tests rows one by one and all at once", async () => {
    mockApi.checkConnectionImport.mockResolvedValue({
      errors: [{ index: 2, error: "type: unknown" }],
    });
    const { d, paste } = await openImport();
    const u = user();
    paste(JSON.stringify(rows));
    await d.findByText("1 of 3 rows need fixing");

    let finish: (v: unknown) => void = () => {};
    mockApi.testConnectionDraft.mockReturnValueOnce(
      new Promise((r) => (finish = r)),
    );
    await u.click(d.getByRole("button", { name: "Test connection orders-qa" }));
    expect(d.getByLabelText("Testing")).toBeTruthy();
    // The pasted id is never sent: the draft is unsaved.
    const { id: _id, ...body } = rows[0];
    expect(mockApi.testConnectionDraft).toHaveBeenCalledWith(body);
    finish({ ok: true });
    expect(await d.findByText("Connected")).toBeTruthy();

    mockApi.testConnectionDraft
      .mockResolvedValueOnce({ ok: false, error: "refused" })
      .mockResolvedValueOnce({ ok: false });
    await u.click(d.getByRole("button", { name: "Test all" }));
    await waitFor(() =>
      expect(mockApi.testConnectionDraft).toHaveBeenCalledTimes(3),
    );
    expect(await d.findByLabelText("Failed: refused")).toBeTruthy();
    expect(d.getByLabelText("Failed: Failed")).toBeTruthy();
    expect(d.getByText("2 connections failed its test")).toBeTruthy();

    mockApi.testConnectionDraft.mockRejectedValueOnce(new Error("timeout"));
    await u.click(d.getByRole("button", { name: "Test connection 2" }));
    expect(await d.findByLabelText("Failed: timeout")).toBeTruthy();

    mockApi.testConnectionDraft.mockResolvedValueOnce({ ok: true });
    await u.click(d.getByRole("button", { name: "Test connection orders-qa" }));
    await waitFor(() =>
      expect(d.getByText("1 connection failed its test")).toBeTruthy(),
    );
  });

  it("drops a test result that lands after the text changed", async () => {
    mockApi.checkConnectionImport.mockResolvedValue({ errors: [] });
    const { d, paste } = await openImport();
    const u = user();
    paste(JSON.stringify(rows[0]));
    await d.findByText("1 connection ready");
    let finish: (v: unknown) => void = () => {};
    mockApi.testConnectionDraft.mockReturnValueOnce(
      new Promise((r) => (finish = r)),
    );
    await u.click(d.getByRole("button", { name: "Test connection orders-qa" }));
    paste(JSON.stringify([rows[0], rows[2]]));
    finish({ ok: true });
    expect(await d.findByText("2 connections ready")).toBeTruthy();
    expect(d.queryByText("Connected")).toBeNull();
    await u.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
