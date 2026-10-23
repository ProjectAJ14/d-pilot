import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  basicAuthValue,
  bridgeUrl,
  claudeCodeBridgeSteps,
  claudeCodeHttpSteps,
  claudeDesktopConfig,
  claudeDesktopSteps,
  shellQuote,
} from "./mcp-setup";
// The endpoint's real gate, so a header this page builds is proven to be one
// the server accepts — not just one a copy of its logic accepts.
import { parseBasicAuth } from "../../server/routes/mcp";

const decode = (auth: string) => {
  const creds = parseBasicAuth(auth);
  return creds && [creds.username, creds.password];
};

const HTTPS = "https://d-pilot.example.com/api/mcp";
const SUBPATH = "https://d-pilot.example.com/d-pilot/api/mcp";
const HTTP = "http://10.0.0.5:3101/api/mcp";
const TRICKY_USER = "o'brien@example.com";
// Spaces (leading/trailing too), both quotes, $, backtick, backslash, ':',
// shell syntax and non-ASCII — everything that breaks naive quoting.
const TRICKY_PASSWORD = ` p"a's $HOME \`id\` \\n ; | & * pässwörd-密码-🔑 : `;

const codeOf = (steps: { code?: string }[]) =>
  steps.map((s) => s.code ?? "").join("\n");
/** The step that registers the server (the one with the password prompt). */
const registerStep = (steps: { code?: string }[]) =>
  steps.find((s) => s.code?.includes("claude mcp add"))!.code!;

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

describe("shellQuote", () => {
  it("escapes a single quote so the word stays literal", () => {
    expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`);
  });
});

describe("bridgeUrl", () => {
  it("sits next to the API, under the same sub-path", () => {
    expect(bridgeUrl(HTTPS)).toBe("https://d-pilot.example.com/mcp-bridge.mjs");
    expect(bridgeUrl(SUBPATH)).toBe(
      "https://d-pilot.example.com/d-pilot/mcp-bridge.mjs",
    );
  });
});

describe("Claude Code steps", () => {
  it("bridge: downloads from the sub-path and registers URL + shell-encoded auth", () => {
    const steps = claudeCodeBridgeSteps(SUBPATH, "agent@example.com");
    expect(steps[0].code).toBe(
      "mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs 'https://d-pilot.example.com/d-pilot/mcp-bridge.mjs'",
    );
    expect(steps[1].code).toContain(
      `claude mcp add d-pilot -s user -e DPILOT_MCP_URL='${SUBPATH}' -e "DPILOT_MCP_AUTH=Basic $(printf '%s' 'agent@example.com:'"$DP" | base64 | tr -d '\\n')" -- node ~/.d-pilot/mcp-bridge.mjs`,
    );
    expect(steps[1].note).toMatch(/command -v node/);
    expect(steps[1].note).toMatch(/claude mcp remove d-pilot -s user/);
    expect(steps[2].code).toBe("claude mcp list");
  });

  it("direct HTTP: registers the URL with a shell-encoded header", () => {
    const code = codeOf(claudeCodeHttpSteps(SUBPATH, "agent@example.com"));
    expect(code).toContain(
      `claude mcp add --scope user --transport http d-pilot '${SUBPATH}' --header "Authorization: Basic $(printf '%s' 'agent@example.com:'"$DP" | base64 | tr -d '\\n')"`,
    );
  });

  it("hides the typed password and clears it afterwards", () => {
    for (const steps of [
      claudeCodeBridgeSteps(HTTPS, "u@example.com"),
      claudeCodeHttpSteps(HTTPS, "u@example.com"),
    ]) {
      const code = codeOf(steps);
      expect(code).toContain("IFS= read -rs DP");
      expect(code.split("\n")).toContain("unset DP");
    }
  });

  it("escapes a quote in the username", () => {
    const code = codeOf(claudeCodeBridgeSteps(HTTPS, TRICKY_USER));
    expect(code).toContain(`printf '%s' 'o'\\''brien@example.com:'"$DP"`);
  });

  it("uses an http URL as given, with no extra flags", () => {
    for (const steps of [
      claudeCodeBridgeSteps(HTTP, "u@example.com"),
      claudeCodeHttpSteps(HTTP, "u@example.com"),
    ]) {
      const code = codeOf(steps);
      expect(code).toContain(`'${HTTP}'`);
      expect(code).not.toContain("--allow-http");
    }
  });
});

