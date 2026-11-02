// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { notifications } from "@mantine/notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { fireReactHandler } from "../../utils/react-handler.testing";
import { ApiError } from "../../utils/api-client";
import { notifyError } from "../../utils/notify-error";
import { useStore } from "../../store";
import type { ConnectionInfo, WriteRequest } from "../../types";
import { WriteComposer, clearDraft, loadDraft } from "./write-composer";

vi.mock("@monaco-editor/react", () => ({
  default: (p: {
    value: string;
    language: string;
    onChange: (v: string | undefined) => void;
    options: { placeholder: string };
  }) => (
    <textarea
      data-testid="monaco"
      data-language={p.language}
      placeholder={p.options.placeholder}
      value={p.value}
      onChange={(e) => p.onChange(e.target.value)}
    />
  ),
}));

vi.mock("../../utils/notify-error", () => ({ notifyError: vi.fn() }));

vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: {
    analyzeWrite: vi.fn(),
    executeQuery: vi.fn(),
    suggestSelectQuery: vi.fn(),
    reviewWriteDraft: vi.fn(),
  },
}));

const { api } = await import("../../utils/api-client");
const m = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const DEV: ConnectionInfo = {
  id: "c1",
  name: "orders-dev",
  env: "DEV",
  type: "postgres",
  database: "app_core",
};
const QA: ConnectionInfo = {
  id: "c2",
  name: "customers-qa",
  env: "QA",
  type: "mongodb",
};
const ES: ConnectionInfo = {
  id: "c3",
  name: "search",
  env: "QA",
  type: "elasticsearch",
};

const DML = {
  statementCount: 1,
  isMigration: false,
  hasDdl: false,
  requiresNoTransaction: false,
};

const wr = (over: Partial<WriteRequest>): WriteRequest =>
  ({ id: "wr1", status: "PENDING", ...over }) as WriteRequest;

type Props = Parameters<typeof WriteComposer>[0];
function setup(over: Partial<Props> = {}) {
  const props: Props = {
    mode: "create",
    connections: [DEV],
    directEnvs: [],
    writeModeEnabled: true,
    onSubmit: vi.fn().mockResolvedValue(wr({})),
    onSubmitted: vi.fn(),
    ...over,
  };
  const r = renderUi(<WriteComposer {...props} />);
  return { props, ...r };
}

const writeEd = () => screen.getAllByTestId("monaco")[0];
const selectEd = () => screen.getAllByTestId("monaco")[1];
const type = (el: HTMLElement, v: string) =>
  fireEvent.change(el, { target: { value: v } });
const titleInput = () => screen.getByRole("textbox", { name: "Title" });
const btn = (name: string | RegExp) => screen.getByRole("button", { name });

async function fillAll(sel = "SELECT * FROM orders WHERE id = 1") {
  type(titleInput(), "Fix order");
  type(writeEd(), "UPDATE orders SET status = 'x' WHERE id = 1");
  if (sel) type(selectEd(), sel);
  await waitFor(() => expect(m.analyzeWrite).toHaveBeenCalled());
}

beforeEach(() => {
  vi.clearAllMocks();
  act(() => notifications.clean());
  localStorage.clear();
  useStore.setState({ writeHandoff: null });
  m.analyzeWrite.mockResolvedValue(DML);
});

describe("draft storage", () => {
  it("loads, tolerates junk and clears", () => {
    expect(loadDraft()).toBeNull();
    localStorage.setItem("dbpilot_write_draft", "{bad");
    expect(loadDraft()).toBeNull();
    localStorage.setItem("dbpilot_write_draft", '{"title":"t"}');
    expect(loadDraft()).toEqual({ title: "t" });
    clearDraft();
    expect(loadDraft()).toBeNull();
  });

  it("seeds a new request from the saved draft and persists edits", async () => {
    localStorage.setItem(
      "dbpilot_write_draft",
      JSON.stringify({ title: "Old", connectionId: "c2", writeSql: "w" }),
    );
    setup({ connections: [DEV, QA] });
    expect(titleInput()).toHaveProperty("value", "Old");
    expect(writeEd().dataset.language).toBe("javascript");
    type(titleInput(), "New");
    await waitFor(() => expect(loadDraft()?.title).toBe("New"));
  });

  it("ignores a storage quota error", async () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("quota");
      });
    setup();
    type(titleInput(), "x");
    await waitFor(() => expect(spy).toHaveBeenCalled());
    spy.mockRestore();
  });
});

