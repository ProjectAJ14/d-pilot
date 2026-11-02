// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifications } from "@mantine/notifications";
import { renderUi } from "../../utils/dom.testing";
import { api } from "../../utils/api-client";
import type { WriteRequest } from "../../types";
import { JobChangeSummary, ObjectChangeReview } from "./object-change";

vi.mock("@monaco-editor/react", () => ({
  default: () => null,
  DiffEditor: (p: { original: string; modified: string; language: string }) => (
    <div data-testid="diff" data-lang={p.language}>
      <pre data-testid="original">{p.original}</pre>
      <pre data-testid="modified">{p.modified}</pre>
    </div>
  ),
}));

vi.mock("../../utils/api-client", async (orig) => {
  const mod = await orig<typeof import("../../utils/api-client")>();
  return { ...mod, api: { createWriteRequest: vi.fn() } };
});

const create = vi.mocked(api.createWriteRequest);

beforeEach(() => {
  create.mockReset();
  notifications.clean();
  notifications.cleanQueue();
});
afterEach(() => vi.unstubAllGlobals());

const wr = (over: Partial<WriteRequest> = {}): WriteRequest =>
  ({
    id: "wr-1",
    title: "Change proc",
    connectionId: "c1",
    env: "QA",
    dbType: "postgres",
    selectSql: "",
    writeSql: "CREATE OR REPLACE FUNCTION app_core.f(integer) ...",
    status: "PENDING",
    kind: "object_change",
    object: { schema: "app_core", name: "f", kind: "function" },
    snapshot: "CREATE FUNCTION app_core.f ...",
    restoreSql: null,
    ...over,
  }) as WriteRequest;

function renderReview(w: WriteRequest, canAuthor = true) {
  return renderUi(
    <Routes>
      <Route
        path="/"
        element={<ObjectChangeReview wr={w} canAuthor={canAuthor} />}
      />
      <Route path="/write-requests/:id" element={<div>detail page</div>} />
    </Routes>,
  );
}

describe("ObjectChangeReview", () => {
  it("diffs the snapshot against the proposed definition before it runs", () => {
    renderReview(wr());
    expect(screen.getByText("changes function")).toBeTruthy();
    expect(screen.getByText("app_core.f")).toBeTruthy();
    expect(screen.getByText(/deployed when submitted/)).toBeTruthy();
    expect(screen.queryByText(/the object did not exist/)).toBeNull();
    expect(screen.getByTestId("original").textContent).toBe(
      "CREATE FUNCTION app_core.f ...",
    );
    expect(screen.getByTestId("modified").textContent).toMatch(/OR REPLACE/);
    expect(screen.getByTestId("diff").dataset.lang).toBe("sql");
    expect(screen.queryByText("Restore previous version")).toBeNull();
  });

  it("shows a new object with args, parent and warnings against an empty side", () => {
    renderReview(
      wr({
        snapshot: null,
        object: {
          schema: "app_core",
          name: "trg",
          kind: "trigger",
          args: "integer",
          parent: "orders",
        },
        warnings: ["Contains a password literal"],
      }),
    );
    expect(screen.getByText("creates trigger")).toBeTruthy();
    expect(screen.getByText(/app_core\.trg\(integer\)/)).toBeTruthy();
    expect(screen.getByText(/on orders/)).toBeTruthy();
    expect(screen.getByText("Contains a password literal")).toBeTruthy();
    expect(screen.getByText(/the object did not exist/)).toBeTruthy();
    expect(screen.getByTestId("original").textContent).toBe("");
  });

  it("copies the definition as a migration", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderReview(wr());
    fireEvent.click(screen.getByText("Copy as migration"));
    expect(writeText).toHaveBeenCalledWith(wr().writeSql);
    await waitFor(() =>
      expect(screen.getByText("Copied migration: app_core.f")).toBeTruthy(),
    );
  });

  it("hides restore from a viewer who cannot author", () => {
    renderReview(wr({ status: "EXECUTED", restoreSql: "CREATE ..." }), false);
    expect(screen.queryByText("Restore previous version")).toBeNull();
  });

  it("restores the previous version as a new draft and opens it", async () => {
    create.mockResolvedValue({ id: "wr-2" } as WriteRequest);
    renderReview(
      wr({ status: "EXECUTED", restoreSql: "  CREATE FUNCTION old  " }),
    );
    expect(screen.getByText(/deployed when it ran/)).toBeTruthy();
    expect(screen.getByTestId("original").textContent).toBe(
      "CREATE FUNCTION old",
    );
    fireEvent.click(screen.getByText("Restore previous version"));
    await waitFor(() => expect(screen.getByText("detail page")).toBeTruthy());
    expect(create).toHaveBeenCalledWith({
      title: "Restore function f",
      description: "Puts back the version that write request wr-1 replaced.",
      connectionId: "c1",
      writeSql: "  CREATE FUNCTION old  ",
      object: { schema: "app_core", name: "f", kind: "function" },
      draft: true,
    });
  });

  it("reports a failed restore and stays put", async () => {
    create.mockRejectedValue(new Error("boom"));
    renderReview(wr({ status: "EXECUTED", restoreSql: "CREATE ..." }));
    fireEvent.click(screen.getByText("Restore previous version"));
    await waitFor(() =>
      expect(
        document.querySelector(".mantine-Notification-root")?.textContent,
      ).toMatch(/^boom/),
    );
    expect(screen.queryByText("detail page")).toBeNull();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Restore previous version/ })
          .getAttribute("data-loading"),
      ).toBeNull(),
    );
  });
});

