import { describe, expect, it, vi } from "vitest";
import "./browser-request.testing";

vi.mock("@mantine/notifications", () => ({
  notifications: { show: () => {} },
}));
// The store reads localStorage and hooks window at import time.
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
vi.stubGlobal("window", { addEventListener: () => {} });

const { api, ApiError } = await import("./api-client");
const { useStore } = await import("../store");
const { isReportable } = await import("./notify-error");
const { notReachedRequest, notReachedTitle } =
  await import("./write-not-reached");

// What the write routes answer when the write never reached its database.
const notReached = (status: string) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: "Can't reach orders-db (QA).",
          code: "CONNECTION_FAILED",
          request: { id: "wr-1", status },
        }),
        { status: 503 },
      ),
  );

describe("a write that never reached its database (503 with the request)", () => {
  it("is CONNECTION_FAILED, carries the request, and is no bug report", async () => {
    vi.stubGlobal("fetch", notReached("PENDING"));
    const err = await api.approveWriteRequest("wr-1").catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("CONNECTION_FAILED");
    expect(err.message).toBe("Can't reach orders-db (QA).");
    expect(notReachedRequest(err)).toEqual({ id: "wr-1", status: "PENDING" });
    expect(isReportable(err)).toBe(false);
    expect(useStore.getState().serverUnreachable).toBe(false);
  });

  it("says where the request was left", async () => {
    vi.stubGlobal("fetch", notReached("DRAFT"));
    const err = await api.submitWriteRequest("wr-1").catch((e) => e);
    expect(notReachedTitle(notReachedRequest(err)!)).toMatch(/draft/i);
    expect(notReachedTitle({ id: "wr-1", status: "PENDING" } as never)).toMatch(
      /pending/i,
    );
  });

  it("is nothing special for any other error", () => {
    expect(
      notReachedRequest(
        new ApiError("Can't reach x", 503, "CONNECTION_FAILED"),
      ),
    ).toBeNull();
    expect(notReachedRequest(new ApiError("nope", 409))).toBeNull();
    expect(notReachedRequest(new Error("x"))).toBeNull();
  });
});