describe("WriteComposer", () => {
  it("guides the author through the required fields", async () => {
    const first = setup({ connections: [], writeModeEnabled: false });
    expect(screen.getByText("Add a title")).toBeTruthy();
    expect(screen.getByText(/Write mode is disabled/)).toBeTruthy();
    expect(writeEd().getAttribute("placeholder")).toMatch(/^UPDATE/);
    type(titleInput(), "T");
    expect(screen.getByText("Pick a connection")).toBeTruthy();
    expect(btn("Review with AI")).toHaveProperty("disabled", true);

    first.unmount();

    // A saved connection that is no longer writable falls back to the first.
    localStorage.setItem(
      "dbpilot_write_draft",
      JSON.stringify({ title: "T", connectionId: "gone" }),
    );
    setup({ connections: [ES] });
    await waitFor(() => expect(writeEd().dataset.language).toBe("plaintext"));
    expect(screen.getByText("Write a statement first")).toBeTruthy();
    type(writeEd(), "POST /x");
    expect(screen.getByText("Add a verify SELECT")).toBeTruthy();
    expect(btn("Submit for approval")).toHaveProperty("disabled", true);
    type(writeEd(), "");
    expect(writeEd()).toHaveProperty("value", "");
  });

  it("runs a direct write and resets the composer", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue(
        wr({ status: "EXECUTED", rowsAffected: 3, transactional: false }),
      );
    const { props } = setup({ directEnvs: ["DEV"], onSubmit });
    expect(screen.getByText("Direct write · runs immediately")).toBeTruthy();
    expect(screen.getByText("app_core")).toBeTruthy();
    type(screen.getByRole("textbox", { name: /Description/ }), "  ticket 42 ");
    await fillAll();
    await userEvent.click(btn("Run write"));
    expect(onSubmit).toHaveBeenCalledWith({
      title: "Fix order",
      description: "ticket 42",
      connectionId: "c1",
      selectSql: "SELECT * FROM orders WHERE id = 1",
      writeSql: "UPDATE orders SET status = 'x' WHERE id = 1",
      note: undefined,
      noTransaction: undefined,
    });
    expect(
      await screen.findByText("3 row(s) affected (non-transactional)"),
    ).toBeTruthy();
    expect(screen.getByText("Write executed")).toBeTruthy();
    expect(props.onSubmitted).toHaveBeenCalled();
    expect(titleInput()).toHaveProperty("value", "");
    expect(loadDraft()).toBeNull();
  });

  it("submits for approval", async () => {
    setup();
    expect(
      screen.getByText("Approval required · second reviewer"),
    ).toBeTruthy();
    await fillAll();
    await userEvent.click(btn("Submit for approval"));
    expect(await screen.findByText("Submitted for approval")).toBeTruthy();
  });

  it("saves a draft without running it", async () => {
    const onSave = vi.fn().mockResolvedValue(wr({ status: "DRAFT" }));
    const onSubmit = vi.fn();
    setup({ onSave, onSubmit });
    await fillAll();
    await userEvent.click(btn("Save request"));
    expect(onSave).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText("Request saved")).toBeTruthy();
  });

  it("reports a failed run", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValueOnce(wr({ status: "FAILED", executionError: "boom" }))
      .mockResolvedValueOnce(wr({ status: "FAILED" }));
    setup({ onSubmit, mode: "revise", initial: {} });
    await fillAll();
    await userEvent.click(btn("Resubmit"));
    expect(await screen.findByText("boom")).toBeTruthy();
    // Revise keeps the fields, so it can be sent again.
    await userEvent.click(btn("Resubmit"));
    expect(await screen.findByText("Execution failed")).toBeTruthy();
  });

  it("treats an unreached database as a saved draft", async () => {
    const back = wr({ status: "DRAFT" });
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("db down", 503, "CONNECTION_FAILED", back),
      )
      .mockRejectedValueOnce(new Error("nope"));
    const { props } = setup({ onSubmit });
    await fillAll();
    await userEvent.click(btn("Submit for approval"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.any(ApiError),
        "Write request",
        { title: "Not run: saved as a draft" },
      ),
    );
    expect(props.onSubmitted).toHaveBeenCalledWith(back);

    await fillAll();
    await userEvent.click(btn("Submit for approval"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenLastCalledWith(
        expect.any(Error),
        "Write request",
        {},
      ),
    );
    expect(props.onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("revises a locked request with a note", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue(wr({ status: "EXECUTED", transactional: true }));
    const onCancel = vi.fn();
    setup({
      mode: "revise",
      lockConnectionId: "c1",
      directEnvs: ["DEV"],
      showNote: true,
      onCancel,
      onSubmit,
      initial: {
        title: "Fix order",
        writeSql: "UPDATE orders SET a = 1",
        selectSql: "SELECT a FROM orders",
      },
    });
    expect(
      screen.getByRole("textbox", { name: "Target connection" }),
    ).toHaveProperty("value", "DEV · orders-dev · postgres");
    type(
      screen.getByRole("textbox", { name: /Note to reviewer/ }),
      " widened ",
    );
    await userEvent.click(btn("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    await userEvent.click(btn("Resubmit"));
    expect(onSubmit.mock.calls[0][0].note).toBe("widened");
    expect(await screen.findByText("Resubmitted & executed")).toBeTruthy();
    expect(screen.getByText("0 row(s) affected")).toBeTruthy();
    // Revise does not clear what the author wrote.
    expect(titleInput()).toHaveProperty("value", "Fix order");
  });

  it("shows the locked id when the connection is gone, and a custom label", async () => {
    const onSubmit = vi.fn().mockResolvedValue(wr({ status: "PENDING" }));
    setup({
      mode: "revise",
      lockConnectionId: "gone",
      submitLabel: "Save draft",
      onSubmit,
      initial: { title: "t", writeSql: "w", selectSql: "s" },
    });
    expect(
      screen.getByRole("textbox", { name: "Target connection" }),
    ).toHaveProperty("value", "gone");
    await userEvent.click(btn("Save draft"));
    expect(await screen.findByText("Resubmitted for approval")).toBeTruthy();
  });

  it("previews the verify SELECT and clears it on change", async () => {
    m.executeQuery
      .mockResolvedValueOnce({
        columns: [{ name: "id" }],
        rows: [{ id: 7 }, { id: 8 }],
        totalRows: 2,
        executionTimeMs: 1,
        masked: false,
        maskedFields: [],
        connectionId: "c1",
        truncated: false,
      })
      .mockRejectedValueOnce(new Error("bad column"));
    setup({ connections: [DEV, QA] });
    type(selectEd(), "  SELECT id FROM orders ");
    await userEvent.click(btn("Run this SELECT"));
    expect(m.executeQuery).toHaveBeenCalledWith(
      "c1",
      "SELECT id FROM orders",
      undefined,
    );
    expect(await screen.findByText("Preview ran · 2 row(s) returned"));
    expect(screen.getByText("7")).toBeTruthy();

    type(selectEd(), "SELECT nope FROM orders");
    expect(screen.queryByText("7")).toBeNull();
    await userEvent.click(btn("Run this SELECT"));
    expect(await screen.findByText("bad column")).toBeTruthy();
    type(selectEd(), "");
    expect(btn("Run this SELECT")).toHaveProperty("disabled", true);

    // Switching the target drops a preview from the other database.
    await userEvent.click(
      screen.getByRole("textbox", { name: "Target connection" }),
    );
    await userEvent.click(
      await screen.findByRole("option", {
        name: /customers-qa/,
        hidden: true,
      }),
    );
    expect(writeEd().dataset.language).toBe("javascript");
  });

  it("generates the verify SELECT from the write", async () => {
    m.suggestSelectQuery
      .mockResolvedValueOnce({ query: "SELECT 1", explanation: "Rows hit" })
      .mockResolvedValueOnce({ query: "SELECT 2" })
      .mockResolvedValueOnce({ query: "" })
      .mockRejectedValueOnce(new Error("ai down"));
    setup();
    type(writeEd(), " UPDATE orders SET a = 1 ");
    await userEvent.click(btn("Generate from write"));
    expect(m.suggestSelectQuery).toHaveBeenLastCalledWith({
      connectionId: "c1",
      writeSql: "UPDATE orders SET a = 1",
      intent: undefined,
      currentSelect: undefined,
    });
    expect(await screen.findByText("Rows hit")).toBeTruthy();
    expect(selectEd()).toHaveProperty("value", "SELECT 1");

    type(screen.getByRole("textbox", { name: /Description/ }), "why");
    await userEvent.click(btn("Generate from write"));
    expect(m.suggestSelectQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({ intent: "why", currentSelect: "SELECT 1" }),
    );
    expect(
      await screen.findByText("Review and edit, then run the preview."),
    ).toBeTruthy();

    await userEvent.click(btn("Generate from write"));
    expect(
      await screen.findByText("The AI did not return a usable SELECT"),
    ).toBeTruthy();

    await userEvent.click(btn("Generate from write"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(
        expect.any(Error),
        "Write request",
      ),
    );
  });

  it("reviews with AI and applies the suggestion", async () => {
    const review = {
      verdict: "CAUTION",
      risks: [],
      summary: "Touches many rows",
      recommendation: "Narrow it",
      suggestedWriteSql: "UPDATE orders SET a = 1 WHERE id = 1",
      suggestedSelectSql: "SELECT a FROM orders WHERE id = 1",
    };
    m.reviewWriteDraft
      .mockResolvedValueOnce(review)
      .mockResolvedValueOnce({ ...review, suggestedSelectSql: undefined })
      .mockResolvedValueOnce({
        ...review,
        suggestedWriteSql: undefined,
        summary: "Second look",
      })
      .mockResolvedValueOnce({ ...review, summary: "Second look" })
      .mockRejectedValueOnce(new Error("ai down"));
    setup();
    type(writeEd(), "UPDATE orders SET a = 1");
    await userEvent.click(btn("Review with AI"));
    expect(m.reviewWriteDraft).toHaveBeenLastCalledWith({
      connectionId: "c1",
      selectSql: undefined,
      writeSql: "UPDATE orders SET a = 1",
    });
    expect(await screen.findByText("Touches many rows")).toBeTruthy();
    await userEvent.click(btn("Apply suggestion"));
    expect(writeEd()).toHaveProperty("value", review.suggestedWriteSql);
    expect(selectEd()).toHaveProperty("value", review.suggestedSelectSql);
    expect(await screen.findByText("Suggestion applied")).toBeTruthy();
    expect(screen.queryByText("Touches many rows")).toBeNull();

    await userEvent.click(btn("Review with AI"));
    expect(m.reviewWriteDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectSql: review.suggestedSelectSql }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Apply suggestion" }),
    );
    expect(selectEd()).toHaveProperty("value", review.suggestedSelectSql);

    await userEvent.click(btn("Review with AI"));
    expect(await screen.findByText("Second look")).toBeTruthy();
    await userEvent.click(btn("Apply suggestion"));
    // Only the SELECT was suggested; the write stays as it was.
    expect(writeEd()).toHaveProperty("value", review.suggestedWriteSql);
    await userEvent.click(btn("Review with AI"));
    expect(await screen.findByText("Second look")).toBeTruthy();
    // Editing the write invalidates the review.
    type(writeEd(), "UPDATE orders SET b = 2");
    expect(screen.queryByText("Second look")).toBeNull();

    await userEvent.click(btn("Review with AI"));
    await waitFor(() => expect(notifyError).toHaveBeenCalled());
  });

  it("switches to migration mode and requires the no-rollback opt-in", async () => {
    m.analyzeWrite.mockResolvedValue({
      statementCount: 2,
      isMigration: true,
      hasDdl: true,
      requiresNoTransaction: true,
    });
    const onSubmit = vi.fn().mockResolvedValue(wr({}));
    setup({ onSubmit });
    type(titleInput(), "Index orders");
    type(writeEd(), "CREATE INDEX CONCURRENTLY a ON orders(a); VACUUM orders;");
    expect(await screen.findByText(/2 statement/)).toBeTruthy();
    expect(screen.getByText(/· DDL/)).toBeTruthy();
    expect(screen.getByText("Migration script")).toBeTruthy();
    expect(screen.queryByText("Verify SELECT")).toBeNull();
    expect(screen.getByText('Enable "Run without rollback"')).toBeTruthy();
    expect(btn("Submit for approval")).toHaveProperty("disabled", true);

    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(btn("Submit for approval"));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      selectSql: "",
      noTransaction: true,
    });
  });

  it("drops a stale opt-in and shows a blocked script", async () => {
    m.analyzeWrite.mockResolvedValueOnce({
      statementCount: 2,
      isMigration: true,
      hasDdl: false,
      requiresNoTransaction: true,
    });
    setup();
    type(titleInput(), "t");
    type(writeEd(), "a; b;");
    await userEvent.click(await screen.findByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);

    m.analyzeWrite.mockResolvedValueOnce({
      statementCount: 1,
      isMigration: true,
      hasDdl: false,
      requiresNoTransaction: false,
      blocked: "DROP DATABASE is not allowed",
    });
    type(writeEd(), "a;");
    expect(await screen.findByText(/1 statement$/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByText("DROP DATABASE is not allowed")).toHaveLength(2);

    m.analyzeWrite.mockResolvedValueOnce({
      statementCount: 2,
      isMigration: true,
      hasDdl: false,
      requiresNoTransaction: true,
    });
    type(writeEd(), "a; b; c;");
    // The opt-in was dropped while it was not needed, so it starts unticked.
    expect(await screen.findByRole("checkbox")).toHaveProperty(
      "checked",
      false,
    );
  });

  it("ignores analysis answers that arrive after the write changed", async () => {
    let resolveFirst!: (v: unknown) => void;
    let rejectSecond!: (e: unknown) => void;
    m.analyzeWrite
      .mockReturnValueOnce(new Promise((r) => (resolveFirst = r)))
      .mockReturnValueOnce(new Promise((_, j) => (rejectSecond = j)))
      .mockRejectedValueOnce(new Error("bad"));
    setup();
    type(writeEd(), "one");
    await waitFor(() => expect(m.analyzeWrite).toHaveBeenCalledTimes(1));
    type(writeEd(), "two");
    await waitFor(() => expect(m.analyzeWrite).toHaveBeenCalledTimes(2));
    type(writeEd(), "three");
    await act(async () => {
      resolveFirst({ ...DML, isMigration: true });
      rejectSecond(new Error("late"));
    });
    await waitFor(() => expect(m.analyzeWrite).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Write statement")).toBeTruthy();
  });

  it("loads a handoff from the read section", async () => {
    setup({ connections: [DEV, QA] });
    act(() =>
      useStore.setState({
        writeHandoff: {
          writeSql: "UPDATE customers SET a = 1",
          selectSql: "SELECT a FROM customers",
          connectionId: "c2",
          title: "Dup",
          description: "copied",
        },
      }),
    );
    expect(
      await screen.findByText("Loaded into the write composer"),
    ).toBeTruthy();
    expect(useStore.getState().writeHandoff).toBeNull();
    expect(titleInput()).toHaveProperty("value", "Dup");
    expect(selectEd()).toHaveProperty("value", "SELECT a FROM customers");
    expect(writeEd().dataset.language).toBe("javascript");

    act(() => useStore.setState({ writeHandoff: { writeSql: "W" } }));
    await waitFor(() => expect(writeEd()).toHaveProperty("value", "W"));
    expect(selectEd()).toHaveProperty("value", "");
    expect(titleInput()).toHaveProperty("value", "Dup");
  });

  it("starts empty when revising without initial values", () => {
    setup({ mode: "revise" });
    expect(titleInput()).toHaveProperty("value", "");
    expect(writeEd()).toHaveProperty("value", "");
  });

  it("leaves the handoff alone when revising", () => {
    useStore.setState({ writeHandoff: { writeSql: "W" } });
    setup({ mode: "revise", initial: { writeSql: "mine" } });
    expect(writeEd()).toHaveProperty("value", "mine");
    expect(useStore.getState().writeHandoff).not.toBeNull();
  });

  // Each guard below sits behind a disabled button; firing the handler
  // directly proves the handler still refuses on its own.
  describe("refuses to act even if a handler fires while its button is disabled", () => {
    it("with nothing filled in", async () => {
      const { props } = setup();
      for (const [name, message] of [
        [
          "Generate from write",
          "Write the statement and pick a connection first",
        ],
        ["Run this SELECT", "Enter a SELECT query and pick a connection"],
        [
          "Review with AI",
          "Enter a write statement and pick a connection first",
        ],
        [
          "Submit for approval",
          "Title, connection, write statement and a verify SELECT are all required",
        ],
      ]) {
        expect(btn(name)).toHaveProperty("disabled", true);
        await fireReactHandler(btn(name));
        expect(await screen.findByText(message)).toBeTruthy();
      }
      expect(m.suggestSelectQuery).not.toHaveBeenCalled();
      expect(m.executeQuery).not.toHaveBeenCalled();
      expect(m.reviewWriteDraft).not.toHaveBeenCalled();
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("with a migration that still needs the no-rollback opt-in", async () => {
      m.analyzeWrite.mockResolvedValue({
        statementCount: 2,
        isMigration: true,
        hasDdl: true,
        requiresNoTransaction: true,
      });
      const { props } = setup();
      type(titleInput(), "Index orders");
      type(
        writeEd(),
        "CREATE INDEX CONCURRENTLY a ON orders(a); VACUUM orders;",
      );
      expect(await screen.findByText("Migration script")).toBeTruthy();
      expect(btn("Submit for approval")).toHaveProperty("disabled", true);
      await fireReactHandler(btn("Submit for approval"));
      expect(
        await screen.findByText(/can't run in a transaction/),
      ).toBeTruthy();

      type(titleInput(), "");
      await fireReactHandler(btn("Submit for approval"));
      expect(
        await screen.findByText(
          "Title, connection and the migration script are required",
        ),
      ).toBeTruthy();
      expect(props.onSubmit).not.toHaveBeenCalled();
    });

    it("with a blocked script", async () => {
      m.analyzeWrite.mockResolvedValue({
        ...DML,
        blocked: "DROP DATABASE is not allowed",
      });
      const { props } = setup();
      await fillAll();
      await waitFor(() =>
        expect(
          screen.getAllByText("DROP DATABASE is not allowed"),
        ).toHaveLength(1),
      );
      expect(btn("Submit for approval")).toHaveProperty("disabled", true);
      await fireReactHandler(btn("Submit for approval"));
      await waitFor(() =>
        expect(
          screen.getAllByText("DROP DATABASE is not allowed"),
        ).toHaveLength(2),
      );
      expect(props.onSubmit).not.toHaveBeenCalled();
    });
  });
});
