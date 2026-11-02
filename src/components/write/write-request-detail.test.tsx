// @vitest-environment jsdom
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, Route, Routes } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteRequest } from "../../types";
import { ApiError } from "../../utils/api-client";
import { renderUi } from "../../utils/dom.testing";
import { fireReactHandler } from "../../utils/react-handler.testing";
import { useStore } from "../../store";
import { WriteRequestDetail } from "./write-request-detail";

const api = vi.hoisted(() => ({
  getWritePolicy: vi.fn(),
  getWriteRequest: vi.fn(),
  getWriteRequests: vi.fn(),
  previewWriteRequest: vi.fn(),
  aiReviewWriteRequest: vi.fn(),
  overrideWriteRequest: vi.fn(),
  approveWriteRequest: vi.fn(),
  rejectWriteRequest: vi.fn(),
  submitWriteRequest: vi.fn(),
  cancelWriteRequest: vi.fn(),
  deleteWriteRequest: vi.fn(),
  reviseWriteRequest: vi.fn(),
}));

vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api,
}));

vi.mock("@monaco-editor/react", () => ({
  default: ({ value }: { value: string }) => <pre>{value}</pre>,
}));

vi.mock("./object-change", () => ({
  ObjectChangeReview: ({ canAuthor }: { canAuthor: boolean }) => (
    <div>object review canAuthor={String(canAuthor)}</div>
  ),
  JobChangeSummary: () => <div>job summary</div>,
}));

const composerProps = vi.hoisted(() => ({ current: null as any }));
vi.mock("./write-composer", () => ({
  WriteComposer: (props: any) => {
    composerProps.current = props;
    return (
      <div>
        <span>composer {props.submitLabel ?? "default"}</span>
        <button
          onClick={async () => {
            await props.onSubmit({
              title: "T2",
              description: "D2",
              selectSql: "SELECT 2",
              writeSql: "UPDATE 2",
              note: "n",
              noTransaction: false,
            });
            props.onSubmitted();
          }}
        >
          composer submit
        </button>
        <button onClick={props.onCancel}>composer cancel</button>
      </div>
    );
  },
}));

function makeWr(over: Partial<WriteRequest> = {}): WriteRequest {
  return {
    id: "w1",
    title: "Fix orders",
    connectionId: "c1",
    connectionName: "app_core",
    env: "QA",
    dbType: "postgres",
    selectSql: "SELECT * FROM orders",
    writeSql: "UPDATE orders SET x = 1",
    status: "PENDING",
    requestedBy: "u1",
    requestedByEmail: "alice@example.com",
    requestedAt: "2026-01-01T00:00:00",
    createdAt: "2026-01-01T00:00:00",
    updatedAt: "2026-01-01T00:00:00",
    ...over,
  };
}

function setUser(over: Record<string, unknown> = {}) {
  useStore.setState({
    user: {
      canWrite: true,
      isAdmin: false,
      writeEnvironments: ["QA"],
      ...over,
    } as any,
  });
}

function render(wr: WriteRequest | Error) {
  if (wr instanceof Error) api.getWriteRequest.mockRejectedValue(wr);
  else api.getWriteRequest.mockResolvedValue(wr);
  return renderUi(
    <Routes>
      <Route path="/write-requests/:id" element={<WriteRequestDetail />} />
      <Route path="/requests" element={<div>requests list</div>} />
      <Route path="/write" element={<div>write page</div>} />
    </Routes>,
    { route: "/write-requests/w1" },
  );
}

const user = userEvent.setup();

beforeEach(() => {
  vi.clearAllMocks();
  notifications.clean();
  notifications.cleanQueue();
  api.getWritePolicy.mockResolvedValue({
    directEnvs: ["DEV"],
    writeModeEnabled: false,
  });
  api.getWriteRequests.mockResolvedValue([
    makeWr({ viewerCanApprove: true }),
    makeWr({ status: "EXECUTED" }),
  ]);
  useStore.setState({ actionRequiredCount: 0, writeHandoff: null });
  setUser();
});

