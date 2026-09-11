import { describe, it, expect, afterEach, vi } from "vitest";
import { parseBasicAuth } from "./mcp.js";

const basic = (raw: string) =>
  `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;

describe("parseBasicAuth", () => {
  it("reads a service account's credentials", () => {
    expect(parseBasicAuth(basic("agent@example.com:s3cret"))).toEqual({
      username: "agent@example.com",
      password: "s3cret",
    });
  });

  it("keeps colons in the password", () => {
    expect(parseBasicAuth(basic("agent:pa:ss:word"))).toEqual({
      username: "agent",
      password: "pa:ss:word",
    });
  });

  it("allows an empty password rather than silently trimming the pair", () => {
    expect(parseBasicAuth(basic("agent:"))).toEqual({
      username: "agent",
      password: "",
    });
  });

  it.each([
    ["no header", undefined],
    ["empty header", ""],
    ["a Bearer token", "Bearer some.jwt.value"],
    ["the wrong scheme", `Digest ${Buffer.from("a:b").toString("base64")}`],
    ["no separating colon", basic("agentexample")],
    ["an empty username", basic(":s3cret")],
    ["only a colon", basic(":")],
  ])("rejects %s", (_case, header) => {
    expect(parseBasicAuth(header)).toBeNull();
  });
});

/**
 * BASE_PATH and APP_BASE_URL are both read when their module is first imported,
 * so each case resets the module registry and imports mcp.ts fresh. That is the
 * only way to see what a *deployment* would produce rather than what this test
 * process happens to be configured for.
 */
async function linkFor(
  basePath: string | undefined,
  appBaseUrl: string | undefined,
) {
  vi.resetModules();
  vi.stubEnv("BASE_PATH", basePath);
  vi.stubEnv("APP_BASE_URL", appBaseUrl);
  const { appUrl, artifactUrl } = await import("./mcp.js");
  return { appUrl, artifactUrl };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("appUrl", () => {
  it("hands back a bare path when no origin is configured", async () => {
    const { appUrl } = await linkFor(undefined, undefined);
    expect(appUrl("/artifacts/42")).toBe("/artifacts/42");
  });

  it("uses the configured origin at a domain root", async () => {
    const { appUrl } = await linkFor(undefined, "https://d-pilot.internal");
    expect(appUrl("/artifacts/42")).toBe(
      "https://d-pilot.internal/artifacts/42",
    );
  });

  it("carries the sub-path in the bare-path fallback", async () => {
    const { appUrl } = await linkFor("/d-pilot", undefined);
    expect(appUrl("/artifacts/42")).toBe("/d-pilot/artifacts/42");
  });

  /**
   * The regression this matters for: APP_BASE_URL is documented as an origin, so
   * an operator sets it *and* BASE_PATH. Before the prefix was appended here the
   * link pointed at the domain root — whatever other app owns it — which is the
   * exact failure sub-path support exists to prevent, surviving in the one place
   * the URL gets pasted into a ticket.
   */
  it("appends the sub-path to a configured origin", async () => {
    const { appUrl } = await linkFor("/d-pilot", "https://intranet.example");
    expect(appUrl("/artifacts/42")).toBe(
      "https://intranet.example/d-pilot/artifacts/42",
    );
  });

  it("does not double a prefix the operator already spelled out", async () => {
    const { appUrl } = await linkFor(
      "/d-pilot",
      "https://intranet.example/d-pilot",
    );
    expect(appUrl("/artifacts/42")).toBe(
      "https://intranet.example/d-pilot/artifacts/42",
    );
  });

  it.each(["", "/"])(
    "treats an APP_BASE_URL of %o as unset rather than linking to the wrong origin",
    async (configured) => {
      const { appUrl } = await linkFor("/d-pilot", configured);
      expect(appUrl("/artifacts/42")).toBe("/d-pilot/artifacts/42");
    },
  );

  it("builds write-request links the same way", async () => {
    const { appUrl } = await linkFor("/d-pilot", "https://intranet.example");
    expect(appUrl("/write-requests/7")).toBe(
      "https://intranet.example/d-pilot/write-requests/7",
    );
  });

  it("artifactUrl is appUrl over the artifacts route", async () => {
    const { appUrl, artifactUrl } = await linkFor(
      "/d-pilot",
      "https://intranet.example",
    );
    expect(artifactUrl("42")).toBe(appUrl("/artifacts/42"));
  });
});
