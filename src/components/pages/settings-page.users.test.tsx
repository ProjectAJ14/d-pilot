// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { copyToClipboard } from "../../utils/clipboard";
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
vi.mock("../../utils/clipboard", () => ({ copyToClipboard: vi.fn() }));
vi.mock("../../utils/password", () => ({
  generatePassword: vi.fn(() => "Generated-Pass-01"),
}));

const alice = {
  id: "u1",
  email: "alice@example.com",
  username: "alice@example.com",
  displayName: "Alice Smith",
  isAdmin: true,
  allowedEnvironments: [],
  lastLogin: "2026-01-02T00:00:00Z",
};
const bob = {
  id: "u2",
  email: "",
  username: "bob",
  displayName: "Bob",
  isAdmin: false,
  allowedEnvironments: ["DEV"],
  unmaskEnvironments: ["DEV"],
  writeEnvironments: ["QA"],
  approveEnvironments: ["QA"],
  jobEnvironments: ["QA"],
  lastLogin: null,
};
const carol = {
  id: "u3",
  email: "carol@example.com",
  username: "carol@example.com",
  displayName: "",
  isAdmin: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockApi)) mockApi[k].mockReset();
  setEnvironments(["PROD", "QA", "DEV"]);
  useStore.setState((s) => ({
    user: { ...alice } as never,
    config: { ...s.config, emailDomain: null, appName: "D-Pilot" },
  }));
});

async function openUsers(users: unknown[] = [alice, bob, carol]) {
  mockApi.getUsers.mockResolvedValue(users);
  renderSettings("users");
  await waitFor(() => expect(mockApi.getUsers).toHaveBeenCalled());
}

describe("SettingsPage shell", () => {
  it("defaults to Analytics and switches sections from the sidebar", async () => {
    mockApi.getAnalytics.mockReturnValue(new Promise(() => {}));
    mockApi.getConnectionStatus.mockResolvedValue([]);
    mockApi.getUsers.mockResolvedValue([]);
    renderSettings();
    expect(screen.getByText("Crunching usage data…")).toBeTruthy();
    await user().click(screen.getByText("User Management"));
    await waitFor(() =>
      expect(screen.getByText("No users found")).toBeTruthy(),
    );
  });

  it("treats a signed-out viewer as no current user", async () => {
    useStore.setState({ user: null });
    mockApi.getUsers.mockResolvedValue([alice]);
    renderSettings("users");
    expect(await screen.findByText("Alice Smith")).toBeTruthy();
    expect(screen.queryByText("(you)")).toBeNull();
  });

  it("falls back to the first section for an unknown tab and navigates back", async () => {
    mockApi.getAnalytics.mockReturnValue(new Promise(() => {}));
    mockApi.getConnectionStatus.mockResolvedValue([]);
    renderSettings("nope");
    expect(screen.getAllByText("Analytics").length).toBeGreaterThan(0);
    await user().click(screen.getByText("Back to queries"));
  });
});

