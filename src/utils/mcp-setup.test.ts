import { describe, it, expect } from "vitest";
import {
  basicAuthValue,
  claudeCodePrompt,
  claudeDesktopConfig,
  claudeDesktopPrompt,
} from "./mcp-setup";
// The endpoint's real gate, so a header this page builds is proven to be one
// the server accepts — not just one a copy of its logic accepts.
import { parseBasicAuth } from "../../server/routes/mcp";

const decode = (auth: string) => {
  const creds = parseBasicAuth(auth);
  return creds && [creds.username, creds.password];
};

describe("basicAuthValue", () => {
  it("round-trips an ASCII login", () => {
    expect(basicAuthValue("agent@example.com", "the-password")).toBe(
      "Basic YWdlbnRAZXhhbXBsZS5jb206dGhlLXBhc3N3b3Jk",
    );
  });

  it("round-trips a non-ASCII password (raw btoa would throw)", () => {
    const auth = basicAuthValue("agent@example.com", "pässwörd-密码-🔑");
    expect(decode(auth)).toEqual(["agent@example.com", "pässwörd-密码-🔑"]);
  });

  it("keeps a ':' inside the password", () => {
    const auth = basicAuthValue("agent@example.com", "a:b:c");
    expect(decode(auth)).toEqual(["agent@example.com", "a:b:c"]);
  });
});

describe("prompts", () => {
  const url = "https://dpilot.example.com/sub/api/mcp";
  const auth = basicAuthValue("agent@example.com", "pw");

  it("Claude Code prompt carries the URL and header", () => {
    const p = claudeCodePrompt(url, auth);
    expect(p).toContain(
      `--transport http d-pilot ${url} --header "Authorization: ${auth}"`,
    );
  });

  it("Claude Desktop prompt carries the URL and header", () => {
    const p = claudeDesktopPrompt(url, auth);
    expect(p).toContain(`"${url}"`);
    expect(p).toContain(`"DPILOT_AUTH": "${auth}"`);
    expect(p).toContain('"Authorization:${DPILOT_AUTH}"');
  });
});

describe("claudeDesktopConfig", () => {
  const auth = basicAuthValue("agent@example.com", "pw");
  const args = (url: string) =>
    JSON.parse(claudeDesktopConfig(url, auth))["d-pilot"].args as string[];

  it("leaves --allow-http off an https URL", () => {
    expect(args("https://dpilot.example.com/api/mcp")).not.toContain(
      "--allow-http",
    );
  });

  it("adds --allow-http for a plain-http URL, which mcp-remote otherwise refuses", () => {
    expect(args("http://10.0.0.5:3101/api/mcp")).toContain("--allow-http");
  });
});
