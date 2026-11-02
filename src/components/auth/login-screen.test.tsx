// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { LoginScreen } from "./login-screen";

const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../../utils/api-client", () => ({ api: { login } }));

const initialConfig = useStore.getState().config;
const user = { id: 1, username: "alice", isAdmin: false } as never;

beforeEach(() => {
  useStore.setState({ config: initialConfig, isAuthenticated: false });
});
afterEach(() => login.mockReset());

const fill = (email: string, password: string) => {
  fireEvent.change(screen.getByLabelText("EMAIL"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("PASSWORD"), {
    target: { value: password },
  });
};

describe("LoginScreen", () => {
  it("shows default branding with no logo and a generic email hint", () => {
    renderUi(<LoginScreen />);
    expect(screen.getByRole("heading", { name: "D-Pilot" })).toBeTruthy();
    expect(screen.getByText("Internal query tool")).toBeTruthy();
    expect(screen.getByText("HIPAA · PHI tokenized")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByPlaceholderText("user@example.com")).toBeTruthy();
    expect(screen.getByText(/Use your organization/)).toBeTruthy();
  });

  it("uses the configured domain, logos and hides blank taglines", () => {
    useStore.setState({
      config: {
        ...initialConfig,
        appName: "Acme SQL",
        logoUrl: "/logo.svg",
        lightLogoUrl: null,
        emailDomain: "example.org",
        loginTagline: "",
        loginSubtitle: "",
      },
    });
    const { unmount } = renderUi(<LoginScreen />);
    expect(
      screen.getByRole("img", { name: "Acme SQL" }).getAttribute("src"),
    ).toBe("/logo.svg");
    expect(screen.getByPlaceholderText("user@example.org")).toBeTruthy();
    expect(screen.getByText(/Use your @example.org/)).toBeTruthy();
    expect(screen.queryByText("Internal query tool")).toBeNull();
    unmount();

    useStore.setState((s) => ({
      config: { ...s.config, lightLogoUrl: "/light.svg" },
    }));
    renderUi(<LoginScreen />);
    expect(screen.getByRole("img").getAttribute("src")).toBe("/light.svg");
  });

  it("requires both fields before calling the API", () => {
    renderUi(<LoginScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Sign In/ }));
    expect(screen.getByText("Username and password are required")).toBeTruthy();
    fill("alice@example.com", "");
    fireEvent.click(screen.getByRole("button", { name: /Sign In/ }));
    expect(login).not.toHaveBeenCalled();
  });

  it("signs in on Enter and stores the session", async () => {
    login.mockResolvedValue({ token: "tok", user });
    renderUi(<LoginScreen />);
    fill("alice@example.com", "secret");
    fireEvent.keyDown(screen.getByLabelText("EMAIL"), { key: "a" });
    expect(login).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("PASSWORD"), { key: "Enter" });
    await waitFor(() => expect(useStore.getState().isAuthenticated).toBe(true));
    expect(login).toHaveBeenCalledWith("alice@example.com", "secret");
    expect(useStore.getState().token).toBe("tok");
  });

  it("shows the server's error, or the unreachable message", async () => {
    login.mockRejectedValueOnce(new Error("Invalid credentials"));
    renderUi(<LoginScreen />);
    fill("alice@example.com", "wrong");
    fireEvent.click(screen.getByRole("button", { name: /Sign In/ }));
    expect(await screen.findByText("Invalid credentials")).toBeTruthy();

    login.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "SERVER_UNREACHABLE" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Sign In/ }));
    expect(
      await screen.findByText(/Can't reach the D-Pilot server/),
    ).toBeTruthy();
    expect(useStore.getState().isAuthenticated).toBe(false);
  });
});