describe("User management", () => {
  it("lists users with capabilities, initials and last login", async () => {
    await openUsers();
    await waitFor(() => expect(screen.getByText("3 users")).toBeTruthy());
    expect(screen.getByText("Admin — full access")).toBeTruthy();
    expect(screen.getByText("Read: DEV")).toBeTruthy();
    expect(screen.getByText("Change jobs: QA")).toBeTruthy();
    expect(screen.getByText("No access")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("AS")).toBeTruthy();
    expect(screen.getByText("BO")).toBeTruthy();
    expect(screen.getByText("?")).toBeTruthy();
    expect(screen.getByText("bob")).toBeTruthy();
    expect(screen.getAllByText("Never")).toHaveLength(2);
  });

  it("filters by search and says when nothing matches", async () => {
    await openUsers();
    const u = user();
    await waitFor(() => expect(screen.getByText("3 users")).toBeTruthy());
    await u.type(screen.getByLabelText("Search users"), "bob");
    expect(screen.getByText("1 of 3 users")).toBeTruthy();
    await u.type(screen.getByLabelText("Search users"), "zzz");
    expect(screen.getByText('No user matches "bobzzz"')).toBeTruthy();
  });

  it("matches capability environments", async () => {
    await openUsers();
    const u = user();
    await waitFor(() => expect(screen.getByText("3 users")).toBeTruthy());
    await u.type(screen.getByLabelText("Search users"), "qa");
    expect(screen.getByText("1 of 3 users")).toBeTruthy();
    expect(screen.getByText("Change jobs: QA")).toBeTruthy();
  });

  it("pages past 25 users and returns to page 1 on search", async () => {
    await openUsers(
      Array.from({ length: 30 }, (_, i) => ({
        ...bob,
        id: `u${i + 1}`,
        username: `user${String(i + 1).padStart(2, "0")}`,
        email: `user${String(i + 1).padStart(2, "0")}@x.test`,
        displayName: `Person ${String(i + 1).padStart(2, "0")}`,
      })),
    );
    const u = user();
    await screen.findByText("Person 01");
    expect(screen.queryByText("Person 26")).toBeNull();
    await u.click(screen.getByRole("button", { name: "2" }));
    expect(screen.getByText("Person 26")).toBeTruthy();
    await u.type(screen.getByLabelText("Search users"), "Person 0");
    expect(screen.getByText("Person 01")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "2" })).toBeNull();
  });

  it("shows a single user without a plural and reports a load failure", async () => {
    await openUsers([bob]);
    await waitFor(() => expect(screen.getByText("1 user")).toBeTruthy());
  });

  it("notifies when loading users fails", async () => {
    mockApi.getUsers.mockRejectedValue(new Error("users down"));
    renderSettings("users");
    await waitFor(() => expect(screen.getByText("users down")).toBeTruthy());
  });

  it("creates a user, validating the email and password first", async () => {
    await openUsers([]);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Add User" }));
    const d = await dialog();
    const pw = d.getByPlaceholderText("At least 8 characters");
    expect((pw as HTMLInputElement).value).toBe("Generated-Pass-01");

    await u.type(d.getByLabelText("Email"), "newbie");
    await u.click(d.getByRole("button", { name: "Create User" }));
    expect(
      await screen.findByText("A valid email address is required"),
    ).toBeTruthy();

    await u.type(d.getByLabelText("Email"), "@example.com");
    await u.clear(pw);
    await u.type(pw, "short");
    await u.click(d.getByRole("button", { name: "Create User" }));
    expect(
      await screen.findByText("Password must be at least 8 characters"),
    ).toBeTruthy();
    expect(mockApi.createUser).not.toHaveBeenCalled();

    await u.click(d.getByRole("button", { name: "Generate" }));
    // Grant read on DEV through the multiselect.
    await u.click(d.getByLabelText("Read environments"));
    // Every multiselect keeps its options mounted; the first set is Read's.
    await u.click(
      (await screen.findAllByRole("option", { name: "DEV", hidden: true }))[0],
    );

    mockApi.createUser.mockResolvedValue({});
    await u.click(d.getByRole("button", { name: "Create User" }));
    await waitFor(() =>
      expect(mockApi.createUser).toHaveBeenCalledWith({
        email: "newbie@example.com",
        displayName: "newbie",
        password: "Generated-Pass-01",
        isAdmin: false,
        allowedEnvironments: ["DEV"],
        unmaskEnvironments: [],
        writeEnvironments: [],
        approveEnvironments: [],
        jobEnvironments: [],
      }),
    );
    expect(mockApi.getUsers).toHaveBeenCalledTimes(2);
    // Credentials handoff
    expect(
      await screen.findByText("User created — share credentials"),
    ).toBeTruthy();
    const msg = screen.getByDisplayValue(/You've been given access to D-Pilot/);
    expect((msg as HTMLTextAreaElement).value).toContain(
      "Password: Generated-Pass-01",
    );
    expect((msg as HTMLTextAreaElement).value).toContain("Hi newbie,");
  });

  it("enforces the configured email domain and shows admin-only fields", async () => {
    useStore.setState((s) => ({
      config: { ...s.config, emailDomain: "example.com" },
    }));
    await openUsers([]);
    const u = user();
    await u.click(screen.getByRole("button", { name: "Add User" }));
    const d = await dialog();
    expect(d.getByText("Must be a @example.com address")).toBeTruthy();
    await u.type(d.getByLabelText("Email"), "x@other.com");
    await u.click(d.getByRole("button", { name: "Create User" }));
    expect(
      await screen.findByText("Email must be a @example.com address"),
    ).toBeTruthy();

    await u.clear(d.getByLabelText("Email"));
    await u.type(d.getByLabelText("Email"), "x@example.com");
    await u.type(d.getByLabelText("Display Name"), "Xavier Admin");
    await u.click(d.getByLabelText(/Administrator/));
    expect(d.queryByLabelText("Read environments")).toBeNull();
    mockApi.createUser.mockRejectedValue(new Error("duplicate email"));
    await u.click(d.getByRole("button", { name: "Create User" }));
    expect(await screen.findByText("duplicate email")).toBeTruthy();
    expect(mockApi.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ isAdmin: true, displayName: "Xavier Admin" }),
    );
    await u.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("edits a user's capabilities, keeping orphan envs pickable", async () => {
    const orphan = { ...bob, allowedEnvironments: ["OLD"] };
    await openUsers([orphan]);
    const u = user();
    await waitFor(() => expect(screen.getByText("1 user")).toBeTruthy());
    const row = screen.getByText("Bob").closest("tr")!;
    await u.click(within(row).getAllByRole("button")[0]);
    const d = await dialog();
    expect((d.getByLabelText("Email") as HTMLInputElement).value).toBe("bob");
    await u.click(d.getByLabelText("Read environments"));
    expect(
      await screen.findByRole("option", {
        name: "OLD (no connection)",
        hidden: true,
      }),
    ).toBeTruthy();
    await u.clear(d.getByLabelText("Display Name"));
    await u.type(d.getByLabelText("Display Name"), "Robert");
    mockApi.updateUser.mockResolvedValue({});
    await u.click(d.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateUser).toHaveBeenCalledWith("u2", {
        displayName: "Robert",
        isAdmin: false,
        allowedEnvironments: ["OLD"],
        unmaskEnvironments: ["DEV"],
        writeEnvironments: ["QA"],
        approveEnvironments: ["QA"],
        jobEnvironments: ["QA"],
      }),
    );
    expect(await screen.findByText("User updated")).toBeTruthy();
  });

  it("edits a user with empty capability lists and reports failure", async () => {
    await openUsers([carol]);
    const u = user();
    await waitFor(() => expect(screen.getByText("1 user")).toBeTruthy());
    const row = screen.getByText("carol@example.com").closest("tr")!;
    await u.click(within(row).getAllByRole("button")[0]);
    mockApi.updateUser.mockRejectedValue(new Error("update failed"));
    await u.click((await dialog()).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("update failed")).toBeTruthy();
    expect(mockApi.updateUser).toHaveBeenCalledWith(
      "u3",
      expect.objectContaining({
        allowedEnvironments: [],
        jobEnvironments: [],
        isAdmin: false,
      }),
    );
    await u.click((await dialog()).getByRole("button", { name: "Cancel" }));
  });

  it("deletes a user, but never yourself", async () => {
    await openUsers([alice, bob]);
    const u = user();
    await waitFor(() => expect(screen.getByText("2 users")).toBeTruthy());
    const self = screen.getByText("Alice Smith").closest("tr")!;
    expect(
      (within(self).getAllByRole("button")[2] as HTMLButtonElement).disabled,
    ).toBe(true);
    const row = screen.getByText("Bob").closest("tr")!;
    await u.click(within(row).getAllByRole("button")[2]);
    mockApi.deleteUser.mockRejectedValueOnce(new Error("delete failed"));
    await u.click(
      (await dialog()).getByRole("button", { name: "Delete User" }),
    );
    expect(await screen.findByText("delete failed")).toBeTruthy();
    mockApi.deleteUser.mockResolvedValue({});
    await u.click(
      (await dialog()).getByRole("button", { name: "Delete User" }),
    );
    await waitFor(() => expect(mockApi.deleteUser).toHaveBeenCalledWith("u2"));
    expect(await screen.findByText("User deleted")).toBeTruthy();
    await u.click(within(row).getAllByRole("button")[2]);
    await u.click((await dialog()).getByRole("button", { name: "Cancel" }));
  });

  it("resets a password and hands over the new credentials", async () => {
    await openUsers([bob, alice, carol]);
    const u = user();
    await waitFor(() => expect(screen.getByText("3 users")).toBeTruthy());
    const row = screen.getByText("Bob").closest("tr")!;
    await u.click(within(row).getAllByRole("button")[1]);
    const d = await dialog();
    const reset = d.getByRole("button", { name: "Reset Password" });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    await u.type(d.getByPlaceholderText("At least 8 characters"), "abc");
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    await u.click(d.getByRole("button", { name: "Generate" }));
    mockApi.resetUserPassword.mockRejectedValueOnce(new Error("reset failed"));
    await u.click(reset);
    expect(await screen.findByText("reset failed")).toBeTruthy();
    mockApi.resetUserPassword.mockResolvedValue({});
    await u.click(reset);
    await waitFor(() =>
      expect(mockApi.resetUserPassword).toHaveBeenCalledWith(
        "u2",
        "Generated-Pass-01",
      ),
    );
    expect(
      await screen.findByText("Password reset — share new credentials"),
    ).toBeTruthy();
    const c = await dialog();
    const msg = c.getByDisplayValue(/password has been reset/);
    expect((msg as HTMLTextAreaElement).value).toContain("Username: bob");
    expect((msg as HTMLTextAreaElement).value).toContain(
      "You can sign in with these right away.",
    );
    const usernameRow = c.getByText("Username").closest(".mantine-Group-root");
    await u.click(within(usernameRow as HTMLElement).getByRole("button"));
    expect(copyToClipboard).toHaveBeenCalledWith("bob", "Username");
    await u.click(c.getByRole("button", { name: "Copy message" }));
    // user-event installs its own clipboard; read back what was copied.
    expect(await navigator.clipboard.readText()).toContain("Hi Bob,");
    expect(await c.findByText("Message copied")).toBeTruthy();
    await u.click(c.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // A user without a display name is greeted by email.
    const row3 = screen.getByText("carol@example.com").closest("tr")!;
    await u.click(within(row3).getAllByRole("button")[1]);
    const r3 = await dialog();
    await u.click(r3.getByRole("button", { name: "Generate" }));
    await u.click(r3.getByRole("button", { name: "Reset Password" }));
    expect(
      await screen.findByDisplayValue(/^Hi carol@example.com,/),
    ).toBeTruthy();
    await u.click((await dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    // Reopen for the other user; cancel closes it.
    const row2 = screen.getByText("Alice Smith").closest("tr")!;
    await u.click(within(row2).getAllByRole("button")[1]);
    await u.click((await dialog()).getByRole("button", { name: "Cancel" }));
  });
});
