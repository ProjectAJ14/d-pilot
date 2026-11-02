// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { api, ApiError } from "../../utils/api-client";
import { copyToClipboard } from "../../utils/clipboard";
import { notifyError } from "../../utils/notify-error";
import { ObjectView } from "./object-view";
import type {
  DbObjectDefinition,
  DbObjectDependencies,
  QueryTab,
} from "../../types";

// Monaco cannot run in jsdom: render its inputs so the tests can read them.
const monaco = vi.hoisted(() => ({ mount: true, modified: "edited" }));
vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  return {
    default: (p: { value: string; language: string }) => (
      <pre data-testid="editor" data-language={p.language}>
        {p.value}
      </pre>
    ),
    DiffEditor: (p: {
      original: string;
      modified: string;
      language: string;
      options: { readOnly: boolean };
      onMount?: (e: unknown) => void;
    }) => {
      useEffect(() => {
        if (monaco.mount)
          p.onMount?.({
            getModifiedEditor: () => ({ getValue: () => monaco.modified }),
          });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return (
        <div
          data-testid="diff"
          data-original={p.original}
          data-modified={p.modified}
          data-language={p.language}
          data-readonly={String(p.options.readOnly)}
        />
      );
    },
  };
});
vi.mock("./query-editor", () => ({
  monacoLanguageForDb: (t?: string) => `lang-${t}`,
}));
vi.mock("../../utils/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../../utils/notify-error", () => ({ notifyError: vi.fn() }));
vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: {
    getObjectDefinition: vi.fn(),
    getObjectDependencies: vi.fn(),
    createWriteRequest: vi.fn(),
  },
}));
const getDef = vi.mocked(api.getObjectDefinition);
const getDeps = vi.mocked(api.getObjectDependencies);
const createWr = vi.mocked(api.createWriteRequest);

const object = {
  schema: "app_core",
  name: "close_order",
  kind: "procedure" as const,
  args: "integer",
};
const def = (over: Partial<DbObjectDefinition> = {}): DbObjectDefinition => ({
  ...object,
  definition: "CREATE PROCEDURE close_order AS SELECT 1",
  migration: "CREATE OR ALTER PROCEDURE close_order AS SELECT 1",
  ...over,
});
const noDeps: DbObjectDependencies = {
  uses: [],
  usedBy: [],
  bestEffort: false,
};

const connections = [
  { id: "qa", name: "qa-core", env: "QA", type: "postgres" as const },
  { id: "prod", name: "prod-core", env: "PROD", type: "postgres" as const },
  { id: "mongo", name: "docs", env: "QA", type: "mongodb" as const },
];

const tab = (over: Partial<QueryTab> = {}): QueryTab => ({
  id: "t1",
  title: "close_order",
  kind: "object",
  object,
  sql: "",
  connectionId: "qa",
  result: null,
  loading: false,
  error: null,
  ...over,
});

type User = ReturnType<typeof useStore.getState>["user"];
const admin = { isAdmin: true } as User;
const initial = useStore.getState();

beforeEach(() => {
  monaco.mount = true;
  useStore.setState({ connections, user: admin });
  getDeps.mockResolvedValue(noDeps);
});
afterEach(() => {
  useStore.setState(initial, true);
  vi.clearAllMocks();
  getDef.mockReset();
  getDeps.mockReset();
  createWr.mockReset();
});

const view = (t: QueryTab = tab()) =>
  renderUi(
    <Routes>
      <Route path="/" element={<ObjectView tab={t} />} />
      <Route path="/write-requests/:id" element={<div>request page</div>} />
    </Routes>,
  );
