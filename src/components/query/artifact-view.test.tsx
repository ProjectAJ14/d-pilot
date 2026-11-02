// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { fireReactHandler } from "../../utils/react-handler.testing";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { notifyError } from "../../utils/notify-error";
import { copyArtifactShareLink } from "../../utils/share-links";
import { HEIGHT_MESSAGE } from "../../utils/artifact-html";
import type { Artifact, ConnectionInfo, QueryTab } from "../../types";
import { ArtifactView } from "./artifact-view";

vi.mock("@monaco-editor/react", () => ({
  default: (p: { value: string; height: string; language: string }) => (
    <pre data-testid="editor" data-height={p.height} data-language={p.language}>
      {p.value}
    </pre>
  ),
}));

vi.mock("./results-grid", () => ({
  ResultsGrid: (p: {
    tab: QueryTab;
    onViewModeChange: (m: "table" | "json") => void;
  }) => (
    <div data-testid="grid" data-tab-id={p.tab.id} data-view={p.tab.viewMode}>
      {p.tab.error ?? `${p.tab.result?.rows.length} rows`}
      <button onClick={() => p.onViewModeChange("json")}>to-json</button>
    </div>
  ),
}));

vi.mock("../../utils/notify-error", () => ({ notifyError: vi.fn() }));
vi.mock("../../utils/share-links", () => ({ copyArtifactShareLink: vi.fn() }));

const CONNS: ConnectionInfo[] = [
  { id: "c-dev", name: "app_core", env: "DEV", type: "postgres" },
  { id: "c-mongo", name: "docs", env: "QA", type: "mongodb" },
];

const baseTab: QueryTab = {
  id: "t1",
  title: "Orders report",
  kind: "artifact",
  artifactId: "a1",
  sql: "",
  connectionId: null,
  result: null,
  loading: false,
  error: null,
};

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1",
    title: "Orders report",
    blocks: [],
    createdBy: "u1",
    createdByEmail: "owner@example.com",
    isShared: true,
    tags: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    ...over,
  };
}

function render(tab: QueryTab = baseTab) {
  return renderUi(
    <Routes>
      <Route path="/" element={<ArtifactView tab={tab} />} />
      <Route path="/write" element={<div>write page</div>} />
    </Routes>,
  );
}

