// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { fireReactHandler } from "../../utils/react-handler.testing";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { notifyError } from "../../utils/notify-error";
import { Card, ProfilePage } from "./profile-page";

vi.mock("../../utils/notify-error", () => ({ notifyError: vi.fn() }));

type User = NonNullable<ReturnType<typeof useStore.getState>["user"]>;
const USER: User = {
  id: "u1",
  username: "jdoe",
  email: "jane@example.com",
  name: "jane mary doe",
  isAdmin: false,
  canUnmaskPhi: false,
  allowedEnvironments: ["DEV", "QA"],
};

function render(route = "/profile") {
  return renderUi(
    <Routes>
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/" element={<div>home page</div>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  localStorage.setItem("dbpilot_token", "tok");
  useStore.setState({ user: USER, viModeEnabled: false });
});

afterEach(() => {
  act(() => {
    notifications.clean();
    notifications.cleanQueue();
  });
  vi.restoreAllMocks();
  vi.mocked(notifyError).mockClear();
});

describe("ProfilePage", () => {
  it("shows identity, initials and per-env access", () => {
    render();
    expect(screen.getAllByText("JM")).toHaveLength(2);
    expect(screen.getAllByText("jane mary doe").length).toBeGreaterThan(0);
    expect(screen.getByText("DEV")).toBeTruthy();
    expect(screen.getByText("QA")).toBeTruthy();
    expect(screen.getAllByText("No access")).toHaveLength(4);
    expect(screen.queryByText("ADMIN")).toBeNull();
  });

  it("shows ALL for an admin", () => {
    useStore.setState({ user: { ...USER, isAdmin: true } });
    render();
    expect(screen.getByText("ADMIN")).toBeTruthy();
    expect(screen.getAllByText("ALL (ADMIN)")).toHaveLength(5);
  });

  it("falls back to the username and a U avatar without a name", () => {
    useStore.setState({
      user: { ...USER, name: "", email: "", allowedEnvironments: undefined },
    });
    render();
    expect(screen.getAllByText("U")).toHaveLength(2);
    expect(screen.getAllByText("jdoe").length).toBeGreaterThan(1);
    expect(screen.getAllByText("No access")).toHaveLength(5);
  });

  it("renders without a signed-in user", () => {
    useStore.setState({ user: null });
    render();
    expect(screen.getAllByText("U")).toHaveLength(2);
    expect(
      (screen.getByText("Save changes").closest("button") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("refuses to save a blank name even if save fires while disabled", async () => {
    const update = vi.spyOn(api, "updateProfile");
    useStore.setState({ user: { ...USER, name: "" } });
    render();
    const save = screen.getByText("Save changes").closest("button")!;
    expect(save.disabled).toBe(true);
    await fireReactHandler(save);
    expect(update).not.toHaveBeenCalled();
  });

  it("navigates sections and back home; unknown tabs show the Account header only", () => {
    render("/profile?tab=bogus");
    expect(screen.getAllByText("Your identity & access")).toHaveLength(2);
    expect(screen.queryByText("Your access")).toBeNull();
    fireEvent.click(screen.getByText("Security"));
    expect(screen.getByText("Change password")).toBeTruthy();
    fireEvent.click(screen.getByText("Back to queries"));
    expect(screen.getByText("home page")).toBeTruthy();
  });

  it("copies the email", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render();
    const btn = container.querySelector(
      ".mantine-ActionIcon-root",
    ) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("jane@example.com"),
    );
  });

  it("saves a new display name and updates the session", async () => {
    const update = vi
      .spyOn(api, "updateProfile")
      .mockResolvedValue({ displayName: "Jane D" } as never);
    render();
    const input = screen.getByPlaceholderText("Your display name");
    const save = screen.getByText("Save changes").closest("button")!;
    expect(save.disabled).toBe(true); // unchanged
    fireEvent.change(input, { target: { value: "  Jane D " } });
    fireEvent.click(save);
    expect(await screen.findByText("Profile updated")).toBeTruthy();
    expect(update).toHaveBeenCalledWith({ displayName: "Jane D" });
    expect(useStore.getState().user?.name).toBe("Jane D");
    expect(useStore.getState().token).toBe("tok");
  });

  it("skips the session update if signed out mid-save", async () => {
    vi.spyOn(api, "updateProfile").mockResolvedValue({
      displayName: "X",
    } as never);
    render();
    fireEvent.change(screen.getByPlaceholderText("Your display name"), {
      target: { value: "X" },
    });
    act(() => useStore.setState({ user: null }));
    fireEvent.click(screen.getByText("Save changes"));
    expect(await screen.findByText("Profile updated")).toBeTruthy();
    expect(useStore.getState().user).toBeNull();
  });

  it("reports a failed profile update", async () => {
    const err = new Error("nope");
    vi.spyOn(api, "updateProfile").mockRejectedValue(err);
    render();
    fireEvent.change(screen.getByPlaceholderText("Your display name"), {
      target: { value: "Other" },
    });
    fireEvent.click(screen.getByText("Save changes"));
    await waitFor(() =>
      expect(notifyError).toHaveBeenCalledWith(err, "Profile"),
    );
  });

  describe("security", () => {
    const fill = (cur: string, next: string, confirm: string) => {
      fireEvent.change(screen.getByLabelText("Current password"), {
        target: { value: cur },
      });
      fireEvent.change(screen.getByLabelText("New password"), {
        target: { value: next },
      });
      fireEvent.change(screen.getByLabelText("Confirm new password"), {
        target: { value: confirm },
      });
    };
    const submit = () => fireEvent.click(screen.getByText("Update password"));

    it("rates password strength", () => {
      render("/profile?tab=security");
      const newPw = screen.getByLabelText("New password");
      fireEvent.change(newPw, { target: { value: "abc" } });
      expect(screen.getByText("Weak")).toBeTruthy();
      fireEvent.change(newPw, { target: { value: "abcdefgh" } });
      expect(screen.getByText("Fair")).toBeTruthy();
      fireEvent.change(newPw, { target: { value: "Abcdefgh1!" } });
      expect(screen.getByText("Strong")).toBeTruthy();
    });

    it("validates length and match before calling the API", async () => {
      const change = vi.spyOn(api, "changePassword");
      render("/profile?tab=security");
      expect(
        (
          screen
            .getByText("Update password")
            .closest("button") as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fill("old", "short", "short");
      submit();
      expect(
        await screen.findByText("New password must be at least 8 characters"),
      ).toBeTruthy();
      fill("old", "longenough", "different");
      expect(screen.getAllByText("Passwords do not match")).toHaveLength(1);
      submit();
      await waitFor(() =>
        expect(screen.getAllByText("Passwords do not match")).toHaveLength(2),
      );
      expect(change).not.toHaveBeenCalled();
    });

    it("refuses an empty form even if update fires while disabled", async () => {
      const change = vi.spyOn(api, "changePassword");
      render("/profile?tab=security");
      await fireReactHandler(
        screen.getByText("Update password").closest("button")!,
      );
      expect(
        await screen.findByText("All password fields are required"),
      ).toBeTruthy();
      expect(change).not.toHaveBeenCalled();
    });

    it("changes the password and clears the form", async () => {
      const change = vi
        .spyOn(api, "changePassword")
        .mockResolvedValue({} as never);
      render("/profile?tab=security");
      fill("old", "longenough", "longenough");
      submit();
      expect(
        await screen.findByText("Password changed successfully"),
      ).toBeTruthy();
      expect(change).toHaveBeenCalledWith("old", "longenough");
      expect(
        (screen.getByLabelText("Current password") as HTMLInputElement).value,
      ).toBe("");
    });

    it("reports a failed change", async () => {
      const err = new Error("wrong");
      vi.spyOn(api, "changePassword").mockRejectedValue(err);
      render("/profile?tab=security");
      fill("old", "longenough", "longenough");
      submit();
      await waitFor(() =>
        expect(notifyError).toHaveBeenCalledWith(err, "Profile"),
      );
    });
  });

  it("toggles vim mode in preferences", () => {
    render("/profile?tab=user-settings");
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    expect(useStore.getState().viModeEnabled).toBe(true);
  });
});

describe("Card", () => {
  it("renders without a description", () => {
    renderUi(
      <Card icon={null} title="Plain">
        body
      </Card>,
    );
    expect(screen.getByText("Plain")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });
});
