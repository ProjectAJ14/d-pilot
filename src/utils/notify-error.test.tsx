// @vitest-environment jsdom
import { notifications } from "@mantine/notifications";
import { screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import { renderUi } from "./dom.testing";
import { isReportable, notifyError, reportUrl } from "./notify-error";

const show = vi.spyOn(notifications, "show").mockReturnValue("");
beforeEach(() => show.mockClear());

const unreachable = Object.assign(new Error("down"), {
  code: "SERVER_UNREACHABLE",
});

describe("isReportable", () => {
  it("treats 5xx and unknown errors as bugs, 4xx and network failures as not", () => {
    expect(isReportable(new Error("boom"))).toBe(true);
    expect(isReportable(new ApiError("boom", 500))).toBe(true);
    expect(isReportable(new ApiError("no", 403))).toBe(false);
    expect(isReportable(new ApiError("db", 502, "CONNECTION_FAILED"))).toBe(
      false,
    );
    expect(isReportable(unreachable)).toBe(false);
  });
});

describe("reportUrl", () => {
  it("stamps version, user agent and time into the issue", () => {
    const body = new URL(
      reportUrl({ where: "Run query", message: "boom" }),
    ).searchParams.get("body")!;
    expect(body).toContain("boom");
    expect(body).toContain(navigator.userAgent);
    expect(body).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe("notifyError", () => {
  it("shows nothing for an unreachable server", () => {
    notifyError(unreachable, "x");
    expect(show).not.toHaveBeenCalled();
  });

  it("adds a Report issue link with the code for a reportable error", () => {
    notifyError(new ApiError("kaboom", 500, "INTERNAL" as never), "Run query", {
      title: "Query failed",
      autoClose: 5000,
    });
    const arg = show.mock.calls[0][0];
    expect(arg).toMatchObject({
      color: "red",
      title: "Query failed",
      autoClose: 5000,
    });
    renderUi(arg.message as ReactElement);
    const link = screen.getByText("Report issue").closest("a")!;
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      new URL(link.getAttribute("href")!).searchParams.get("body"),
    ).toContain("INTERNAL");
    expect(screen.getByText(/kaboom/)).toBeTruthy();
  });

  it("stringifies non-Error values and reports them without a code", () => {
    notifyError("plain failure", "x");
    renderUi(show.mock.calls[0][0].message as ReactElement);
    expect(screen.getByText(/plain failure/)).toBeTruthy();
    notifyError(null, "x");
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("shows a 4xx as plain text — nothing to report", () => {
    notifyError(new ApiError("Not allowed on PROD", 422), "x");
    expect(show.mock.calls[0][0].message).toBe("Not allowed on PROD");
  });
});
