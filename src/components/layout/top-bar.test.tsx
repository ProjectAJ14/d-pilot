// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { TopBar } from "./top-bar";

const { openUnmask } = vi.hoisted(() => ({ openUnmask: vi.fn() }));
vi.mock("../phi/phi-unmask-modal", () => ({
  PhiUnmaskModal: Object.assign(() => null, { open: openUnmask }),
}));

function Where() {
  return <output data-testid="path">{useLocation().pathname}</output>;
}
const path = () => screen.getByTestId("path").textContent;

const initialConfig = useStore.getState().config;
const conns = [
  { id: "dev", name: "app_core dev", env: "DEV" },
  { id: "prod", name: "app_core prod", env: "PROD" },
] as never;

type U = Record<string, unknown>;
const setup = (
  user: U | null,
  {
    active = "dev",
    phi = true,
    route = "/",
    count = 0,
  }: {
    active?: string | null;
    phi?: boolean;
    route?: string;
    count?: number;
  } = {},
) => {
  useStore.setState({
    user: user as never,
    connections: conns,
    activeConnectionId: active,
    phiEnabled: phi,
    actionRequiredCount: count,
    phiPanelOpen: false,
  });
  return renderUi(
    <>
      <TopBar />
      <Where />
    </>,
    { route },
  );
};

const openMenu = async () => {
  fireEvent.click(screen.getByRole("button", { name: /Account menu/ }));
  return screen.findByRole("menu");
};

beforeEach(() => {
  openUnmask.mockReset();
  useStore.setState({
    config: initialConfig,
    isAuthenticated: true,
    token: "t",
  });
});

describe("TopBar", () => {
  it("shows the read-only nav and a READ badge for a plain reader", async () => {
    setup({ username: "reader" });
    expect(
      screen.getByRole("button", { name: /Read/ }).getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.queryByRole("button", { name: /^Write/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Requests/ })).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Account menu for reader" })
        .textContent,
    ).toBe("U");
    await openMenu();
    expect(screen.getByText("READ")).toBeTruthy();
    expect(screen.getByText("Token Configuration")).toBeTruthy();
  });

  it("navigates between workspaces and shows the pending-request badge", () => {
    setup(
      { name: "ada lovelace king", canWrite: true },
      { route: "/write", count: 3 },
    );
    expect(
      screen
        .getByRole("button", { name: /^Write/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("button", { name: /Requests/ }).textContent,
    ).toContain("3");
    expect(
      screen.getByRole("button", { name: /Account menu for ada/ }).textContent,
    ).toBe("AL");
    fireEvent.click(screen.getByRole("button", { name: /Requests/ }));
    expect(path()).toBe("/requests");
    fireEvent.click(screen.getByRole("button", { name: /^Write/ }));
    expect(path()).toBe("/write");
    fireEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(path()).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: /Go to dashboard/ }));
    expect(path()).toBe("/");
  });

  it("shows an approver only the Requests tab, active on /requests", async () => {
    setup(
      { username: "appr", canApprove: true, canUnmaskPhi: true },
      { route: "/requests" },
    );
    expect(screen.queryByRole("button", { name: /^Write/ })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Requests/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    await openMenu();
    expect(screen.getByText("PHI")).toBeTruthy();
    expect(screen.getByText("APPROVE")).toBeTruthy();
    expect(screen.queryByText("READ")).toBeNull();
  });

  it("shows a writer the WRITE badge", async () => {
    setup({ username: "writer", canWrite: true });
    await openMenu();
    expect(screen.getByText("WRITE")).toBeTruthy();
  });

  it.each([
    ["Profile", "/profile"],
    ["Connect an AI agent", "/docs/mcp"],
  ])("menu item %s navigates to %s", async (item, to) => {
    setup({ username: "writer" });
    await openMenu();
    fireEvent.click(screen.getByText(item));
    expect(path()).toBe(to);
  });

  it("opens the token panel for non-admins", async () => {
    setup({ username: "writer" });
    await openMenu();
    fireEvent.click(screen.getByText("Token Configuration"));
    expect(useStore.getState().phiPanelOpen).toBe(true);
  });

  it("signs out", async () => {
    setup({ username: "writer" });
    await openMenu();
    fireEvent.click(screen.getByText("Sign Out"));
    expect(useStore.getState().isAuthenticated).toBe(false);
  });

  it("gives admins Settings and an ADMIN badge", async () => {
    setup({ name: "Root", isAdmin: true });
    await openMenu();
    expect(screen.getByText("ADMIN")).toBeTruthy();
    fireEvent.click(screen.getByText("Settings"));
    expect(path()).toBe("/settings");
  });

  it("labels the account menu generically without a user", () => {
    setup(null);
    expect(
      screen.getByRole("button", { name: "Account menu for user" }),
    ).toBeTruthy();
  });

  describe("PHI toggle", () => {
    const toggle = () =>
      screen.getByRole("button", { name: /PHI (tokenized|visible)/ });

    it("re-tokenizes when PHI is visible", async () => {
      setup({ username: "u" }, { phi: false });
      expect(toggle().getAttribute("aria-pressed")).toBe("true");
      expect(toggle().textContent).toContain("PHI Visible");
      fireEvent.click(toggle());
      expect(useStore.getState().phiEnabled).toBe(true);
      expect(await screen.findByText("PHI re-tokenized")).toBeTruthy();
    });

    it("refuses without unmask rights on the active env", async () => {
      setup({ username: "u", unmaskEnvironments: ["QA"] });
      fireEvent.click(toggle());
      expect(
        await screen.findByText("You cannot de-tokenize PHI in DEV"),
      ).toBeTruthy();
      expect(useStore.getState().phiEnabled).toBe(true);
    });

    it("asks for a connection when none is active", async () => {
      setup({ username: "u" }, { active: null });
      fireEvent.click(toggle());
      expect(await screen.findByText("Select a connection first")).toBeTruthy();
    });

    it("unmasks directly on an unmasked env the user may unmask", async () => {
      setup({ username: "u", unmaskEnvironments: ["DEV"] });
      fireEvent.click(toggle());
      expect(useStore.getState().phiEnabled).toBe(false);
      expect(
        await screen.findByText("PHI visible — access logged"),
      ).toBeTruthy();
      expect(openUnmask).not.toHaveBeenCalled();
    });

    it("opens the justification modal on a masked env", () => {
      setup({ username: "u", isAdmin: true }, { active: "prod" });
      fireEvent.click(toggle());
      expect(openUnmask).toHaveBeenCalled();
      expect(useStore.getState().phiEnabled).toBe(true);
    });
  });

  describe("logo", () => {
    const renderScheme = (scheme: "light" | "dark") =>
      render(
        <MantineProvider forceColorScheme={scheme}>
          <MemoryRouter>
            <TopBar />
          </MemoryRouter>
        </MantineProvider>,
      );

    it.each([
      ["light", "/dark.svg", "/light.svg", "/dark.svg"],
      ["light", null, "/light.svg", "/light.svg"],
      ["dark", "/dark.svg", "/light.svg", "/light.svg"],
      ["dark", "/dark.svg", null, "/dark.svg"],
    ] as const)(
      "%s scheme, logo %s / light %s -> %s",
      (scheme, logoUrl, lightLogoUrl, src) => {
        useStore.setState({
          user: null,
          config: {
            ...initialConfig,
            appName: "Acme SQL",
            logoUrl,
            lightLogoUrl,
          },
        });
        renderScheme(scheme);
        expect(
          screen.getByRole("img", { name: "Acme SQL" }).getAttribute("src"),
        ).toBe(src);
      },
    );
  });
});
