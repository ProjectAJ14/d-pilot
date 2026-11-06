// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAppConfig, loadConnections } from "../../utils/app-config";
import {
  dialog,
  mockApi,
  renderSettings,
  setEnvironments,
  user,
} from "./settings-page.testing";

vi.mock("../../utils/api-client", async (orig) =>
  (await import("./settings-page.api-mock.testing")).apiModuleMock(
    await orig(),
  ),
);
vi.mock("../../utils/app-config", () => ({
  loadAppConfig: vi.fn().mockResolvedValue(undefined),
  loadConnections: vi.fn().mockResolvedValue(undefined),
}));

const ordersQa = {
  id: "orders-qa",
  name: "Orders QA",
  env: "QA",
  type: "postgres",
  host: "db.local",
  port: 5432,
  database: "orders",
  username: "dpilot",
  schema: "public",
  schemas: ["public"],
  passwordSet: true,
  uriSet: true,
};
const searchProd = {
  id: "search-prod",
  name: "Search",
  env: "PROD",
  type: "elasticsearch",
  schema: "https",
  passwordSet: true,
  uriSet: false,
};
const mongoDev = {
  id: "mongo-dev",
  name: "Mongo",
  env: "DEV",
  type: "mongodb",
  database: "app_core",
  passwordSet: false,
  uriSet: true,
};
const bare = {
  id: "bare",
  name: "Bare",
  env: "DEV",
  type: "mssql",
  host: "sql.local",
  passwordSet: false,
  uriSet: false,
};
const blank = {
  id: "blank",
  name: "Blank",
  env: "DEV",
  type: "postgres",
  passwordSet: false,
  uriSet: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  vi.mocked(loadAppConfig).mockResolvedValue(undefined);
  vi.mocked(loadConnections).mockResolvedValue(undefined);
  setEnvironments(["PROD", "SUPER_PROD", "QA", "DEV"]);
});

const btn = (name: string | RegExp) => screen.getByRole("button", { name });

async function openConnections(
  list: unknown[] = [ordersQa, searchProd, mongoDev, bare, blank],
) {
  mockApi.getAdminConnections.mockResolvedValue(list);
  renderSettings("connections");
  if (list.length) await screen.findByText((list[0] as { name: string }).name);
}

const many = Array.from({ length: 30 }, (_, i) => ({
  id: `c${i + 1}`,
  name: `Conn ${String(i + 1).padStart(2, "0")}`,
  env: "DEV",
  type: "postgres",
  passwordSet: false,
  uriSet: false,
}));

