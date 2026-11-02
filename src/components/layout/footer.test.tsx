// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { Footer } from "./footer";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Footer", () => {
  it("lists human contributors and drops bots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [
          { login: "alice", html_url: "u", avatar_url: "a", type: "User" },
          { login: "ci[bot]", html_url: "u", avatar_url: "a", type: "User" },
          {
            login: "release-bot",
            html_url: "u",
            avatar_url: "a",
            type: "User",
          },
          { login: "dep", html_url: "u", avatar_url: "a", type: "Bot" },
        ],
      }),
    );
    renderUi(<Footer />);
    await waitFor(() => expect(screen.getByAltText("alice")).toBeTruthy());
    expect(screen.queryByAltText("dep")).toBeNull();
    expect(screen.queryByAltText("release-bot")).toBeNull();
  });

  it("degrades without contributors when GitHub fails or returns junk", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < 3; i++) {
      const { unmount } = renderUi(<Footer />);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(i + 1));
      expect(screen.queryByText("Built by")).toBeNull();
      unmount();
    }
  });

  it("rotates the callout", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    renderUi(<Footer />);
    expect(screen.getByText(/Open source/)).toBeTruthy();
    act(() => vi.advanceTimersByTime(9000 + 400));
    expect(screen.getByText(/Found a bug/)).toBeTruthy();
  });
});

describe("Footer callout fade", () => {
  it("fades the callout out before swapping it", () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    renderUi(<Footer />);
    const link = () => screen.getByText(/Open source/).closest("a")!;
    expect(link().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(9000));
    expect(link().style.opacity).toBe("0");
  });
});
