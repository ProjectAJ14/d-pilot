// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { PhiConfigPanel } from "./phi-config-panel";

vi.mock("../../utils/api-client", () => ({
  api: { getPhiRules: vi.fn() },
}));

const getPhiRules = vi.mocked(api.getPhiRules);

function setEnvs(environments: string[], phiMaskedEnvironments: string[]) {
  useStore.setState((s) => ({
    config: { ...s.config, environments, phiMaskedEnvironments },
  }));
}

beforeEach(() => {
  getPhiRules.mockReset();
  useStore.setState({ phiPanelOpen: false });
});

describe("PhiConfigPanel", () => {
  it("loads rules only once opened, with icons and the LOCKED marker", async () => {
    getPhiRules.mockResolvedValue([
      { id: "1", pattern: "*email*", maskingType: "FULL", alwaysMasked: true },
      {
        id: "2",
        pattern: "*account_code*",
        maskingType: "PARTIAL",
        alwaysMasked: false,
      },
    ] as never);
    setEnvs(["PROD", "QA", "DEV"], ["PROD"]);
    renderUi(<PhiConfigPanel />);
    expect(getPhiRules).not.toHaveBeenCalled();

    useStore.setState({ phiPanelOpen: true });
    await waitFor(() => expect(screen.getByText("email")).toBeTruthy());
    expect(screen.getByText("✉️")).toBeTruthy();
    expect(screen.getByText("🔐")).toBeTruthy();
    expect(screen.getByText("account_code")).toBeTruthy();
    expect(screen.getAllByText("LOCKED")).toHaveLength(1);
    // Scope: PROD masked; the rest (reversed order) return real values.
    expect(screen.getByText("PROD")).toBeTruthy();
    expect(screen.getByText("DEV")).toBeTruthy();
    expect(screen.getByText("QA")).toBeTruthy();
    expect(screen.getByText(/connections return real values/)).toBeTruthy();
  });

  it("lists several masked envs, and none when the list is empty", async () => {
    getPhiRules.mockRejectedValue(new Error("down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    useStore.setState({ phiPanelOpen: true });
    setEnvs(["PROD", "STG"], ["PROD", "STG"]);
    const { unmount } = renderUi(<PhiConfigPanel />);
    await waitFor(() => expect(err).toHaveBeenCalled());
    expect(screen.getByText("STG")).toBeTruthy();
    expect(screen.queryByText(/connections return real values/)).toBeNull();
    unmount();

    setEnvs([], []);
    renderUi(<PhiConfigPanel />);
    expect(screen.getByText("no environments")).toBeTruthy();
    err.mockRestore();
  });

  it("closes via the X button", async () => {
    getPhiRules.mockResolvedValue([]);
    useStore.setState({ phiPanelOpen: true });
    renderUi(<PhiConfigPanel />);
    await userEvent.click(screen.getByRole("button"));
    expect(useStore.getState().phiPanelOpen).toBe(false);
  });
});
