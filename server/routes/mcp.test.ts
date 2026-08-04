import { describe, it, expect } from "vitest";
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
