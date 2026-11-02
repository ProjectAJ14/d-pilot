// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { WriteRequest } from "../../types";
import { renderUi } from "../../utils/dom.testing";
import {
  countActionRequired,
  needsMyAction,
  RequestsPage,
} from "./requests-page";

const getWriteRequests = vi.fn();
const notifyError = vi.fn();
vi.mock("../../utils/api-client", () => ({
  api: { getWriteRequests: () => getWriteRequests() },
}));
vi.mock("../../utils/notify-error", () => ({
  notifyError: (...a: unknown[]) => notifyError(...a),
}));
vi.mock("@monaco-editor/react", () => ({ default: () => null }));
vi.mock("../query/results-json-view", () => ({ ResultsJsonView: () => null }));

let seq = 0;
function wr(over: Partial<WriteRequest> = {}): WriteRequest {
  seq++;
  return {
    id: `wr-${seq}`,
    title: `Request ${seq}`,
    connectionId: "conn-qa",
    connectionName: "QA core",
    env: "QA",
    dbType: "postgres",
    selectSql: "",
    writeSql: "",
    status: "EXECUTED",
    requestedBy: "u2",
    requestedByEmail: "bob@example.com",
    requestedAt: `2026-10-${String(10 + (seq % 20)).padStart(2, "0")}T10:00:00`,
    ...over,
  } as WriteRequest;
}

function render() {
  return renderUi(
    <Routes>
      <Route path="/" element={<RequestsPage />} />
      <Route path="/write-requests/:id" element={<div>detail page</div>} />
    </Routes>,
  );
}

const rowTitles = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("td:nth-child(2) p")?.textContent);

beforeEach(() => {
  seq = 0;
  getWriteRequests.mockReset();
  notifyError.mockReset();
  useStore.setState({ actionRequiredCount: 0 });
});

describe("needsMyAction", () => {
  it("lights up only what the viewer can move forward", () => {
    const cases: [Partial<WriteRequest>, boolean][] = [
      [{ status: "PENDING", viewerCanApprove: true }, true],
      [{ status: "PENDING" }, false],
      [{ status: "DRAFT", viewerIsRequester: true }, true],
      [{ status: "DRAFT", viewerCanSubmit: true }, true],
      [{ status: "DRAFT" }, false],
      [{ status: "REJECTED", viewerIsRequester: true }, true],
      [{ status: "FAILED", viewerIsRequester: true }, true],
      [{ status: "EXECUTED", viewerIsRequester: true }, false],
      [{ status: "FAILED" }, false],
    ];
    for (const [over, want] of cases)
      expect(needsMyAction(wr(over))).toBe(want);
    expect(countActionRequired(cases.map(([o]) => wr(o)))).toBe(5);
  });
});

