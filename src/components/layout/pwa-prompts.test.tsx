// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { InstallAppButton, PwaUpdatePrompt } from "./pwa-prompts";

const sw = vi.hoisted(() => ({
  needRefresh: false,
  setNeedRefresh: vi.fn(),
  updateServiceWorker: vi.fn(),
  options: null as null | { onRegisterError?: (e: unknown) => void },
}));
vi.mock("virtual:pwa-register/react", () => ({
  useRegisterSW: (options: typeof sw.options) => {
    sw.options = options;
    return {
      needRefresh: [sw.needRefresh, sw.setNeedRefresh],
      updateServiceWorker: sw.updateServiceWorker,
    };
  },
}));

afterEach(() => {
  sw.needRefresh = false;
  sw.setNeedRefresh.mockReset();
  sw.updateServiceWorker.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("PwaUpdatePrompt", () => {
  it("shows nothing until a new build is waiting, and logs registration errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderUi(<PwaUpdatePrompt />);
    expect(screen.queryByText("New version available")).toBeNull();
    sw.options?.onRegisterError?.(new Error("insecure origin"));
    expect(warn).toHaveBeenCalledWith(
      "[pwa] service worker registration failed",
      expect.any(Error),
    );
  });

  it("reloads once the new worker takes control", async () => {
    const worker = new EventTarget();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: worker,
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sw.needRefresh = true;
    sw.updateServiceWorker.mockImplementation(async () => {
      worker.dispatchEvent(new Event("controllerchange"));
    });
    renderUi(<PwaUpdatePrompt />);
    expect(await screen.findByText("New version available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(sw.updateServiceWorker).toHaveBeenCalledWith(true);
    expect(screen.getByText("Reloading…")).toBeTruthy();
  });

  it("reloads after a timeout when no worker is there to take control", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    sw.needRefresh = true;
    sw.updateServiceWorker.mockResolvedValue(undefined);
    renderUi(<PwaUpdatePrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(reload).toHaveBeenCalled();
  });

  it("dismissing the toast clears the waiting flag; unmount hides it", async () => {
    sw.needRefresh = true;
    const { unmount } = renderUi(<PwaUpdatePrompt />);
    await screen.findByText("New version available");
    const close = document.querySelector<HTMLButtonElement>(
      ".mantine-Notification-closeButton",
    )!;
    fireEvent.click(close);
    await waitFor(() => expect(sw.setNeedRefresh).toHaveBeenCalledWith(false));
    unmount();
  });
});

describe("InstallAppButton", () => {
  it("appears when the browser offers install, prompts, then goes away", async () => {
    renderUi(<InstallAppButton />);
    expect(screen.queryByText("Install")).toBeNull();

    const event = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      {
        prompt: vi.fn().mockResolvedValue(undefined),
      },
    );
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Install/ }));
    await waitFor(() => expect(screen.queryByText("Install")).toBeNull());
    expect(event.prompt).toHaveBeenCalled();
  });

  it("hides once the app is installed", () => {
    renderUi(<InstallAppButton />);
    act(() => {
      window.dispatchEvent(
        Object.assign(new Event("beforeinstallprompt"), { prompt: vi.fn() }),
      );
    });
    expect(screen.getByText("Install")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event("appinstalled"));
    });
    expect(screen.queryByText("Install")).toBeNull();
  });
});
