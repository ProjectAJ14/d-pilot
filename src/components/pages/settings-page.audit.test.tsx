// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile } from "../../utils/download-file";
import { dialog, mockApi, renderSettings, user } from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);
vi.mock("../../utils/download-file", () => ({ downloadTextFile: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
});

const exposed = {
  id: "a1",
  userId: "u1",
  userEmail: "alice@example.com",
  action: "PHI_UNMASK",
  sql: "SELECT email FROM customers",
  connectionId: "app_core-dev",
  rowsReturned: 4,
  executionMs: 12,
  phiAccessed: true,
  phiFieldsUnmasked: ["email", "phone"],
  phiUnmaskReason: "Support ticket",
  phiUnmaskNotes: "Customer asked",
  source: "mcp",
  timestamp: "2026-06-05T10:00:00",
};
const denied = {
  id: "a2",
  userId: "u2",
  userEmail: "bob@example.com",
  action: "PHI_UNMASK_DENIED",
  phiAccessed: false,
  source: "api",
  timestamp: "2026-06-05T11:00:00",
};
const custom = {
  id: "a3",
  userId: "u3",
  userEmail: "carol@example.com",
  action: "CUSTOM_EVENT",
  phiAccessed: false,
  phiFieldsUnmasked: [],
  source: "ui",
  timestamp: "2026-06-05T12:00:00",
};
const plain = {
  id: "a4",
  userId: "u3",
  userEmail: "carol@example.com",
  action: "QUERY_EXECUTE",
  phiAccessed: false,
  timestamp: "2026-06-05T13:00:00",
};

const page = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({
    ...plain,
    id: `p${start + i}`,
  }));

const btn = (name: string | RegExp) => screen.getByRole("button", { name });

async function pick(label: string | RegExp, option: string | RegExp) {
  const u = user();
  await u.click(screen.getByDisplayValue(label));
  await u.click(
    (await screen.findAllByRole("option", { name: option, hidden: true }))[0],
  );
}

