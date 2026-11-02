// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { CrashScreen } from "./crash-screen";

const report = vi.hoisted(() => ({ blank: false }));
vi.mock("../../utils/notify-error", async (orig) => {
  const real = await orig<typeof import("../../utils/notify-error")>();
  return {
    ...real,
    reportUrl: (f: Parameters<typeof real.reportUrl>[0]) =>
      report.blank ? "" : real.reportUrl(f),
  };
});

function Boom({ error }: { error: unknown }): never {
  throw error;
}

afterEach(() => {
  vi.unstubAllGlobals();
  report.blank = false;
});

describe("CrashScreen", () => {
  it("renders children when nothing throws", () => {
    renderUi(
      <CrashScreen>
        <p>workspace</p>
      </CrashScreen>,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the error message, a report link and a working reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    renderUi(
      <CrashScreen>
        <Boom error={new Error("render exploded")} />
      </CrashScreen>,
    );
    expect(screen.getByRole("alert").textContent).toContain("render exploded");
    const report = screen.getByRole("link", { name: /Report issue/ });
    expect(report.getAttribute("href")).toContain("github.com");
    fireEvent.click(screen.getByRole("button", { name: /Reload/ }));
    expect(reload).toHaveBeenCalled();
  });

  it("stringifies non-Error throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderUi(
      <CrashScreen>
        <Boom error="plain string" />
      </CrashScreen>,
    );
    expect(screen.getByRole("alert").textContent).toContain("plain string");
  });

  it("omits the report link when there is no URL to offer", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    report.blank = true;
    renderUi(
      <CrashScreen>
        <Boom error={new Error("x")} />
      </CrashScreen>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Report issue/ })).toBeNull();
  });
});
