// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { useStore } from "../../store";
import { ServerUnreachableBanner } from "./server-unreachable-banner";

const { ping } = vi.hoisted(() => ({ ping: vi.fn() }));
vi.mock("../../utils/api-client", () => ({ api: { ping } }));

const setOnline = (value: boolean) =>
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => value,
  });

afterEach(() => {
  setOnline(true);
  ping.mockReset();
  useStore.setState({ serverUnreachable: false });
});

describe("ServerUnreachableBanner", () => {
  it("stays silent and does not ping while the server is reachable", () => {
    renderUi(<ServerUnreachableBanner />);
    expect(screen.getByRole("status").textContent).toBe("");
    window.dispatchEvent(new Event("online"));
    expect(ping).not.toHaveBeenCalled();
  });

  it("shows the network hint and retries on the online event", async () => {
    ping.mockResolvedValue(false);
    useStore.setState((s) => ({
      serverUnreachable: true,
      config: { ...s.config, networkHint: "Connect to the corporate VPN." },
    }));
    const { unmount } = renderUi(<ServerUnreachableBanner />);
    expect(screen.getByRole("status").textContent).toContain(
      "Connect to the corporate VPN.",
    );
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(ping).toHaveBeenCalledTimes(1);
    unmount();
    window.dispatchEvent(new Event("online"));
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it("says offline when the browser is offline, and follows it back", () => {
    setOnline(false);
    useStore.setState({ serverUnreachable: true });
    renderUi(<ServerUnreachableBanner />);
    expect(screen.getByRole("status").textContent).toContain("You're offline");
    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status").textContent).toContain(
      "Can't reach the D-Pilot server.",
    );
  });
});