describe("Audit log tab", () => {
  it("lists entries with labels, PHI state and detail modal", async () => {
    mockApi.getAuditLog.mockResolvedValue([exposed, denied, custom, plain]);
    renderSettings("audit");
    const u = user();
    expect(await screen.findByText("Events 1–4")).toBeTruthy();
    expect(screen.getByText("PHI Unmasked")).toBeTruthy();
    expect(screen.getByText("Unmask Denied")).toBeTruthy();
    expect(screen.getByText("CUSTOM_EVENT")).toBeTruthy();
    expect(screen.getByText("EXPOSED")).toBeTruthy();
    expect(screen.getByText("DENIED")).toBeTruthy();
    expect(screen.getByText("12ms")).toBeTruthy();
    expect(mockApi.getAuditLog).toHaveBeenCalledWith({
      action: undefined,
      phi: false,
      limit: 101,
      offset: 0,
      from: undefined,
      to: undefined,
    });

    await u.click(screen.getByText("alice@example.com"));
    let d = await dialog();
    expect(d.getByText("MCP agent")).toBeTruthy();
    expect(d.getByText("app_core-dev")).toBeTruthy();
    expect(d.getByText("SELECT email FROM customers")).toBeTruthy();
    expect(d.getByText("PHI Data Exposed")).toBeTruthy();
    expect(d.getByText("phone")).toBeTruthy();
    expect(d.getByText("Support ticket")).toBeTruthy();
    expect(d.getByText("Customer asked")).toBeTruthy();
    expect(d.getByText("12ms")).toBeTruthy();
    await u.click(d.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await u.click(screen.getByText("bob@example.com"));
    d = await dialog();
    expect(d.getByText("API client")).toBeTruthy();
    expect(d.getByText("PHI Unmask Denied")).toBeTruthy();
    expect(d.queryByText("Connection")).toBeNull();
    // Clicking the same row again toggles the detail closed.
    await u.click(screen.getAllByText("bob@example.com")[0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await u.click(screen.getByText("CUSTOM_EVENT"));
    d = await dialog();
    expect(d.getByText("D-Pilot UI")).toBeTruthy();
    expect(d.queryByText("PHI Data Exposed")).toBeNull();
    await u.click(d.getByRole("button", { name: "Close" }));

    await u.click(screen.getByText("Query"));
    d = await dialog();
    expect(d.queryByText("Via")).toBeNull();
  });

  it("shows the empty state and reports a load failure", async () => {
    mockApi.getAuditLog.mockResolvedValueOnce([]);
    renderSettings("audit");
    expect(await screen.findByText("No audit entries found")).toBeTruthy();
    expect(screen.getByText("No events")).toBeTruthy();
    mockApi.getAuditLog.mockRejectedValueOnce(new Error("audit down"));
    await user().click(btn("Refresh"));
    expect(await screen.findByText("audit down")).toBeTruthy();
  });

  it("filters by action, PHI and date range", async () => {
    mockApi.getAuditLog.mockResolvedValue([plain]);
    renderSettings("audit");
    const u = user();
    await screen.findByText("Events 1–1");

    await pick("All events", "PHI access only");
    await u.click(btn("Search"));
    await waitFor(() =>
      expect(mockApi.getAuditLog).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: undefined, phi: true }),
      ),
    );

    await pick("PHI access only", "Errors only");
    fireEvent.change(screen.getByPlaceholderText("From"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByPlaceholderText("To"), {
      target: { value: "2026-06-05" },
    });
    await u.click(btn("Search"));
    await waitFor(() =>
      expect(mockApi.getAuditLog).toHaveBeenLastCalledWith({
        action: "QUERY_ERROR",
        phi: false,
        limit: 101,
        offset: 0,
        from: "2026-06-01",
        to: "2026-06-05T23:59:59",
      }),
    );

    // Picking the selected option again clears the filter back to "all".
    await pick("Errors only", "Errors only");
    expect(screen.getByDisplayValue("All events")).toBeTruthy();

    await u.click(btn("Clear"));
    expect(
      (screen.getByPlaceholderText("From") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("exports the chosen date range as CSV", async () => {
    mockApi.getAuditLog.mockResolvedValue([plain]);
    renderSettings("audit");
    const u = user();
    await screen.findByText("Events 1–1");
    expect((btn(/Export CSV/) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("From"), {
      target: { value: "2026-06-01" },
    });
    fireEvent.change(screen.getByPlaceholderText("To"), {
      target: { value: "2026-06-05" },
    });
    mockApi.exportAuditLog.mockResolvedValueOnce("id,action");
    await u.click(btn(/Export CSV/));
    await waitFor(() =>
      expect(downloadTextFile).toHaveBeenCalledWith(
        "audit-log-live-2026-06-01-to-2026-06-05.csv",
        "id,action",
      ),
    );
    expect(mockApi.exportAuditLog).toHaveBeenCalledWith({
      action: undefined,
      phi: false,
      from: "2026-06-01",
      to: "2026-06-05",
      source: "live",
    });
    mockApi.exportAuditLog.mockRejectedValueOnce(new Error("range too long"));
    await u.click(btn(/Export CSV/));
    expect(await screen.findByText("Export failed")).toBeTruthy();
  });

  it("archives old entries and reloads only when something moved", async () => {
    mockApi.getAuditLog.mockResolvedValue([plain]);
    renderSettings("audit");
    const u = user();
    await screen.findByText("Events 1–1");
    mockApi.triggerArchive.mockResolvedValueOnce({
      message: "Nothing to archive",
      archived: 0,
    });
    await u.click(btn("Archive Now"));
    expect(await screen.findByText("Nothing to archive")).toBeTruthy();
    expect(mockApi.getAuditLog).toHaveBeenCalledTimes(1);

    mockApi.triggerArchive.mockResolvedValueOnce({
      message: "Archived 5 entries",
      archived: 5,
    });
    await u.click(btn("Archive Now"));
    expect(await screen.findByText("Archived 5 entries")).toBeTruthy();
    await waitFor(() => expect(mockApi.getAuditLog).toHaveBeenCalledTimes(2));

    mockApi.triggerArchive.mockRejectedValueOnce(new Error("archive failed"));
    await u.click(btn("Archive Now"));
    expect(await screen.findByText("archive failed")).toBeTruthy();
  });

  it("reads from the archive and pages through results", async () => {
    mockApi.getAuditLog.mockResolvedValue([plain]);
    mockApi.getArchiveLog
      .mockResolvedValueOnce(page(101))
      .mockResolvedValueOnce(page(3, 100))
      .mockResolvedValueOnce(page(101))
      .mockResolvedValue(page(101));
    renderSettings("audit");
    const u = user();
    await screen.findByText("Events 1–1");

    await pick("Live log", "Archive (30d+)");
    expect(await screen.findByText("Events 1–100 (from archive)")).toBeTruthy();
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect((btn("Previous") as HTMLButtonElement).disabled).toBe(true);

    await u.click(btn("Next"));
    expect(
      await screen.findByText("Events 101–103 (from archive)"),
    ).toBeTruthy();
    expect(mockApi.getArchiveLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 100 }),
    );
    expect((btn("Next") as HTMLButtonElement).disabled).toBe(true);

    await u.click(btn("Previous"));
    expect(await screen.findByText("Events 1–100 (from archive)")).toBeTruthy();

    // Deselecting the source falls back to the live log.
    await pick("Archive (30d+)", "Archive (30d+)");
    expect(await screen.findByText("Events 1–1")).toBeTruthy();
  });
});
