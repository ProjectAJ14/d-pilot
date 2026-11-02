// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./utils/dom.testing";
import { useStore } from "./store";
import App from "./App";

const m = vi.hoisted(() => ({
  api: {
    getSavedQueries: vi.fn(),
    getArtifacts: vi.fn(),
    me: vi.fn(),
    getWriteRequests: vi.fn(),
  },
  loadAppConfig: vi.fn(),
  loadConnections: vi.fn(),
}));
const { stub } = vi.hoisted(() => ({
  stub: (name: string) => () => name,
}));
vi.mock("./utils/api-client", () => ({ api: m.api }));
vi.mock("./utils/app-config", async (orig) => ({
  ...(await orig<typeof import("./utils/app-config")>()),
  loadAppConfig: m.loadAppConfig,
  loadConnections: m.loadConnections,
}));

vi.mock("./components/auth/login-screen", () => ({
  LoginScreen: stub("login-screen"),
}));
vi.mock("./components/layout/top-bar", () => ({ TopBar: stub("top-bar") }));
vi.mock("./components/layout/sidebar", () => ({ Sidebar: stub("sidebar") }));
vi.mock("./components/layout/footer", () => ({ Footer: stub("footer") }));
vi.mock("./components/layout/pwa-prompts", () => ({
  PwaUpdatePrompt: stub("pwa-prompt"),
}));
vi.mock("./components/layout/server-unreachable-banner", () => ({
  ServerUnreachableBanner: stub("banner"),
}));
vi.mock("./components/query/query-workspace", () => ({
  QueryWorkspace: stub("query-workspace"),
}));
vi.mock("./components/phi/phi-config-panel", () => ({
  PhiConfigPanel: stub("phi-config"),
}));
vi.mock("./components/phi/phi-unmask-modal", () => ({
  PhiUnmaskModal: stub("phi-unmask"),
}));
vi.mock("./components/pages/profile-page", () => ({
  ProfilePage: stub("profile-page"),
}));
vi.mock("./components/pages/mcp-setup-page", () => ({
  McpSetupPage: stub("mcp-page"),
}));
vi.mock("./components/pages/settings-page", () => ({
  SettingsPage: stub("settings-page"),
}));
vi.mock("./components/write/write-workspace", () => ({
  WriteWorkspace: stub("write-workspace"),
}));
vi.mock("./components/write/requests-page", () => ({
  RequestsPage: stub("requests-page"),
  countActionRequired: (all: unknown[]) => all.length,
}));
vi.mock("./components/write/write-request-detail", () => ({
  WriteRequestDetail: stub("write-request-detail"),
}));
vi.mock("./components/query/saved-query-link", () => ({
  SavedQueryLink: stub("saved-query-link"),
}));
vi.mock("./components/query/artifact-link", () => ({
  ArtifactLink: stub("artifact-link"),
}));

type U = { canWrite?: boolean; canApprove?: boolean; isAdmin?: boolean };
const signIn = (user: U | null, token: string | null = "tok") =>
  useStore.setState({
    isAuthenticated: true,
    token,
    user: user as never,
    actionRequiredCount: 0,
    serverUnreachable: false,
  });

const shown = (text: string) => document.body.textContent!.includes(text);

const renderAt = (path: string) => {
  window.history.pushState({}, "", path);
  return render(
    <MantineProvider>
      <App />
    </MantineProvider>,
  );
};

beforeEach(() => {
  m.loadAppConfig.mockResolvedValue(undefined);
  m.loadConnections.mockResolvedValue(undefined);
  m.api.getSavedQueries.mockResolvedValue([{ id: 1 }]);
  m.api.getArtifacts.mockResolvedValue([{ id: "a" }]);
  m.api.me.mockResolvedValue({ id: 1, username: "fresh" });
  m.api.getWriteRequests.mockResolvedValue([{ id: 1 }, { id: 2 }]);
});
afterEach(() => {
  vi.clearAllMocks();
  useStore.setState({ isAuthenticated: false, token: null, user: null });
});

describe("App", () => {
  it("shows the login screen and loads config when signed out", async () => {
    useStore.setState({ isAuthenticated: false });
    m.loadAppConfig.mockRejectedValueOnce(new Error("offline"));
    renderAt("/");
    expect(shown("login-screen")).toBe(true);
    expect(shown("pwa-prompt")).toBe(true);
    expect(m.loadAppConfig).toHaveBeenCalledTimes(1);
    expect(m.api.getSavedQueries).not.toHaveBeenCalled();
  });

  it("boots the workspace for a writer and refreshes the user", async () => {
    signIn({ canWrite: true });
    renderAt("/");
    expect(shown("query-workspace")).toBe(true);
    expect(shown("sidebar")).toBe(true);
    await waitFor(() =>
      expect(useStore.getState().actionRequiredCount).toBe(2),
    );
    expect(useStore.getState().savedQueries).toEqual([{ id: 1 }]);
    expect(useStore.getState().artifacts).toEqual([{ id: "a" }]);
    await waitFor(() =>
      expect(useStore.getState().user).toEqual({ id: 1, username: "fresh" }),
    );
    expect(m.loadConnections).toHaveBeenCalled();
  });

  it("reboots when the server comes back, tolerating API failures", async () => {
    signIn({ canApprove: true });
    m.api.me.mockRejectedValue(new Error("down"));
    m.api.getWriteRequests.mockRejectedValue(new Error("down"));
    renderAt("/");
    await waitFor(() =>
      expect(m.api.getWriteRequests).toHaveBeenCalledTimes(1),
    );
    act(() => useStore.setState({ serverUnreachable: true }));
    act(() => useStore.setState({ serverUnreachable: false }));
    await waitFor(() => expect(m.api.getSavedQueries).toHaveBeenCalledTimes(2));
    expect(m.loadAppConfig).toHaveBeenCalledTimes(2);
    expect(useStore.getState().actionRequiredCount).toBe(0);
  });

  it("skips the user refresh and request count without a token or rights", () => {
    signIn(null, null);
    renderAt("/profile");
    expect(shown("profile-page")).toBe(true);
    expect(m.api.me).not.toHaveBeenCalled();
    expect(m.api.getWriteRequests).not.toHaveBeenCalled();
  });

  it.each([
    ["/write", { canWrite: true }, "write-workspace"],
    ["/write", {}, "query-workspace"],
    ["/requests", { canApprove: true }, "requests-page"],
    ["/requests", {}, "query-workspace"],
    ["/settings", { isAdmin: true }, "settings-page"],
    ["/settings", {}, "query-workspace"],
    ["/docs/mcp", {}, "mcp-page"],
    ["/write-requests/7", {}, "write-request-detail"],
    ["/saved-queries/3", {}, "saved-query-link"],
    ["/artifacts/abc", {}, "artifact-link"],
    ["/nowhere", {}, "query-workspace"],
  ])("routes %s for %j to %s", (path, user, expected) => {
    signIn(user);
    renderAt(path);
    expect(shown(expected)).toBe(true);
    if (expected === "query-workspace")
      expect(window.location.pathname).toBe("/");
  });
});