const btn = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ObjectView", () => {
  it("shows the live definition, and copies it or its migration", async () => {
    getDef.mockResolvedValue(def());
    view(tab({ object: { ...object, parent: "orders" } }));
    const editor = await screen.findByTestId("editor");
    expect(editor.textContent).toBe("CREATE PROCEDURE close_order AS SELECT 1");
    expect(editor.dataset.language).toBe("lang-postgres");
    expect(screen.getByText("app_core.close_order(integer)")).toBeTruthy();
    expect(screen.getByText(/on orders/)).toBeTruthy();
    expect(screen.getByText("QA")).toBeTruthy();
    expect(getDef).toHaveBeenCalledWith("qa", expect.objectContaining(object));

    fireEvent.click(btn("Copy definition"));
    expect(copyToClipboard).toHaveBeenCalledWith(
      "CREATE PROCEDURE close_order AS SELECT 1",
      "definition",
      "app_core.close_order(integer)",
    );
    fireEvent.click(btn("Copy as migration"));
    expect(copyToClipboard).toHaveBeenCalledWith(
      "CREATE OR ALTER PROCEDURE close_order AS SELECT 1",
      "migration",
      "app_core.close_order(integer)",
    );

    fireEvent.click(btn("Refresh definition"));
    await waitFor(() => expect(getDef).toHaveBeenCalledTimes(2));
    expect(getDeps).toHaveBeenCalledTimes(2);
  });

  it("says when the engine hides the definition", async () => {
    getDef.mockResolvedValue(def({ definition: null, migration: null }));
    view();
    expect(await screen.findByText(/Definition not available/)).toBeTruthy();
    expect(btn("Copy definition").disabled).toBe(true);
    expect(btn("Copy as migration").disabled).toBe(true);
    expect(btn("Edit").disabled).toBe(true);
  });

  it("reports a missing object and a failed read", async () => {
    getDef.mockRejectedValueOnce(new ApiError("gone", 404, "OBJECT_NOT_FOUND"));
    const { unmount } = view();
    expect(await screen.findByText("Not on qa-core")).toBeTruthy();
    unmount();

    getDef.mockRejectedValueOnce(new Error("timeout"));
    view();
    expect(await screen.findByText("qa-core: timeout")).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("drops answers that arrive after the view is gone", async () => {
    let resolveDef!: (d: DbObjectDefinition) => void;
    let resolveDeps!: (d: DbObjectDependencies) => void;
    getDef.mockReturnValue(new Promise((r) => (resolveDef = r)));
    getDeps.mockReturnValue(new Promise((r) => (resolveDeps = r)));
    const first = view();
    expect(document.querySelector(".mantine-Loader-root")).toBeTruthy();
    first.unmount();
    await act(async () => {
      resolveDef(def());
      resolveDeps(noDeps);
    });

    let rejectDeps!: (e: Error) => void;
    getDeps.mockReturnValue(new Promise((_, r) => (rejectDeps = r)));
    view().unmount();
    await act(async () => rejectDeps(new Error("late")));
    expect(screen.queryByText(/late/)).toBeNull();
  });

  it("lists dependencies and opens the ones that are objects or jobs", async () => {
    const openObjectTab = vi.fn();
    const openJobTab = vi.fn();
    useStore.setState({ openObjectTab, openJobTab });
    getDef.mockResolvedValue(def());
    getDeps.mockResolvedValue({
      uses: [
        { schema: "app_core", name: "orders", kind: "table" },
        { schema: "app_core", name: "calc", kind: "function", args: "int" },
        { name: "legacy_proc", kind: null },
        { schema: "app_core", name: "dropped_fn", kind: null },
        { database: "archive", schema: "dbo", name: "old", kind: "view" },
      ],
      usedBy: [
        { schema: "app_core", name: "trg", kind: "trigger", parent: "orders" },
      ],
      bestEffort: true,
      jobs: [{ id: "j1", name: "nightly" }],
    });
    view();
    expect(await screen.findByText("Uses")).toBeTruthy();
    expect(screen.getByText("app_core.orders").getAttribute("role")).toBeNull();
    expect(screen.getByText("legacy_proc (?)").title).toMatch(/unresolved/);
    expect(
      screen.getByText("app_core.dropped_fn (?)").getAttribute("role"),
    ).toBeNull();
    expect(
      screen.getByText("archive.dbo.old (view)").getAttribute("role"),
    ).toBeNull();
    expect(screen.getByText(/best effort: found by name/)).toBeTruthy();

    fireEvent.click(screen.getByText("app_core.calc(int) (function)"));
    expect(openObjectTab).toHaveBeenCalledWith("qa", {
      schema: "app_core",
      name: "calc",
      kind: "function",
      args: "int",
    });
    fireEvent.click(screen.getByText("app_core.trg (trigger)"));
    expect(openObjectTab).toHaveBeenLastCalledWith("qa", {
      schema: "app_core",
      name: "trg",
      kind: "trigger",
      parent: "orders",
    });
    fireEvent.click(screen.getByText("nightly (job)"));
    expect(openJobTab).toHaveBeenCalledWith("qa", {
      id: "j1",
      name: "nightly",
    });
  });

  it("shows empty and unavailable dependency lists", async () => {
    getDef.mockResolvedValue(def());
    const { unmount } = view();
    await waitFor(() =>
      expect(screen.getAllByText("nothing found")).toHaveLength(2),
    );
    expect(screen.queryByText("Run by")).toBeNull();
    unmount();

    getDeps.mockRejectedValue(new Error("no permission"));
    view();
    expect(
      await screen.findByText("Dependencies unavailable: no permission"),
    ).toBeTruthy();
  });

  it("shows a document object read-only, without dependencies or editing", async () => {
    getDef.mockResolvedValue(def({ definition: '{"a":1}' }));
    view(
      tab({
        connectionId: "mongo",
        object: { schema: "", name: "orders", kind: "view" },
      }),
    );
    const editor = await screen.findByTestId("editor");
    expect(editor.dataset.language).toBe("json");
    expect(screen.getByText("orders")).toBeTruthy();
    expect(getDeps).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("waits without a connection and lets writers on that env edit", async () => {
    const { unmount } = view(tab({ connectionId: null }));
    expect(document.querySelector(".mantine-Loader-root")).toBeTruthy();
    expect(getDef).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    unmount();

    useStore.setState({
      user: { isAdmin: false, writeEnvironments: ["QA"] } as User,
    });
    getDef.mockResolvedValue(def());
    view();
    await screen.findByTestId("editor");
    expect(btn("Edit").disabled).toBe(false);
  });

  it("hides Edit from users who cannot write to the env", async () => {
    useStore.setState({ user: { isAdmin: false } as User });
    getDef.mockResolvedValue(def());
    view();
    await screen.findByTestId("editor");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("compares with the same object on another connection", async () => {
    getDef.mockImplementation(async (id) =>
      id === "qa" ? def() : def({ definition: "CREATE PROCEDURE v2" }),
    );
    view(tab({ compareWith: "prod" }));
    const diff = await screen.findByTestId("diff");
    expect(diff.dataset.original).toBe(
      "CREATE PROCEDURE close_order AS SELECT 1",
    );
    expect(diff.dataset.modified).toBe("CREATE PROCEDURE v2");
    expect(diff.dataset.readonly).toBe("true");
    expect(getDef).toHaveBeenCalledWith("prod", expect.anything());
  });

  it("calls identical definitions identical", async () => {
    getDef.mockImplementation(async (id) =>
      def(id === "prod" ? { definition: def().definition + "\n" } : {}),
    );
    view(tab({ compareWith: "prod" }));
    expect(
      await screen.findByText("Identical on qa-core and prod-core."),
    ).toBeTruthy();
  });

  it("diffs against an empty side when the other connection lacks it", async () => {
    getDef.mockImplementation(async (id) => {
      if (id === "prod") throw new ApiError("gone", 404, "OBJECT_NOT_FOUND");
      return def({ definition: null });
    });
    view(tab({ compareWith: "prod" }));
    expect(await screen.findByText("Not on prod-core")).toBeTruthy();
    const diff = screen.getByTestId("diff");
    expect(diff.dataset.original).toMatch(/^-- Definition not available/);
    expect(diff.dataset.modified).toBe("");
  });

  it("waits for the other side before diffing", async () => {
    getDef.mockImplementation((id) =>
      id === "prod" ? new Promise(() => {}) : Promise.resolve(def()),
    );
    view(tab({ compareWith: "prod" }));
    await waitFor(() => expect(getDef).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(document.querySelector(".mantine-Loader-root")).toBeTruthy();
    expect(screen.queryByTestId("diff")).toBeNull();
  });

  it("compares with pasted text", async () => {
    let resolve!: (d: DbObjectDefinition) => void;
    getDef.mockReturnValue(new Promise((r) => (resolve = r)));
    view(tab({ compareWith: "__paste__" }));
    expect(
      screen.getByText(
        "Paste a version on the right to compare it with qa-core.",
      ),
    ).toBeTruthy();
    // Still loading our side: nothing to diff yet.
    expect(screen.queryByTestId("diff")).toBeNull();
    await act(async () => resolve(def()));
    const diff = screen.getByTestId("diff");
    expect(diff.dataset.modified).toBe("");
    expect(diff.dataset.readonly).toBe("false");
    expect(getDef).toHaveBeenCalledTimes(1);
  });

  it("drafts an object change as a write request", async () => {
    getDef.mockResolvedValue(def());
    getDeps.mockResolvedValue({
      uses: [],
      usedBy: [
        { schema: "app_core", name: "a", kind: "view" },
        { schema: "app_core", name: "b", kind: "view" },
      ],
      bestEffort: true,
      jobs: [{ id: "j1", name: "nightly" }],
    });
    createWr.mockResolvedValue({ id: "wr9" } as Awaited<
      ReturnType<typeof api.createWriteRequest>
    >);
    view(tab({ compareWith: "__paste__" }));
    await screen.findByText("nightly (job)");
    fireEvent.click(btn("Edit"));

    expect(
      screen.getByText("Editing procedure app_core.close_order"),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Changing this procedure affects 2 objects and 1 job (found by name, best effort).",
      ),
    ).toBeTruthy();
    // Editing replaces the paste comparison.
    expect(screen.queryByText(/Paste a version/)).toBeNull();
    expect(btn("Edit").disabled).toBe(true);
    const diff = screen.getByTestId("diff");
    expect(diff.dataset.original).toBe(def().migration);
    expect(diff.dataset.language).toBe("lang-postgres");

    const title = screen.getByLabelText("Request title") as HTMLInputElement;
    expect(title.value).toBe("Update procedure close_order");
    fireEvent.change(title, { target: { value: "  Fix closing  " } });
    fireEvent.click(btn("Save draft"));
    expect(await screen.findByText("request page")).toBeTruthy();
    expect(createWr).toHaveBeenCalledWith({
      title: "Fix closing",
      connectionId: "qa",
      writeSql: "edited",
      object,
      draft: true,
    });
  });

  it("falls back to the default title and starting text, and reports a failed save", async () => {
    monaco.mount = false;
    getDef.mockResolvedValue(def());
    getDeps.mockResolvedValue({
      uses: [],
      usedBy: [{ schema: "app_core", name: "a", kind: "view" }],
      bestEffort: false,
    });
    const err = new Error("boom");
    createWr.mockRejectedValue(err);
    view();
    await screen.findByText(/app_core\.a/);
    fireEvent.click(btn("Edit"));
    expect(
      screen.getByText("Changing this procedure affects 1 object."),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Request title"), {
      target: { value: "  " },
    });
    fireEvent.click(btn("Save draft"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(err, "Object change"),
    );
    expect(createWr.mock.calls[0][0]).toMatchObject({
      title: "Update procedure close_order",
      writeSql: def().migration,
    });
    expect(screen.queryByText("request page")).toBeNull();

    fireEvent.click(btn("Cancel"));
    expect(await screen.findByTestId("editor")).toBeTruthy();
  });

  it("states job-only impact, and stops editing while the definition reloads", async () => {
    getDef.mockResolvedValue(def());
    getDeps.mockResolvedValue({
      ...noDeps,
      jobs: [
        { id: "j1", name: "nightly" },
        { id: "j2", name: "weekly" },
      ],
    });
    view();
    await screen.findByText("weekly (job)");
    fireEvent.click(btn("Edit"));
    expect(
      screen.getByText("Changing this procedure affects 2 jobs."),
    ).toBeTruthy();

    getDef.mockReturnValue(new Promise(() => {}));
    fireEvent.click(btn("Refresh definition"));
    await waitFor(() =>
      expect(screen.queryByText(/^Editing procedure/)).toBeNull(),
    );
    expect(document.querySelector(".mantine-Loader-root")).toBeTruthy();
  });

  it("leaves the editor when the connection disappears", async () => {
    getDef.mockResolvedValue(def());
    // Dependencies never arrive: impact is computed from nothing.
    getDeps.mockReturnValue(new Promise(() => {}));
    view();
    await screen.findByTestId("editor");
    fireEvent.click(btn("Edit"));
    // Nothing depends on it: no impact banner.
    expect(screen.queryByText(/affects/)).toBeNull();
    act(() => useStore.setState({ connections: [] }));
    expect(screen.queryByText(/^Editing procedure/)).toBeNull();
    expect(screen.getByTestId("editor")).toBeTruthy();
  });
});
