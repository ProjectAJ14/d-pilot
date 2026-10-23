import { describe, it, expect, vi, beforeEach } from "vitest";

const getConfig = vi.fn<(key: string) => string | undefined>();
vi.mock("../config/settings.js", () => ({ getConfig }));

const { connectionFailedMessage, isConnectionError } =
  await import("./connection-errors.js");

describe("isConnectionError", () => {
  it("catches a refused localhost connect that only carries a code", () => {
    // What pg throws when both ::1 and 127.0.0.1 refuse: no message at all.
    const err = Object.assign(new AggregateError([], ""), {
      code: "ECONNREFUSED",
    });
    expect(isConnectionError(err)).toBe(true);
  });

  it("leaves query errors alone", () => {
    const err = Object.assign(new Error('relation "nope" does not exist'), {
      code: "42P01",
    });
    expect(isConnectionError(err)).toBe(false);
  });
});

describe("connectionFailedMessage", () => {
  beforeEach(() => getConfig.mockReset());

  it("names the database, blames the network, and suggests a generic fix", () => {
    const msg = connectionFailedMessage({ name: "Orders", env: "QA" });
    expect(msg).toContain("D-Pilot is running");
    expect(msg).toContain("the Orders (QA) database");
    expect(msg).toContain("not your query");
    expect(msg).toMatch(/Check your network or VPN connection and retry\.$/);
    expect(getConfig).toHaveBeenCalledWith("NETWORK_HINT");
  });

  it("appends the deployment's hint instead of the generic one", () => {
    getConfig.mockReturnValue("Connect to the VPN and retry.");
    const msg = connectionFailedMessage({ name: "Orders", env: "QA" });
    expect(msg).toMatch(/not your query\. Connect to the VPN and retry\.$/);
    expect(msg).not.toContain("Check your network");
  });

  it("works without a target", () => {
    getConfig.mockReturnValue("   ");
    const msg = connectionFailedMessage();
    expect(msg).toContain("can't reach the database.");
    expect(msg).toMatch(/Check your network or VPN connection and retry\.$/);
  });
});