describe("RequestsPage", () => {
  it("lands on Needs me, labels each row's role and publishes the count", async () => {
    getWriteRequests.mockResolvedValue([
      wr({
        title: "Approve me",
        status: "PENDING",
        viewerCanApprove: true,
        aiVerdict: "SAFE",
      }),
      wr({ title: "My draft", status: "DRAFT", viewerIsRequester: true }),
      wr({
        title: "Their draft",
        status: "DRAFT",
        viewerCanSubmit: true,
        connectionName: undefined,
      }),
      wr({ title: "My failure", status: "FAILED", viewerIsRequester: true }),
      wr({ title: "Done", status: "EXECUTED" }),
      wr({ title: "Locked draft", status: "DRAFT" }),
    ]);
    render();
    expect(await screen.findByText("Approve me")).toBeTruthy();
    expect(screen.getByText("4 need you")).toBeTruthy();
    expect(useStore.getState().actionRequiredCount).toBe(4);
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.getByText("To review")).toBeTruthy();
    expect(screen.getByText("To submit")).toBeTruthy();
    expect(screen.getAllByText("Mine")).toHaveLength(3); // 2 rows + filter label
    expect(screen.getByText("Safe")).toBeTruthy();
    // Falls back to the connection id when there is no name.
    expect(screen.getByText("conn-qa")).toBeTruthy();
    expect(screen.getByText("4 requests")).toBeTruthy();

    // Every row carries the reason its dot is lit.
    const dots = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector("td div") as HTMLElement);
    const labels: string[] = [];
    for (const dot of dots) {
      await userEvent.hover(dot);
      const tip = await screen.findByRole("tooltip");
      labels.push(tip.textContent!);
      await userEvent.unhover(dot);
      await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    }
    expect(labels.sort()).toEqual([
      "A saved draft you can submit",
      "Awaiting your review",
      "Needs your revision",
      "Your saved draft — submit or run it",
    ]);

    await userEvent.click(screen.getByText("All"));
    expect(await screen.findByText("Done")).toBeTruthy();
    expect(screen.getAllByText("Theirs")).toHaveLength(2);
    // Action-required rows sort first.
    const titles = rowTitles();
    expect(titles.slice(4).sort()).toEqual(["Done", "Locked draft"]);

    await userEvent.click(screen.getByText("Approve me"));
    expect(await screen.findByText("detail page")).toBeTruthy();
  });

  it("lands on Mine when nothing needs the viewer, and says 1 request", async () => {
    getWriteRequests.mockResolvedValue([
      wr({ title: "Ran fine", viewerIsRequester: true }),
      wr({ title: "Someone else" }),
    ]);
    render();
    expect(await screen.findByText("Ran fine")).toBeTruthy();
    expect(screen.queryByText("Someone else")).toBeNull();
    expect(screen.getByText("1 request")).toBeTruthy();
    expect(screen.queryByText(/needs? you$/)).toBeNull();
    await userEvent.click(screen.getByText("Needs me"));
    expect(
      await screen.findByText("Nothing needs your attention right now."),
    ).toBeTruthy();
  });

  it("says one request needs you in the singular", async () => {
    getWriteRequests.mockResolvedValue([
      wr({ status: "PENDING", viewerCanApprove: true }),
    ]);
    render();
    expect(await screen.findByText("1 needs you")).toBeTruthy();
  });

  it("lands on All, searches every term, and shows the empty states", async () => {
    getWriteRequests.mockResolvedValue([
      wr({
        title: "Fix orders",
        description: "backfill",
        aiVerdict: "DANGEROUS",
      }),
      wr({ title: "Fix customers", requestedByEmail: "carol@example.com" }),
    ]);
    render();
    expect(await screen.findByText("Fix orders")).toBeTruthy();
    expect(screen.getByText("Fix customers")).toBeTruthy();
    const search = screen.getByPlaceholderText(/Search title/);
    fireEvent.change(search, { target: { value: "  FIX   carol " } });
    expect(screen.queryByText("Fix orders")).toBeNull();
    expect(screen.getByText("Fix customers")).toBeTruthy();
    fireEvent.change(search, { target: { value: "dangerous backfill" } });
    expect(screen.getByText("Fix orders")).toBeTruthy();
    fireEvent.change(search, { target: { value: "nomatch" } });
    expect(screen.getByText("No requests match your search.")).toBeTruthy();
    fireEvent.change(search, { target: { value: "" } });
    await userEvent.click(screen.getByText("Mine"));
    expect(await screen.findByText("No requests here yet.")).toBeTruthy();
  });

  it("pages through more than twelve requests, newest first", async () => {
    getWriteRequests.mockResolvedValue(
      // Out of date order, so the sort has to move rows both ways.
      Array.from({ length: 14 }, (_, i) => (i * 5) % 14).map((d) =>
        wr({
          title: `Bulk ${String(d).padStart(2, "0")}`,
          requestedAt: `2026-10-${String(d + 1).padStart(2, "0")}T10:00:00`,
        }),
      ),
    );
    render();
    expect(await screen.findByText("Bulk 13")).toBeTruthy();
    expect(screen.getByText("14 requests · showing 1–12")).toBeTruthy();
    expect(rowTitles()[0]).toBe("Bulk 13");
    expect(rowTitles()[11]).toBe("Bulk 02");
    await userEvent.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("14 requests · showing 13–14")).toBeTruthy();
    expect(rowTitles()).toEqual(["Bulk 01", "Bulk 00"]);
  });

  it("reports a failed load and reloads on Refresh", async () => {
    getWriteRequests.mockRejectedValueOnce(new Error("down"));
    getWriteRequests.mockResolvedValueOnce([wr({ title: "Back again" })]);
    render();
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(expect.any(Error), "Requests"),
    );
    expect(await screen.findByText("No requests here yet.")).toBeTruthy();
    await userEvent.click(screen.getByText("Refresh"));
    expect(await screen.findByText("Back again")).toBeTruthy();
  });
});