describe("JobChangeSummary", () => {
  const job = (over: Partial<WriteRequest>) =>
    wr({ kind: "job_change", summary: "Edits step 1", ...over });

  it("diffs an edited step's old command against the new one", () => {
    renderUi(
      <JobChangeSummary
        wr={job({
          dbType: "mssql",
          snapshot: JSON.stringify({
            steps: [{ id: 1, command: "EXEC old_proc" }],
          }),
          warnings: ["Runs as sa"],
          jobChange: {
            jobId: "j1",
            jobName: "nightly",
            engine: "agent",
            action: { type: "edit_step", stepId: 1, command: "EXEC new_proc" },
          },
        })}
      />,
    );
    expect(screen.getByText("changes Agent job")).toBeTruthy();
    expect(screen.getByText("nightly")).toBeTruthy();
    expect(screen.getByText(/Edits step 1/)).toBeTruthy();
    expect(screen.getByText("Runs as sa")).toBeTruthy();
    expect(screen.getByTestId("original").textContent).toBe("EXEC old_proc");
    expect(screen.getByTestId("modified").textContent).toBe("EXEC new_proc");
  });

  it("diffs against empty when the step is missing from the snapshot", () => {
    renderUi(
      <JobChangeSummary
        wr={job({
          snapshot: JSON.stringify({ steps: [] }),
          jobChange: {
            jobId: "j1",
            jobName: "nightly",
            engine: "pg_cron",
            action: { type: "edit_step", stepId: 9, command: "SELECT 1" },
          },
        })}
      />,
    );
    expect(screen.getByText("changes pg_cron job")).toBeTruthy();
    expect(screen.getByTestId("original").textContent).toBe("");
  });

  it("shows no diff for other actions or without a snapshot", () => {
    renderUi(
      <>
        <JobChangeSummary
          wr={job({
            jobChange: {
              jobId: "j1",
              jobName: "a",
              engine: "pg_cron",
              action: { type: "set_enabled", enabled: false },
            },
          })}
        />
        <JobChangeSummary
          wr={job({
            snapshot: null,
            jobChange: {
              jobId: "j1",
              jobName: "b",
              engine: "pg_cron",
              action: { type: "edit_step", stepId: 1, command: "x" },
            },
          })}
        />
      </>,
    );
    expect(screen.queryByTestId("diff")).toBeNull();
  });
});
