// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialog, mockApi, renderSettings, user } from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);

const full = {
  id: "g1",
  userId: "u1",
  userEmail: "alice@example.com",
  connectionId: "app_core-dev",
  dbType: "postgres",
  prompt: "count orders per customer",
  systemPrompt: "You write SQL.",
  userMessage: "schema: orders\nrequest: count",
  responseRaw: '{"sql":"SELECT 1"}',
  generatedQuery: "SELECT customer_id, count(*) FROM orders GROUP BY 1",
  explanation: "Groups orders by customer",
  model: "gpt-4o",
  promptTokens: 100,
  completionTokens: 20,
  totalTokens: 120,
  latencyMs: 900,
  status: "success",
  schemaTruncated: true,
  tablesProvided: 5,
  totalTables: 40,
  timestamp: "2026-06-05T10:00:00",
};
const failed = {
  id: "g2",
  userId: "u2",
  userEmail: "bob@example.com",
  connectionId: "orders-qa",
  prompt: "drop everything",
  status: "error",
  errorMessage: "Refused by policy",
  totalTokens: 7,
  tablesProvided: 3,
  timestamp: "2026-06-05T11:00:00",
};
const minimal = {
  id: "g3",
  userId: "u3",
  userEmail: "carol@example.com",
  prompt: "hello",
  status: "error",
  timestamp: "2026-06-05T12:00:00",
};

const originalClipboard = Object.getOwnPropertyDescriptor(
  navigator,
  "clipboard",
);

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
});
afterEach(() => {
  if (originalClipboard)
    Object.defineProperty(navigator, "clipboard", originalClipboard);
});

const btn = (name: string | RegExp) => screen.getByRole("button", { name });

async function openLog(list: unknown[] = [full, failed, minimal]) {
  mockApi.getAiChatLog.mockResolvedValue(list);
  renderSettings("ai-log");
  await waitFor(() => expect(mockApi.getAiChatLog).toHaveBeenCalled());
}

describe("AI chat log tab", () => {
  it("lists generations with status, tokens and latency", async () => {
    await openLog();
    expect(await screen.findByText("3 generations")).toBeTruthy();
    expect(mockApi.getAiChatLog).toHaveBeenCalledWith({ limit: 500 });
    expect(screen.getByText("count orders per customer")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("900ms")).toBeTruthy();
    const row = screen.getByText("hello").closest("tr")!;
    expect(within(row).getAllByText("—")).toHaveLength(2);
  });

  it("shows the empty state and singular count, and reports failures", async () => {
    await openLog([]);
    expect(
      await screen.findByText("No AI generations logged yet"),
    ).toBeTruthy();
    expect(screen.getByText("0 generations")).toBeTruthy();
    mockApi.getAiChatLog.mockResolvedValueOnce([minimal]);
    await user().click(btn("Refresh"));
    expect(await screen.findByText("1 generation")).toBeTruthy();
    mockApi.getAiChatLog.mockRejectedValueOnce(new Error("log down"));
    await user().click(btn("Search"));
    expect(await screen.findByText("log down")).toBeTruthy();
  });

  it("filters by outcome and date range", async () => {
    await openLog([]);
    const u = user();
    await screen.findByText("No AI generations logged yet");
    await u.click(screen.getByDisplayValue("All outcomes"));
    await u.click(
      (
        await screen.findAllByRole("option", {
          name: "Errors only",
          hidden: true,
        })
      )[0],
    );
    const [from, to] = Array.from(
      document.querySelectorAll('input[type="date"]'),
    );
    fireEvent.change(from, { target: { value: "2026-06-01" } });
    fireEvent.change(to, { target: { value: "2026-06-05" } });
    await u.click(btn("Search"));
    await waitFor(() =>
      expect(mockApi.getAiChatLog).toHaveBeenLastCalledWith({
        limit: 500,
        from: "2026-06-01",
        to: "2026-06-05T23:59:59",
        status: "error",
      }),
    );
    // Picking the selected outcome again resets it to all.
    await u.click(screen.getByDisplayValue("Errors only"));
    await u.click(
      (
        await screen.findAllByRole("option", {
          name: "Errors only",
          hidden: true,
        })
      )[0],
    );
    expect(screen.getByDisplayValue("All outcomes")).toBeTruthy();
    await u.click(btn("Clear"));
    expect((from as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("opens the full detail of a generation", async () => {
    await openLog();
    const u = user();
    await u.click(await screen.findByText("count orders per customer"));
    const d = await dialog();
    expect(d.getByText("gpt-4o")).toBeTruthy();
    expect(d.getByText("app_core-dev · postgres")).toBeTruthy();
    expect(d.getByText("120 total (100 in / 20 out)")).toBeTruthy();
    expect(d.getByText("5/40 tables (truncated)")).toBeTruthy();
    expect(
      d.getByText("Groups orders by customer", { selector: "div" }),
    ).toBeTruthy();
    expect(d.getAllByText(/1 line$/).length).toBeGreaterThan(0);
    expect(d.getByText(/2 lines$/)).toBeTruthy();

    // Collapsible blocks start closed and toggle on their header.
    const header = d.getByText("System Prompt (instructions)");
    const chevron = () =>
      header.parentElement!.querySelector("svg")!.getAttribute("style");
    expect(chevron()).toContain("transform: none");
    await u.click(header);
    expect(chevron()).toContain("rotate(90deg)");
    await u.click(header);
    // A non-collapsible header does nothing on click.
    await u.click(d.getByText("Generated Query"));

    await u.click(d.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the error and leaves out what is missing", async () => {
    await openLog();
    const u = user();
    await u.click(await screen.findByText("drop everything"));
    let d = await dialog();
    expect(d.getByText("Refused by policy")).toBeTruthy();
    expect(d.getByText("orders-qa")).toBeTruthy();
    expect(d.getByText("7 total")).toBeTruthy();
    expect(d.getByText("3 tables")).toBeTruthy();
    expect(d.queryByText("Model")).toBeNull();
    expect(d.queryByText("Generated Query")).toBeNull();
    await u.click(d.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await u.click(screen.getByText("hello"));
    d = await dialog();
    expect(d.queryByText("Connection")).toBeNull();
    expect(d.queryByText("Latency")).toBeNull();
    expect(d.queryByText("Tokens")).toBeNull();
    expect(d.queryByText("Schema")).toBeNull();
  });

  it("copies a block via the clipboard API, or the legacy fallback", async () => {
    await openLog();
    const u = user();
    await u.click(await screen.findByText("count orders per customer"));
    const d = await dialog();
    const copyFor = (label: string) =>
      within(
        d.getByText(label).closest(".mantine-Group-root")!
          .parentElement as HTMLElement,
      ).getAllByRole("button")[0];

    await u.click(copyFor("Generated Query"));
    expect(await screen.findByText("Copied to clipboard")).toBeTruthy();
    expect(await navigator.clipboard.readText()).toBe(full.generatedQuery);

    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await u.click(copyFor("Explanation"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(full.explanation),
    );

    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      value: execCommand,
      configurable: true,
    });
    await u.click(copyFor("User Prompt (plain English)"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("body > textarea")).toBeNull();
  });
});