beforeEach(() => {
  useStore.setState({
    connections: CONNS,
    activeConnectionId: "c-dev",
    tabs: [baseTab],
    activeTabId: "t1",
    user: {
      id: "u1",
      username: "owner",
      email: "owner@example.com",
      name: "Owner",
      isAdmin: false,
      canUnmaskPhi: false,
      canWrite: true,
    },
    writeHandoff: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(notifyError).mockClear();
});

describe("ArtifactView", () => {
  it("stays loading when the tab has no artifact id", () => {
    const get = vi.spyOn(api, "getArtifact");
    render({ ...baseTab, artifactId: undefined });
    expect(screen.getByText("Loading artifact…")).toBeTruthy();
    expect(get).not.toHaveBeenCalled();
  });

  it("shows the load error", async () => {
    vi.spyOn(api, "getArtifact").mockRejectedValue(new Error("Not found"));
    render();
    expect(await screen.findByText("Not found")).toBeTruthy();
  });

  it("renders the header and syncs a renamed title onto the tab", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({ title: "Renamed", description: "About orders" }),
    );
    render();
    expect(await screen.findByText("Renamed")).toBeTruthy();
    expect(screen.getByText("About orders")).toBeTruthy();
    expect(screen.getByText("shared")).toBeTruthy();
    expect(screen.queryByText("archived")).toBeNull();
    expect(useStore.getState().tabs[0].title).toBe("Renamed");
    fireEvent.click(screen.getByText("Share"));
    expect(copyArtifactShareLink).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a1" }),
    );
  });

  it("escapes raw HTML in markdown text blocks instead of injecting it", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        isShared: false,
        blocks: [
          {
            type: "text",
            body: '**bold** <img src=x onerror="alert(1)"><script>alert(2)</script>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[docs](https://example.com)',
          },
        ],
      }),
    );
    const { container } = render();
    expect(await screen.findByText("bold")).toBeTruthy();
    expect(screen.getByText("private")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // GFM tables are wrapped for horizontal scroll.
    const table = container.querySelector("table")!;
    expect((table.parentElement as HTMLElement).style.overflowX).toBe("auto");
    // Links open in a new tab and leak no opener.
    const link = screen.getByText("docs") as HTMLAnchorElement;
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("renders html blocks only in a sandboxed iframe without same-origin", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        blocks: [{ type: "html", body: '<p id="inner">Hello</p>' }],
      }),
    );
    const { container } = render();
    const frame = (await screen.findByTitle(
      "Artifact content",
    )) as HTMLIFrameElement;
    const sandbox = frame.getAttribute("sandbox")!;
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).toContain('<p id="inner">Hello</p>');
    // Never injected into the app's own DOM.
    expect(container.querySelector("#inner")).toBeNull();
    expect(frame.style.height).toBe("120px");
    await act(async () => {}); // let the message listener attach

    const post = (data: unknown, source: unknown = frame.contentWindow) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent("message", { data, source: source as Window }),
        );
      });
    post({ type: HEIGHT_MESSAGE, height: 999 }, window); // foreign source
    post(null); // no data
    post({ type: "other", height: 999 });
    post({ type: HEIGHT_MESSAGE, height: "nope" });
    post({ type: HEIGHT_MESSAGE, height: -5 });
    expect(frame.style.height).toBe("120px");
    post({ type: HEIGHT_MESSAGE, height: 300.2 });
    expect(frame.style.height).toBe("301px");

    // The first load is the srcdoc; a second means the frame navigated away.
    fireEvent.load(frame);
    expect(screen.getByTitle("Artifact content")).toBeTruthy();
    fireEvent.load(frame);
    expect(
      screen.getByText(
        "This section tried to navigate to another page and was stopped.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTitle("Artifact content")).toBeNull();
  });

  it("runs a read block as the reader and keeps rows off the stored tab", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        connectionId: "c-mongo",
        blocks: [
          { type: "sql", sql: "SELECT 1", connectionId: "c-dev", label: "One" },
          { type: "sql", sql: "db.orders.find()" },
        ],
      }),
    );
    const exec = vi
      .spyOn(api, "executeQuery")
      .mockResolvedValueOnce({ columns: [], rows: [{ a: 1 }] } as never)
      .mockRejectedValueOnce(new Error("boom"));
    render();
    expect(await screen.findByText("One")).toBeTruthy();
    expect(screen.getByText("Query 2")).toBeTruthy();
    expect(screen.getByText("app_core · DEV")).toBeTruthy();
    expect(screen.getByText("docs · QA")).toBeTruthy();
    const editors = screen.getAllByTestId("editor");
    expect(editors[0].dataset.height).toBe("60px");
    expect(editors[1].dataset.language).not.toBe(editors[0].dataset.language);

    const runs = screen.getAllByText("Run");
    fireEvent.click(runs[0]);
    const grid = await screen.findByTestId("grid");
    expect(exec).toHaveBeenCalledWith("c-dev", "SELECT 1", expect.anything());
    expect(grid.textContent).toContain("1 rows");
    // A synthetic id, so the grid never addresses the real tab...
    expect(grid.dataset.tabId).toBe("t1:block:0");
    expect(grid.dataset.view).toBe("table");
    // ...and the result rows never land in the persisted store.
    expect(useStore.getState().tabs[0].result).toBeNull();
    fireEvent.click(screen.getByText("to-json"));
    expect(screen.getByTestId("grid").dataset.view).toBe("json");
    // Losing access to the connection keeps the shown result but unbinds it.
    act(() => useStore.setState({ connections: [CONNS[1]] }));
    expect(screen.getByText("no connection")).toBeTruthy();
    expect(screen.getByTestId("grid").textContent).toContain("1 rows");
    act(() => useStore.setState({ connections: CONNS }));

    fireEvent.click(runs[1]);
    await waitFor(() => expect(screen.getByText(/boom/)).toBeTruthy());
    expect(exec).toHaveBeenLastCalledWith(
      "c-mongo",
      "db.orders.find()",
      expect.anything(),
    );
  });

  it("disables Run when the reader has no access to the block's connection", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        blocks: [
          {
            type: "sql",
            sql: Array(30).fill("SELECT 1").join("\n"),
            connectionId: "c-gone",
          },
        ],
      }),
    );
    render();
    expect(await screen.findByText("no connection")).toBeTruthy();
    expect(screen.getByTestId("editor").dataset.height).toBe("260px");
    const run = screen.getByText("Run").closest("button")!;
    expect(run.disabled).toBe(true);
    // Even if Run fires anyway, it refuses to query a connection the reader lacks.
    const execute = vi.spyOn(api, "executeQuery");
    await fireReactHandler(run);
    expect(execute).not.toHaveBeenCalled();

    // Opening in the editor falls back to the session's connection.
    fireEvent.click(screen.getByText("Open in editor"));
    const s = useStore.getState();
    const opened = s.tabs.find((t) => t.id === s.activeTabId)!;
    expect(opened.title).toBe("Query 1");
    expect(opened.connectionId).toBe("c-dev");
  });

  it("opens a block in a new editor tab on its own connection", async () => {
    useStore.setState({ activeConnectionId: null });
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        blocks: [{ type: "sql", sql: "SELECT 2", connectionId: "c-mongo" }],
      }),
    );
    render();
    fireEvent.click(await screen.findByText("Open in editor"));
    const s = useStore.getState();
    const opened = s.tabs.find((t) => t.id === s.activeTabId)!;
    expect(opened.sql).toBe("SELECT 2");
    expect(opened.connectionId).toBe("c-mongo");
  });

  it("routes write blocks to the write composer instead of running them", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({
        blocks: [
          { type: "sql", sql: "UPDATE orders SET x = 1", label: "Fix" },
          { type: "sql", sql: "delete from customers", connectionId: "c-x" },
        ],
      }),
    );
    render();
    expect(await screen.findAllByText("write query")).toHaveLength(2);
    for (const b of screen.getAllByText("Run")) {
      expect(b.closest("button")!.disabled).toBe(true);
    }
    fireEvent.click(screen.getAllByText("Send to write composer")[1]);
    expect(useStore.getState().writeHandoff).toMatchObject({
      writeSql: "delete from customers",
      connectionId: null,
      title: "Query 2",
    });
    expect(await screen.findByText("write page")).toBeTruthy();
    cleanup();
    render();
    fireEvent.click((await screen.findAllByText("Send to write composer"))[0]);
    expect(useStore.getState().writeHandoff).toEqual({
      writeSql: "UPDATE orders SET x = 1",
      connectionId: "c-dev",
      title: "Fix",
      description: "From artifact: Orders report",
    });
  });

  it("hides Send to write composer from readers without write", async () => {
    useStore.setState({ user: null });
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({ blocks: [{ type: "sql", sql: "DROP TABLE orders" }] }),
    );
    render();
    expect(await screen.findByText("write query")).toBeTruthy();
    expect(screen.queryByText("Send to write composer")).toBeNull();
  });

  it("lets only the owner restore an archived artifact", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({ archivedAt: "2026-02-01T00:00:00Z" }),
    );
    vi.spyOn(api, "setArtifactArchived").mockResolvedValue(artifact());
    vi.spyOn(api, "getArtifacts").mockResolvedValue([artifact()]);
    render();
    expect(await screen.findByText("archived")).toBeTruthy();
    fireEvent.click(screen.getByText("Restore"));
    expect(await screen.findByText("Artifact restored")).toBeTruthy();
    expect(api.setArtifactArchived).toHaveBeenCalledWith("a1", false);
    expect(useStore.getState().artifacts).toHaveLength(1);
    expect(screen.queryByText("archived")).toBeNull();
  });

  it("reports a failed restore", async () => {
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({ archivedAt: "2026-02-01T00:00:00Z" }),
    );
    const err = new Error("nope");
    vi.spyOn(api, "setArtifactArchived").mockRejectedValue(err);
    render();
    fireEvent.click(await screen.findByText("Restore"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(err, "Artifact"),
    );
    expect(screen.getByText("archived")).toBeTruthy();
  });

  it("offers no restore to a non-owner", async () => {
    useStore.setState({ user: null });
    vi.spyOn(api, "getArtifact").mockResolvedValue(
      artifact({ archivedAt: "2026-02-01T00:00:00Z" }),
    );
    render();
    expect(await screen.findByText("archived")).toBeTruthy();
    expect(screen.queryByText("Restore")).toBeNull();
  });
});