describe("WriteRequestDetail", () => {
  it("shows the load error and goes back", async () => {
    api.getWriteRequest.mockRejectedValue(new Error("boom"));
    renderUi(
      <Routes>
        <Route path="/" element={<Link to="/write-requests/w1">open</Link>} />
        <Route path="/write-requests/:id" element={<WriteRequestDetail />} />
      </Routes>,
    );
    await user.click(screen.getByText("open"));
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByText("Cannot open request")).toBeTruthy();
    await user.click(screen.getByText("Back"));
    expect(await screen.findByText("open")).toBeTruthy();
  });

  it("goes back from a loaded request", async () => {
    api.getWriteRequest.mockResolvedValue(makeWr());
    renderUi(
      <Routes>
        <Route path="/" element={<Link to="/write-requests/w1">open</Link>} />
        <Route path="/write-requests/:id" element={<WriteRequestDetail />} />
      </Routes>,
    );
    await user.click(screen.getByText("open"));
    await user.click(await screen.findByText("Back to requests"));
    expect(await screen.findByText("open")).toBeTruthy();
  });

  it("says not found when the server returns nothing", async () => {
    // An error with no message and no request falls back to a generic line.
    render(new Error(""));
    expect(await screen.findByText("Write request not found")).toBeTruthy();
  });

  it("stays loading without an id", () => {
    renderUi(
      <Routes>
        <Route path="/" element={<WriteRequestDetail />} />
      </Routes>,
    );
    expect(api.getWriteRequest).not.toHaveBeenCalled();
    expect(document.querySelector(".mantine-Loader-root")).toBeTruthy();
  });

  it("tolerates a failed policy fetch", async () => {
    api.getWritePolicy.mockRejectedValue(new Error("nope"));
    render(makeWr({}));
    expect(await screen.findByText("Back to requests")).toBeTruthy();
    expect(api.getWritePolicy).toHaveBeenCalled();
  });

  it("approves a pending request, refreshing the request and nav badge", async () => {
    render(
      makeWr({
        viewerCanApprove: true,
        description: "Bulk fix",
        aiReview: {
          verdict: "SAFE",
          estimatedBlastRadius: "unbounded",
          risks: [],
          summary: "ok",
          recommendation: "go",
        },
        events: [
          {
            id: "e1",
            event: "SUBMITTED",
            actorEmail: "alice@example.com",
            notes: "please",
            timestamp: "2026-01-01T00:00:00Z",
          },
          {
            id: "e2",
            event: "WEIRD",
            actorEmail: "bob@example.com",
            timestamp: "2026-01-01T00:00:00Z",
          },
        ] as any,
      }),
    );
    expect(await screen.findByText("Fix orders")).toBeTruthy();
    expect(screen.getByText("Bulk fix")).toBeTruthy();
    expect(screen.getByText("Pending approval")).toBeTruthy();
    expect(screen.getByText(/AI flagged this write as high-risk/)).toBeTruthy();
    expect(screen.getByText("Re-run AI review")).toBeTruthy();
    expect(screen.getByText(/— please/)).toBeTruthy();
    expect(screen.getByText("WEIRD")).toBeTruthy();
    expect(screen.getByText("Write statement")).toBeTruthy();

    api.approveWriteRequest.mockResolvedValue(makeWr({ rowsAffected: 3 }));
    await user.click(screen.getByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Approve & run write")).toBeTruthy();
    // Dangerous AI verdict turns the confirmation red, but approval notes are optional.
    expect(within(dialog).getByText(/against/).textContent).toContain(
      "write statement",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Approve & run" }),
    );
    await waitFor(() =>
      expect(api.approveWriteRequest).toHaveBeenCalledWith("w1", undefined),
    );
    expect(await screen.findByText("3 row(s) affected")).toBeTruthy();
    await waitFor(() =>
      expect(useStore.getState().actionRequiredCount).toBe(1),
    );
    expect(api.getWriteRequest).toHaveBeenCalledTimes(2);
  });

  it("approves with a note and a default row count", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "  looks good ");
    api.approveWriteRequest.mockResolvedValue(makeWr());
    api.getWriteRequests.mockRejectedValue(new Error("x"));
    await user.click(
      within(dialog).getByRole("button", { name: "Approve & run" }),
    );
    await waitFor(() =>
      expect(api.approveWriteRequest).toHaveBeenCalledWith("w1", "looks good"),
    );
    expect(await screen.findByText("0 row(s) affected")).toBeTruthy();
  });

  it("rejects with a required reason", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Reject"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/can't be undone/)).toBeTruthy();
    const confirm = within(dialog).getByRole("button", {
      name: "Reject request",
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dialog).getByRole("textbox"), "wrong table");
    api.rejectWriteRequest.mockResolvedValue(undefined);
    await user.click(confirm);
    await waitFor(() =>
      expect(api.rejectWriteRequest).toHaveBeenCalledWith("w1", "wrong table"),
    );
    expect(await screen.findByText("Request rejected")).toBeTruthy();
  });

  it("closes the decision modal with Cancel and the close button", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Reject"));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByText("Reject"));
    dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("ignores a confirm that lands while the dialog is closing", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", {
      name: "Approve & run",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Still on screen for the exit transition, but no longer bound to a decision.
    expect(confirm.isConnected).toBe(true);
    await fireReactHandler(confirm);
    expect(api.approveWriteRequest).not.toHaveBeenCalled();
    expect(api.rejectWriteRequest).not.toHaveBeenCalled();
    expect(api.overrideWriteRequest).not.toHaveBeenCalled();
  });

  it("overrides approval as admin for a migration without rollback", async () => {
    setUser({ isAdmin: true });
    render(
      makeWr({
        viewerCanOverride: true,
        isMigration: true,
        noTransaction: true,
        connectionName: undefined,
      }),
    );
    expect(await screen.findByText("Migration script")).toBeTruthy();
    expect(screen.getByText(/RUNS WITHOUT ROLLBACK/)).toBeTruthy();
    expect(screen.queryByText("Verify SELECT")).toBeNull();
    expect(screen.getByText("Waiting for an approver in QA.")).toBeTruthy();
    await user.click(screen.getByText("Override & run"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Admin override:")).toBeTruthy();
    expect(within(dialog).getByText(/runs WITHOUT rollback/)).toBeTruthy();
    expect(within(dialog).getByText("c1")).toBeTruthy();
    await user.type(within(dialog).getByRole("textbox"), "outage");
    api.overrideWriteRequest.mockResolvedValueOnce(makeWr({ rowsAffected: 2 }));
    await user.click(
      within(dialog).getByRole("button", { name: "Override & run" }),
    );
    await waitFor(() =>
      expect(api.overrideWriteRequest).toHaveBeenCalledWith("w1", "outage"),
    );
    expect(
      await screen.findByText("Approval overridden & executed"),
    ).toBeTruthy();
    expect(screen.getByText("2 row(s) affected")).toBeTruthy();

    // Second override: the server reports no rows.
    act(() => notifications.clean());
    await user.click(screen.getByText("Override & run"));
    const again = await screen.findByRole("dialog");
    await user.type(within(again).getByRole("textbox"), "again");
    api.overrideWriteRequest.mockResolvedValueOnce(makeWr());
    await user.click(
      within(again).getByRole("button", { name: "Override & run" }),
    );
    expect(await screen.findByText("0 row(s) affected")).toBeTruthy();
  });

  it("describes a transactional migration in the approval dialog", async () => {
    render(makeWr({ viewerCanApprove: true, isMigration: true }));
    expect(
      await screen.findByText(/runs as one transaction \(rolls back/),
    ).toBeTruthy();
    await user.click(screen.getByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/rolls back atomically if any/),
    ).toBeTruthy();
    expect(within(dialog).getByText(/migration script/)).toBeTruthy();
  });

  it("keeps the dialog open when a decision fails", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    api.approveWriteRequest.mockRejectedValue(new ApiError("denied", 403));
    await user.click(
      within(dialog).getByRole("button", { name: "Approve & run" }),
    );
    expect(await screen.findByText("Action failed")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog when the database was not reached", async () => {
    render(makeWr({ viewerCanApprove: true }));
    await user.click(await screen.findByText("Approve & run"));
    const dialog = await screen.findByRole("dialog");
    api.approveWriteRequest.mockRejectedValue(
      new ApiError("db down", 503, "CONNECTION_FAILED", makeWr()),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Approve & run" }),
    );
    expect(
      await screen.findByText("Not run: still pending approval"),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("runs the verify SELECT and shows rows or the error", async () => {
    render(makeWr());
    const run = await screen.findByText("Run this SELECT");
    expect(screen.getByText(/read-only, changes nothing/)).toBeTruthy();
    api.previewWriteRequest.mockRejectedValueOnce(new Error("bad select"));
    await user.click(run);
    expect(await screen.findByText("bad select")).toBeTruthy();
    api.previewWriteRequest.mockResolvedValueOnce({
      columns: [{ name: "id", type: "int" }],
      rows: [{ id: 7 }],
      totalRows: 1,
      executionTimeMs: 5,
    });
    await user.click(run);
    expect(
      await screen.findByText("Preview ran · 1 row(s) returned"),
    ).toBeTruthy();
    expect(screen.queryByText("bad select")).toBeNull();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("disables preview without read access or a SELECT", async () => {
    render(makeWr({ viewerCanPreview: false }));
    const btn = (await screen.findByText("Run this SELECT")).closest("button")!;
    expect(btn.disabled).toBe(true);
  });

  it("runs an AI review and reports failure", async () => {
    render(makeWr());
    let resolve!: (v: unknown) => void;
    api.aiReviewWriteRequest.mockReturnValueOnce(
      new Promise((r) => (resolve = r)),
    );
    await user.click(await screen.findByText("Review with AI"));
    expect(await screen.findByText(/Analyzing the write/)).toBeTruthy();
    resolve({
      verdict: "DANGEROUS",
      risks: ["drops rows"],
      summary: "risky",
      recommendation: "stop",
    });
    expect(await screen.findByText("drops rows")).toBeTruthy();
    expect(api.getWriteRequest).toHaveBeenCalledTimes(2);

    api.aiReviewWriteRequest.mockRejectedValueOnce(new ApiError("no ai", 400));
    await user.click(screen.getByText("Re-run AI review"));
    expect(await screen.findByText("no ai")).toBeTruthy();
  });

  it("cancels own request and reports a failed cancel", async () => {
    render(makeWr({ viewerIsRequester: true }));
    api.cancelWriteRequest.mockResolvedValueOnce(undefined);
    await user.click(await screen.findByText("Cancel request"));
    expect(await screen.findByText("Request cancelled")).toBeTruthy();
    expect(api.cancelWriteRequest).toHaveBeenCalledWith("w1");
    api.cancelWriteRequest.mockRejectedValueOnce(new ApiError("too late", 409));
    await user.click(screen.getByText("Cancel request"));
    expect(await screen.findByText("too late")).toBeTruthy();
  });

  it("shows an executed outcome without decision bar", async () => {
    setUser({ canWrite: false });
    render(
      makeWr({
        status: "EXECUTED",
        rowsAffected: 4,
        executionMs: 12,
        transactional: false,
        executedByEmail: "bob@example.com",
        executedAt: "2026-01-01T00:00:00",
      }),
    );
    expect(await screen.findByText(/4 row\(s\) affected in 12ms/)).toBeTruthy();
    expect(screen.getByText(/ran non-transactionally/)).toBeTruthy();
    expect(screen.getByText(/executed by bob@example.com/)).toBeTruthy();
    expect(screen.queryByText("Review with AI")).toBeNull();
    expect(screen.queryByText("Duplicate")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
  });

  it("shows executed defaults", async () => {
    render(makeWr({ status: "EXECUTED" }));
    expect(await screen.findByText(/0 row\(s\) affected in 0ms/)).toBeTruthy();
    expect(screen.queryByText(/executed by/)).toBeNull();
  });

  it("shows failed and rejected outcomes with fallbacks", async () => {
    const { unmount } = render(
      makeWr({ status: "FAILED", executionError: "deadlock" }),
    );
    expect(await screen.findByText("deadlock")).toBeTruthy();
    unmount();
    const r2 = render(makeWr({ status: "FAILED" }));
    expect(
      await screen.findByText("The write failed to execute."),
    ).toBeTruthy();
    r2.unmount();
    const r3 = render(
      makeWr({
        status: "REJECTED",
        reviewedByEmail: "carol@example.com",
        reviewNotes: "nope",
      }),
    );
    expect(
      await screen.findByText("Rejected by carol@example.com"),
    ).toBeTruthy();
    expect(screen.getByText("nope")).toBeTruthy();
    r3.unmount();
    render(makeWr({ status: "REJECTED" }));
    expect(await screen.findByText("Rejected by reviewer")).toBeTruthy();
    expect(screen.getByText("No reason provided.")).toBeTruthy();
  });

  it("falls back to the raw status label", async () => {
    render(makeWr({ status: "ARCHIVED" as any }));
    expect(await screen.findByText("ARCHIVED")).toBeTruthy();
  });

  it("submits a draft for approval", async () => {
    render(makeWr({ status: "DRAFT", viewerCanSubmit: true }));
    expect(
      await screen.findByText(/put it in front of an approver/),
    ).toBeTruthy();
    api.submitWriteRequest.mockResolvedValueOnce(makeWr());
    await user.click(screen.getByText("Submit for approval"));
    expect(await screen.findByText("Submitted for approval")).toBeTruthy();
    api.submitWriteRequest.mockRejectedValueOnce(new ApiError("bad", 400));
    await user.click(screen.getByText("Submit for approval"));
    expect(await screen.findByText("bad")).toBeTruthy();
  });

  it("runs a draft on a direct environment", async () => {
    render(
      makeWr({
        status: "DRAFT",
        viewerCanSubmit: true,
        submitRunsImmediately: true,
      }),
    );
    expect(
      await screen.findByText(/it executes under your account/),
    ).toBeTruthy();
    api.submitWriteRequest
      .mockResolvedValueOnce(makeWr({ status: "EXECUTED", rowsAffected: 5 }))
      .mockResolvedValueOnce(makeWr({ status: "EXECUTED" }))
      .mockResolvedValueOnce(
        makeWr({ status: "FAILED", executionError: "syntax" }),
      )
      .mockResolvedValueOnce(makeWr({ status: "FAILED" }))
      .mockRejectedValueOnce(
        new ApiError(
          "db down",
          503,
          "CONNECTION_FAILED",
          makeWr({ status: "DRAFT" }),
        ),
      );
    const run = async () => {
      act(() => notifications.clean());
      await user.click(screen.getByText("Run now"));
    };
    await run();
    expect(await screen.findByText("5 row(s) affected")).toBeTruthy();
    await run();
    expect(await screen.findByText("0 row(s) affected")).toBeTruthy();
    await run();
    expect(await screen.findByText("syntax")).toBeTruthy();
    await run();
    expect(await screen.findByText("Execution failed")).toBeTruthy();
    await run();
    expect(await screen.findByText("Not run: saved as a draft")).toBeTruthy();
  });

  it("tells a viewer without write access who submits a draft", async () => {
    render(makeWr({ status: "DRAFT" }));
    expect(
      await screen.findByText(
        "Waiting for someone with write access to QA to submit it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Submit for approval")).toBeNull();
    expect(screen.queryByText("Edit draft")).toBeNull();
  });

  it("edits a draft through the composer", async () => {
    render(makeWr({ status: "DRAFT", viewerIsRequester: true }));
    await user.click(await screen.findByText("Edit draft"));
    expect(await screen.findByText("composer Save draft")).toBeTruthy();
    expect(composerProps.current).toMatchObject({
      mode: "revise",
      lockConnectionId: "c1",
      directEnvs: ["DEV"],
      writeModeEnabled: false,
      showNote: false,
      connections: [
        { id: "c1", name: "app_core", env: "QA", type: "postgres" },
      ],
    });
    await user.click(screen.getByText("composer cancel"));
    await waitFor(() =>
      expect(screen.queryByText("composer Save draft")).toBeNull(),
    );
  });

  it("revises a rejected request and reloads", async () => {
    setUser({ isAdmin: true });
    render(makeWr({ status: "REJECTED", connectionName: undefined }));
    expect(await screen.findByText("Needs changes")).toBeTruthy();
    await user.click(screen.getByText("Edit & resubmit"));
    expect(await screen.findByText("composer default")).toBeTruthy();
    expect(composerProps.current.connections[0].name).toBe("c1");
    expect(composerProps.current.showNote).toBe(true);
    api.reviseWriteRequest.mockResolvedValue(makeWr());
    await user.click(screen.getByText("composer submit"));
    expect(api.reviseWriteRequest).toHaveBeenCalledWith("w1", {
      title: "T2",
      description: "D2",
      selectSql: "SELECT 2",
      writeSql: "UPDATE 2",
      note: "n",
      noTransaction: false,
    });
    await waitFor(() => expect(api.getWriteRequest).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("composer default")).toBeNull(),
    );
  });

  it("closes the edit modal with Escape", async () => {
    render(makeWr({ status: "CANCELLED", viewerIsRequester: true }));
    await user.click(await screen.findByText("Edit & resubmit"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("deletes a request and returns to the list", async () => {
    render(makeWr({ status: "FAILED", viewerIsRequester: true }));
    await user.click(await screen.findByText("Delete"));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByText("Delete"));
    dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    api.deleteWriteRequest.mockRejectedValueOnce(new ApiError("locked", 409));
    await user.click(screen.getByText("Delete"));
    dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete request" }),
    );
    expect(await screen.findByText("locked")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    api.deleteWriteRequest.mockResolvedValueOnce(undefined);
    await user.click(screen.getByText("Delete"));
    dialog = await screen.findByRole("dialog");
    await user.click(
      within(dialog).getByRole("button", { name: "Delete request" }),
    );
    expect(await screen.findByText("requests list")).toBeTruthy();
    expect(api.deleteWriteRequest).toHaveBeenCalledWith("w1");
  });

  it("duplicates into a new request", async () => {
    render(makeWr({ description: "desc" }));
    await user.click(await screen.findByText("Duplicate"));
    expect(await screen.findByText("write page")).toBeTruthy();
    expect(useStore.getState().writeHandoff).toEqual({
      title: "Copy of Fix orders",
      description: "desc",
      connectionId: "c1",
      selectSql: "SELECT * FROM orders",
      writeSql: "UPDATE orders SET x = 1",
    });
  });

  it("copies the share link", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(makeWr());
    fireEvent.click(await screen.findByText("Copy share link"));
    expect(await screen.findByText("Link copied")).toBeTruthy();
    expect(writeText).toHaveBeenCalled();
  });

  it("delegates an object change to its review", async () => {
    render(
      makeWr({
        kind: "object_change",
        object: { kind: "view", schema: "app_core", name: "v" } as any,
      }),
    );
    expect(
      await screen.findByText("object review canAuthor=true"),
    ).toBeTruthy();
    expect(screen.queryByText("Write statement")).toBeNull();
  });

  it("object change review can't author outside write envs", async () => {
    setUser({ writeEnvironments: undefined });
    render(
      makeWr({
        kind: "object_change",
        object: { kind: "view", schema: "app_core", name: "v" } as any,
      }),
    );
    expect(
      await screen.findByText("object review canAuthor=false"),
    ).toBeTruthy();
  });

  it("shows a job change summary over its generated statement", async () => {
    render(makeWr({ kind: "job_change", jobChange: {} as any }));
    expect(await screen.findByText("job summary")).toBeTruthy();
    expect(screen.getByText("Generated statement")).toBeTruthy();
    expect(screen.getByText(/written by D-Pilot/)).toBeTruthy();
  });

  it("omits the job summary when the change is missing", async () => {
    setUser({ isAdmin: true, writeEnvironments: [] });
    render(makeWr({ kind: "job_change" }));
    expect(await screen.findByText("Generated statement")).toBeTruthy();
    expect(screen.queryByText("job summary")).toBeNull();
  });
});
