// @vitest-environment jsdom
/**
 * Guards behind disabled buttons and closing modals. A user cannot reach them
 * by clicking, so these tests call the React handler the DOM node carries —
 * the same function a click would run — and check that the guard holds.
 */
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
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

type Props = Record<string, (...a: unknown[]) => unknown>;

/** The props React rendered onto a DOM node. */
function domProps(el: Element): Props {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
  return (el as unknown as Record<string, Props>)[key];
}

/** Props of the nearest component above `el` whose props pass `match`. */
function componentProps(el: Element, match: (p: Props) => boolean): Props {
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"))!;
  type Fiber = { memoizedProps: Props | null; return: Fiber | null };
  let f: Fiber | null = (el as unknown as Record<string, Fiber>)[key];
  while (f && !(f.memoizedProps && match(f.memoizedProps))) f = f.return;
  return f!.memoizedProps!;
}

/** Run a handler the way React would, and let its promise settle. */
const call = (fn: () => unknown) =>
  act(async () => {
    await fn();
  });

/**
 * A closing Mantine modal keeps rendering through its exit transition, now
 * with its subject cleared. Click the action in that window: the handler sees
 * no subject and must do nothing.
 */
async function clickWhileClosing(action: string) {
  const d = await dialog();
  const button = d.getByRole("button", { name: action });
  await user().click(d.getByRole("button", { name: "Cancel" }));
  await call(() => domProps(button).onClick());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  setEnvironments(["PROD", "QA", "DEV"]);
});

describe("User modals", () => {
  const alice = {
    id: "u1",
    email: "alice@example.com",
    username: "alice@example.com",
    displayName: "Alice",
    isAdmin: true,
    allowedEnvironments: [],
  };
  const bob = {
    id: "u2",
    email: "bob@example.com",
    username: "bob@example.com",
    displayName: "Bob",
    isAdmin: false,
    allowedEnvironments: ["DEV"],
  };
  async function openUsers() {
    useStore.setState({ user: { ...alice } as never });
    mockApi.getUsers.mockResolvedValue([alice, bob]);
    renderSettings("users");
    await screen.findByText("2 users");
    return screen.getByText("Bob").closest("tr")!;
  }

  it("saving an edit after the modal closed does nothing", async () => {
    const row = await openUsers();
    await user().click(within(row).getAllByRole("button")[0]);
    await clickWhileClosing("Save");
    expect(mockApi.updateUser).not.toHaveBeenCalled();
  });

  it("deleting after the modal closed does nothing", async () => {
    const row = await openUsers();
    await user().click(within(row).getAllByRole("button")[2]);
    await clickWhileClosing("Delete User");
    expect(mockApi.deleteUser).not.toHaveBeenCalled();
  });

  it("refuses a short password even if the disabled button fires", async () => {
    const row = await openUsers();
    await user().click(within(row).getAllByRole("button")[1]);
    const reset = (await dialog()).getByRole("button", {
      name: "Reset Password",
    });
    await call(() => domProps(reset).onClick());
    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeTruthy();
    expect(mockApi.resetUserPassword).not.toHaveBeenCalled();
  });
});

describe("PHI rule modals", () => {
  function openPhi(list: unknown[]) {
    mockApi.getPhiRules.mockResolvedValue(list);
    mockApi.getMaskedEnvironments.mockResolvedValue({ environments: ["PROD"] });
    renderSettings("phi");
  }

  it("deleting after the modal closed does nothing", async () => {
    openPhi([
      { id: "r1", pattern: "*ssn*", maskingType: "HASH", alwaysMasked: false },
    ]);
    await screen.findByText("1 tokenization rule");
    const row = screen.getByText("ssn").closest("tr")!;
    await user().click(within(row).getByRole("button"));
    await clickWhileClosing("Delete Rule");
    expect(mockApi.deletePhiRule).not.toHaveBeenCalled();
  });

  it("refuses a blank pattern even if the disabled button fires", async () => {
    openPhi([]);
    await screen.findByText("0 tokenization rules");
    await user().click(screen.getByRole("button", { name: /Add Rule/ }));
    const create = (await dialog()).getByRole("button", {
      name: "Create Rule",
    });
    await call(() => domProps(create).onClick());
    expect(await screen.findByText("Pattern is required")).toBeTruthy();
    expect(mockApi.createPhiRule).not.toHaveBeenCalled();
  });
});

describe("Connection modals", () => {
  const bare = {
    id: "bare",
    name: "Bare",
    env: "DEV",
    type: "mssql",
    host: "sql.local",
    passwordSet: false,
    uriSet: false,
  };
  async function openConnections() {
    mockApi.getAdminConnections.mockResolvedValue([bare]);
    renderSettings("connections");
    await screen.findByText("Bare");
  }

  it("deleting after the modal closed does nothing", async () => {
    await openConnections();
    await user().click(screen.getByRole("button", { name: "Delete Bare" }));
    await clickWhileClosing("Delete connection");
    expect(mockApi.deleteConnection).not.toHaveBeenCalled();
  });

  it("keeps the type when the Select reports a deselect", async () => {
    await openConnections();
    await user().click(screen.getByRole("button", { name: "Add connection" }));
    const d = await dialog();
    const type = d.getByRole("textbox", { name: "Type" });
    const before = (type as HTMLInputElement).value;
    const select = componentProps(
      type,
      (p) => p.allowDeselect === (false as never) && "data" in p,
    );
    await call(() => select.onChange(null));
    expect((type as HTMLInputElement).value).toBe(before);
    expect(before).not.toBe("");
  });

  it("imports nothing when Import fires with no rows", async () => {
    mockApi.getAdminConnections.mockResolvedValue([]);
    renderSettings("connections");
    await screen.findByText(/No connections yet/);
    await user().click(screen.getByRole("button", { name: "Import" }));
    const d = await dialog();
    const area = d.getByLabelText("Connections JSON");
    fireEvent.change(area, { target: { value: "" } });
    const importBtn = d.getByRole("button", { name: /^Import/ });
    await call(() => domProps(importBtn).onClick());
    expect(mockApi.importConnections).not.toHaveBeenCalled();
  });
});