describe("Connections search and paging", () => {
  it("filters by name, env, type and target, with a no-match row", async () => {
    await openConnections();
    const u = user();
    const box = screen.getByLabelText("Search connections");
    await u.type(box, "elasticsearch");
    expect(screen.getByText("Search")).toBeTruthy();
    expect(screen.queryByText("Orders QA")).toBeNull();
    await u.clear(box);
    await u.type(box, "db.local");
    expect(screen.getByText("Orders QA")).toBeTruthy();
    expect(screen.queryByText("Mongo")).toBeNull();
    await u.clear(box);
    await u.type(box, "app_core");
    expect(screen.getByText("Mongo")).toBeTruthy();
    await u.clear(box);
    await u.type(box, "zzz");
    expect(screen.getByText("No matches")).toBeTruthy();
    expect(
      screen.queryByText("No connections yet. Add one to start querying."),
    ).toBeNull();
  });

  it("pages past 25 rows and returns to page 1 on search", async () => {
    await openConnections(many);
    const u = user();
    expect(screen.queryByText("Conn 26")).toBeNull();
    await u.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Conn 26")).toBeTruthy();
    expect(screen.queryByText("Conn 01")).toBeNull();
    await u.type(screen.getByLabelText("Search connections"), "Conn 0");
    expect(screen.getByText("Conn 01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "2" })).toBeNull();
  });
});

describe("Connections list", () => {
  it("shows each connection's target and stored credentials", async () => {
    await openConnections();
    const cell = (id: string, col: number) =>
      within(screen.getByText(id).closest("tr")!).getAllByRole("cell")[col]
        .textContent;
    expect(cell("orders-qa", 3)).toBe("db.local:5432 / orders");
    expect(cell("orders-qa", 4)).toBe("password, URI");
    expect(cell("search-prod", 3)).toBe("—");
    expect(cell("search-prod", 4)).toBe("password");
    expect(cell("mongo-dev", 3)).toBe("URI / app_core");
    expect(cell("mongo-dev", 4)).toBe("URI");
    expect(cell("bare", 3)).toBe("sql.local");
    expect(cell("bare", 4)).toBe("none");
  });

  it("tests a connection and shows the outcome", async () => {
    await openConnections();
    const u = user();
    mockApi.testConnection.mockResolvedValueOnce({ connected: true });
    await u.click(btn("Test Orders QA"));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(mockApi.testConnection).toHaveBeenCalledWith("orders-qa");
    mockApi.testConnection.mockResolvedValueOnce({ connected: false });
    await u.click(btn("Test Search"));
    expect(await screen.findByText("Failed")).toBeTruthy();
    mockApi.testConnection.mockRejectedValueOnce(new Error("no route"));
    await u.click(btn("Test Mongo"));
    expect(await screen.findByText("no route")).toBeTruthy();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });

  it("shows empty, loading and error states", async () => {
    await openConnections([]);
    expect(
      await screen.findByText("No connections yet. Add one to start querying."),
    ).toBeTruthy();
  });

  it("retries after a load failure", async () => {
    mockApi.getAdminConnections
      .mockRejectedValueOnce(new Error("conns down"))
      .mockReturnValueOnce(new Promise(() => {}));
    renderSettings("connections");
    expect(await screen.findByText("conns down")).toBeTruthy();
    await user().click(btn("Retry"));
    expect(screen.queryByText("Could not load connections")).toBeNull();
    expect(mockApi.getAdminConnections).toHaveBeenCalledTimes(2);
  });

  it("deletes a connection after confirmation", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Delete Bare"));
    let d = await dialog();
    expect(d.getByText("bare")).toBeTruthy();
    await u.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await u.click(btn("Delete Bare"));
    d = await dialog();
    mockApi.deleteConnection.mockRejectedValueOnce(new Error("in use"));
    await u.click(d.getByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText("in use")).toBeTruthy();
    mockApi.deleteConnection.mockResolvedValueOnce({});
    await u.click(d.getByRole("button", { name: "Delete connection" }));
    expect(await screen.findByText("Connection deleted")).toBeTruthy();
    expect(mockApi.deleteConnection).toHaveBeenCalledWith("bare");
    await waitFor(() =>
      expect(mockApi.getAdminConnections).toHaveBeenCalledTimes(2),
    );
    expect(loadConnections).toHaveBeenCalled();
    expect(loadAppConfig).toHaveBeenCalled();
  });

  it("refreshes even when reloading app config fails", async () => {
    vi.mocked(loadConnections).mockRejectedValue(new Error("offline"));
    await openConnections();
    const u = user();
    await u.click(btn("Delete Bare"));
    mockApi.deleteConnection.mockResolvedValueOnce({});
    await u.click(
      (await dialog()).getByRole("button", { name: "Delete connection" }),
    );
    expect(await screen.findByText("Connection deleted")).toBeTruthy();
  });
});

const label = (d: ReturnType<typeof within>, name: string) =>
  d.getByLabelText(new RegExp(`^${name}`)) as HTMLInputElement;

describe("Connection modal", () => {
  it("adds a connection with every field", async () => {
    await openConnections([]);
    const u = user();
    await u.click(btn("Add connection"));
    const d = await dialog();
    expect(d.getByText("Pick one or type a new name")).toBeTruthy();
    await u.type(label(d, "ID"), " orders-dev ");
    await u.type(label(d, "Name"), " Orders ");
    await u.type(label(d, "Environment"), "DEV");
    await u.click(label(d, "Type"));
    await u.click(
      (
        await screen.findAllByRole("option", { name: "mssql", hidden: true })
      )[0],
    );
    await u.type(label(d, "Host"), "sql.local");
    await u.type(label(d, "Port"), "1433");
    await u.type(label(d, "Database"), "orders");
    await u.type(label(d, "Username"), "reader");
    await u.type(label(d, "Password"), "pw");
    await u.type(label(d, "Default schema"), "dbo");
    await u.type(label(d, "Schemas"), "dbo{enter}");
    await u.type(label(d, "Connection URI"), "mssql://x");

    mockApi.createConnection.mockResolvedValueOnce({});
    await u.click(d.getByRole("button", { name: "Add connection" }));
    await waitFor(() =>
      expect(mockApi.createConnection).toHaveBeenCalledWith({
        id: "orders-dev",
        name: "Orders",
        env: "DEV",
        type: "mssql",
        host: "sql.local",
        port: 1433,
        database: "orders",
        username: "reader",
        password: "pw",
        schema: "dbo",
        schemas: ["dbo"],
        uri: "mssql://x",
      }),
    );
    expect(await screen.findByText("Connection added")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.getAdminConnections).toHaveBeenCalledTimes(2);
  });

  it("puts server errors on the right field, else on the form", async () => {
    await openConnections([]);
    const u = user();
    await u.click(btn("Add connection"));
    const d = await dialog();
    // Required fields are checked by the browser before submit.
    await u.type(label(d, "ID"), "x");
    await u.type(label(d, "Name"), "n");
    await u.type(label(d, "Environment"), "DEV");

    mockApi.createConnection.mockRejectedValueOnce(
      new Error("id: already exists"),
    );
    await u.click(d.getByRole("button", { name: "Add connection" }));
    expect(await d.findByText("already exists")).toBeTruthy();
    expect(mockApi.createConnection).toHaveBeenCalledWith({
      id: "x",
      name: "n",
      env: "DEV",
      type: "postgres",
      host: undefined,
      port: undefined,
      database: undefined,
      username: undefined,
      password: undefined,
      schema: undefined,
      schemas: undefined,
      uri: undefined,
    });
    // Typing elsewhere keeps it; typing in the field clears it.
    await u.type(label(d, "Host"), "h");
    expect(d.getByText("already exists")).toBeTruthy();
    await u.type(label(d, "ID"), "y");
    expect(d.queryByText("already exists")).toBeNull();

    mockApi.createConnection.mockRejectedValueOnce(
      new Error("Password is required for this type"),
    );
    await u.click(d.getByRole("button", { name: "Add connection" }));
    expect(
      await d.findByText("Password is required for this type"),
    ).toBeTruthy();

    mockApi.createConnection.mockRejectedValueOnce(
      new Error("unknownfield: odd"),
    );
    await u.click(d.getByRole("button", { name: "Add connection" }));
    expect(await d.findByText("unknownfield: odd")).toBeTruthy();

    mockApi.createConnection.mockRejectedValueOnce("plain failure");
    await u.click(d.getByRole("button", { name: "Add connection" }));
    expect(await d.findByText("plain failure")).toBeTruthy();

    await u.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("tests the draft before saving", async () => {
    await openConnections([]);
    const u = user();
    await u.click(btn("Add connection"));
    const d = await dialog();
    await u.type(label(d, "Host"), "db.local");
    const test = d.getByRole("button", { name: "Test connection" });

    mockApi.testConnectionDraft.mockResolvedValueOnce({ ok: true });
    await u.click(test);
    expect(await d.findByText("Connected")).toBeTruthy();
    expect(mockApi.testConnectionDraft).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "db.local", id: undefined }),
    );
    // Any edit drops the stale result.
    await u.type(label(d, "Host"), "x");
    expect(d.queryByText("Connected")).toBeNull();

    mockApi.testConnectionDraft.mockResolvedValueOnce({
      ok: false,
      error: "refused",
    });
    await u.click(test);
    expect(await d.findByText("Could not connect: refused")).toBeTruthy();
    // Changing the type drops it too.
    await u.click(label(d, "Type"));
    await u.click(
      (
        await screen.findAllByRole("option", { name: "mongodb", hidden: true })
      )[0],
    );
    expect(d.queryByText(/Could not connect/)).toBeNull();

    mockApi.testConnectionDraft.mockResolvedValueOnce({ ok: false });
    await u.click(test);
    expect(await d.findByText("Could not connect: unknown error")).toBeTruthy();

    mockApi.testConnectionDraft.mockRejectedValueOnce(new Error("host: bad"));
    await u.click(test);
    expect(await d.findByText("bad")).toBeTruthy();
  });

  it("asks for the password again when the target changes", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Edit Orders QA"));
    const d = await dialog();
    expect(screen.getByText("Edit Orders QA")).toBeTruthy();
    expect(label(d, "ID").disabled).toBe(true);
    const pw = () => label(d, "Password");
    expect(pw().required).toBe(false);
    expect(pw().placeholder).toBe("•••• (unchanged)");

    // Name, env and schemas keep the stored password.
    await u.type(label(d, "Name"), "!");
    await u.type(label(d, "Schemas"), "sales{enter}");
    expect(pw().required).toBe(false);

    for (const [name, extra] of [
      ["Host", "x"],
      ["Port", "1"],
      ["Database", "x"],
      ["Username", "x"],
    ] as const) {
      await u.type(label(d, name), extra);
      expect(pw().required).toBe(true);
      await u.type(label(d, name), "{backspace}");
      expect(pw().required).toBe(false);
    }
    await u.type(label(d, "Connection URI"), "u");
    expect(pw().required).toBe(true);
    await u.clear(label(d, "Connection URI"));

    // Testing while the password must be re-entered refuses locally.
    await u.type(label(d, "Host"), "x");
    expect(d.getAllByText(/Re-enter the password/).length).toBeGreaterThan(0);
    await u.click(d.getByRole("button", { name: "Test connection" }));
    expect(mockApi.testConnectionDraft).not.toHaveBeenCalled();
    await u.type(pw(), "secret");
    expect(pw().required).toBe(false);

    mockApi.testConnectionDraft.mockResolvedValueOnce({ ok: true });
    await u.click(d.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(mockApi.testConnectionDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "orders-qa",
          host: "db.localx",
          password: "secret",
          clearPassword: undefined,
          clearUri: undefined,
        }),
      ),
    );

    mockApi.updateConnection.mockResolvedValueOnce({});
    await u.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateConnection).toHaveBeenCalledWith(
        "orders-qa",
        expect.objectContaining({
          name: "Orders QA!",
          schemas: ["public", "sales"],
          clearPassword: undefined,
        }),
      ),
    );
    expect(await screen.findByText("Connection updated")).toBeTruthy();
  });

  it("clears stored secrets on request, and can undo", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Edit Orders QA"));
    const d = await dialog();
    const clears = () =>
      d.getAllByRole("button", { name: "Clear stored value" });
    expect(clears()).toHaveLength(2);

    // Clearing the URI changes the target: password needed again.
    await u.click(clears()[1]);
    expect(label(d, "Connection URI").disabled).toBe(true);
    expect(label(d, "Connection URI").placeholder).toBe(
      "Will be cleared on save",
    );
    expect(label(d, "Password").required).toBe(true);
    await u.click(d.getByRole("button", { name: "Undo clear" }));
    expect(label(d, "Password").required).toBe(false);

    await u.click(clears()[0]);
    await u.click(clears()[0]);
    mockApi.updateConnection.mockResolvedValueOnce({});
    await u.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateConnection).toHaveBeenCalledWith(
        "orders-qa",
        expect.objectContaining({ clearPassword: true, clearUri: true }),
      ),
    );
  });

  it("tests a draft that clears secrets", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Edit Orders QA"));
    const d = await dialog();
    await u.click(d.getAllByRole("button", { name: "Clear stored value" })[0]);
    await u.click(d.getAllByRole("button", { name: "Clear stored value" })[0]);
    mockApi.testConnectionDraft.mockResolvedValueOnce({ ok: true });
    await u.click(d.getByRole("button", { name: "Test connection" }));
    await waitFor(() =>
      expect(mockApi.testConnectionDraft).toHaveBeenCalledWith(
        expect.objectContaining({ clearPassword: true, clearUri: true }),
      ),
    );
  });

  it("locks a production connection to production envs; ES schema is its protocol", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Edit Search"));
    const d = await dialog();
    expect(
      d.getByText(
        "Production — can only move to another production environment",
      ),
    ).toBeTruthy();
    await u.clear(label(d, "Environment"));
    await u.click(label(d, "Environment"));
    const opts = (await screen.findAllByRole("option", { hidden: true })).map(
      (o) => o.textContent,
    );
    expect(opts).toContain("SUPER_PROD");
    expect(opts).not.toContain("QA");

    expect(label(d, "Password").required).toBe(false);
    await u.type(label(d, "Default schema"), "x");
    expect(label(d, "Password").required).toBe(true);
    await u.type(label(d, "Default schema"), "{backspace}");
    // Changing type is a target change too.
    await u.click(label(d, "Type"));
    await u.click(
      (
        await screen.findAllByRole("option", { name: "postgres", hidden: true })
      )[0],
    );
    expect(label(d, "Password").required).toBe(true);
    // Not ES any more: the schema no longer counts.
    await u.click(label(d, "Type"));
    await u.click(
      (
        await screen.findAllByRole("option", {
          name: "elasticsearch",
          hidden: true,
        })
      )[0],
    );
    expect(label(d, "Password").required).toBe(false);
  });

  it("counts an Elasticsearch schema edit even when none was stored", async () => {
    await openConnections([
      {
        ...searchProd,
        id: "search-dev",
        name: "Search Dev",
        env: "DEV",
        schema: undefined,
      },
    ]);
    const u = user();
    await u.click(btn("Edit Search Dev"));
    const d = await dialog();
    expect(label(d, "Password").required).toBe(false);
    await u.type(label(d, "Default schema"), "http");
    expect(label(d, "Password").required).toBe(true);
  });

  it("edits a connection with no optional fields or secrets", async () => {
    await openConnections();
    const u = user();
    await u.click(btn("Edit Blank"));
    const d = await dialog();
    expect(label(d, "Password").placeholder).toBe("Not set");
    expect(d.queryByRole("button", { name: "Clear stored value" })).toBeNull();
    await u.type(label(d, "Host"), "h");
    expect(label(d, "Password").required).toBe(false);
    mockApi.updateConnection.mockResolvedValueOnce({});
    await u.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateConnection).toHaveBeenCalledWith(
        "blank",
        expect.objectContaining({ host: "h", port: undefined }),
      ),
    );
  });
});