// The real thing: run step 2 in bash and zsh with a stub `claude` that prints
// its argv, feed the password on stdin, and decode what would be registered.
describe.each(["/bin/bash", "/bin/zsh"])("step 2 in %s", (shell) => {
  const argvOf = (code: string, password: string, prelude = "") => {
    const stub = `${prelude}claude() { printf '%s\\0' "$@"; }\n`;
    const after = `\nprintf 'DP after: [%s]' "$DP"`;
    const r = spawnSync(shell, ["-c", stub + code + after], {
      input: `${password}\n`,
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.split("\0");
  };

  it.skipIf(!existsSync(shell)).each([
    ["bridge", claudeCodeBridgeSteps, /^DPILOT_MCP_AUTH=(.*)$/s],
    ["direct HTTP", claudeCodeHttpSteps, /^Authorization: (.*)$/s],
  ] as const)("%s: a tricky login round-trips exactly", (_n, build, re) => {
    const args = argvOf(
      registerStep(build(HTTPS, TRICKY_USER)),
      TRICKY_PASSWORD,
    );
    const auth = args.map((a) => a.match(re)?.[1]).find(Boolean)!;
    expect(auth).toBe(basicAuthValue(TRICKY_USER, TRICKY_PASSWORD));
    expect(decode(auth)).toEqual([TRICKY_USER, TRICKY_PASSWORD]);
    expect(args.join(" ")).toContain(HTTPS);
    // `unset DP` really ran.
    expect(args.at(-1)).toMatch(/DP after: \[\]$/);
  });

  it.skipIf(!existsSync(shell))(
    "a login long enough for GNU base64 to wrap stays on one line",
    () => {
      const password = "x".repeat(200);
      const code = registerStep(claudeCodeBridgeSteps(HTTPS, "u@example.com"));
      // macOS base64 never wraps, so wrap like GNU does (76 columns) everywhere.
      const gnu = "base64() { command base64 | fold -w 76; echo; }\n";
      const auth = argvOf(code, password, gnu)
        .find((a) => a.startsWith("DPILOT_MCP_AUTH="))!
        .slice("DPILOT_MCP_AUTH=".length);
      expect(auth).toBe(basicAuthValue("u@example.com", password));
    },
  );
});

describe("no Claude Code command carries a credential", () => {
  it.each([
    ["bridge", claudeCodeBridgeSteps],
    ["direct HTTP", claudeCodeHttpSteps],
  ])("%s", (_n, build) => {
    // The builders never take a password, so they cannot leak one.
    expect(build.length).toBe(2);
    const text = JSON.stringify(build(HTTPS, "agent@example.com"));
    expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
  });
});

describe("Claude Desktop", () => {
  const auth = basicAuthValue("agent@example.com", "pw");
  const entry = (url: string) =>
    JSON.parse(claudeDesktopConfig(url, auth))["d-pilot"];

  it("runs the bridge with URL and credential in env", () => {
    expect(entry(SUBPATH)).toEqual({
      command: "<node path from step 1>",
      args: ["<bridge path from step 1>"],
      env: { DPILOT_MCP_URL: SUBPATH, DPILOT_MCP_AUTH: auth },
    });
  });

  it("takes an http URL as given, with no mcp-remote flags", () => {
    expect(entry(HTTP).env.DPILOT_MCP_URL).toBe(HTTP);
    expect(JSON.stringify(entry(HTTP))).not.toContain("--allow-http");
  });

  it("steps download from the sub-path in both shells and include the config", () => {
    const config = claudeDesktopConfig(SUBPATH, "Basic ••••");
    const steps = claudeDesktopSteps(SUBPATH, config);
    const url = "https://d-pilot.example.com/d-pilot/mcp-bridge.mjs";
    expect(steps[0].code).toContain(
      `curl -fsSo ~/.d-pilot/mcp-bridge.mjs '${url}'`,
    );
    expect(steps[1].code).toContain(`Invoke-WebRequest -Uri '${url}'`);
    expect(steps.map((s) => s.code)).toContain(config);
    expect(JSON.stringify(steps)).toMatch(/claude_desktop_config\.json/);
  });
});
