import { describe, it, expect, vi, beforeEach } from "vitest";
import { queryLimit } from "./query-limit";
import { api } from "./api-client";

/**
 * The Limit checkbox broke twice the same way: a caller sent `undefined`,
 * `JSON.stringify` dropped the field, and the server applied its built-in 500
 * rows. These pin the contract at the wire — what the server actually
 * receives — since that is where the two bugs were invisible.
 */

const sentBodies: Record<string, unknown>[] = [];

beforeEach(() => {
  sentBodies.length = 0;
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sentBodies.push(JSON.parse(init.body as string));
      return new Response("{}", {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
});

describe("queryLimit", () => {
  it("sends the value when the checkbox is on", () => {
    expect(
      queryLimit({ defaultLimitEnabled: true, defaultLimitValue: 2000 }),
    ).toBe(2000);
  });

  it("sends null, never undefined, when the checkbox is off", () => {
    expect(
      queryLimit({ defaultLimitEnabled: false, defaultLimitValue: 2000 }),
    ).toBeNull();
  });
});

describe("api calls carry the limit to the server", () => {
  const off = queryLimit({
    defaultLimitEnabled: false,
    defaultLimitValue: 500,
  });

  it.each([
    ["executeQuery", () => api.executeQuery("qa-core", "select 1", off)],
    ["exportCsv", () => api.exportCsv("qa-core", "select 1", off)],
    ["exportJson", () => api.exportJson("qa-core", "select 1", off)],
  ])("%s keeps defaultLimit: null in the request body", async (_, call) => {
    await call();
    expect(sentBodies[0]).toHaveProperty("defaultLimit", null);
  });

  it.each([
    ["executeQuery", () => api.executeQuery("qa-core", "select 1", 2000)],
    ["exportCsv", () => api.exportCsv("qa-core", "select 1", 2000)],
    ["exportJson", () => api.exportJson("qa-core", "select 1", 2000)],
  ])("%s sends the chosen limit", async (_, call) => {
    await call();
    expect(sentBodies[0]).toHaveProperty("defaultLimit", 2000);
  });
});
