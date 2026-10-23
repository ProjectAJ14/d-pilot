import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  MASKED_AUTH,
  basicAuthValue,
  bridgeUrl,
  detectOs,
  psQuote,
  setupSteps,
  shellQuote,
  type SetupClient,
  type SetupOs,
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
const TRICKY_USER = "o'brien@example.com";
// Spaces (leading/trailing too), both quotes, $, backtick, backslash, ':',
// shell syntax and non-ASCII — everything that breaks naive quoting.
const TRICKY_PASSWORD = ` p"a's $HOME \`id\` \\n ; | & * pässwörd-密码-🔑 : `;
const AUTH = basicAuthValue("agent@example.com", "pw");
const codes = (client: SetupClient, os: SetupOs, url = SUBPATH) =>
  setupSteps(client, os, url, "agent@example.com", "pw").map((s) => s.copy);

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

  it.each(["/bin/bash", "/bin/zsh"].filter(existsSync))(
    "round-trips a tricky string in %s",
    (shell) => {
      for (const s of [TRICKY_USER, TRICKY_PASSWORD, "'", "''", "a'b'c"]) {
        const r = spawnSync(shell, ["-c", `printf '%s' ${shellQuote(s)}`], {
          encoding: "utf8",
        });
        expect(r.stdout).toBe(s);
      }
    },
  );
});

/**
 * PowerShell's single-quoted string, as its tokenizer reads it: any of the
 * four single-quote characters ends it unless doubled. pwsh isn't installed
 * here, so this is the reference psQuote is checked against.
 */
function psUnquote(word: string): string {
  const Q = /['‘’‚‛]/;
  expect(Q.test(word[0])).toBe(true);
  let out = "";
  for (let i = 1; i < word.length; i++) {
    if (Q.test(word[i])) {
      if (i + 1 < word.length && Q.test(word[i + 1])) {
        out += word[i];
        i++;
      } else {
        expect(i, "the string ends early").toBe(word.length - 1);
        return out;
      }
    } else out += word[i];
  }
  throw new Error("unterminated");
}

describe("psQuote", () => {
  it("doubles a single quote", () => {
    expect(psQuote("o'brien")).toBe("'o''brien'");
    expect(psQuote("DPILOT_MCP_URL=https://x/api/mcp")).toBe(
      "'DPILOT_MCP_URL=https://x/api/mcp'",
    );
  });

  it("doubles the typographic quotes PowerShell also treats as quotes", () => {
    expect(psQuote("o’brien")).toBe("'o’’brien'");
  });

  it("round-trips tricky strings and expands nothing", () => {
    for (const s of [
      TRICKY_USER,
      TRICKY_PASSWORD,
      "‘curly’ ‚low‛",
      "'",
      "$env:APPDATA `n",
    ])
      expect(psUnquote(psQuote(s))).toBe(s);
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

describe("detectOs", () => {
  it.each([
    ["Windows", "windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "windows"],
    ["Win32", "windows"],
    ["macOS", "posix"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605",
      "posix",
    ],
    ["Darwin", "posix"],
    ["Linux", "posix"],
    ["Mozilla/5.0 (X11; Linux x86_64)", "posix"],
    ["", "posix"],
  ])("%s → %s", (platform, os) => {
    expect(detectOs(platform)).toBe(os);
  });
});

describe("macOS / Linux commands", () => {
  it("bridge", () => {
    expect(codes("bridge", "posix")).toEqual([
      "mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs 'https://d-pilot.example.com/d-pilot/mcp-bridge.mjs'",
      `claude mcp add -s user -e 'DPILOT_MCP_URL=${SUBPATH}' -e 'DPILOT_MCP_AUTH=${AUTH}' -t stdio d-pilot node ~/.d-pilot/mcp-bridge.mjs`,
      "claude mcp list",
    ]);
  });

  it("direct HTTP", () => {
    expect(codes("http", "posix")).toEqual([
      `claude mcp add --scope user --transport http d-pilot '${SUBPATH}' --header 'Authorization: ${AUTH}'`,
      "claude mcp list",
    ]);
  });

  it("Claude Desktop: the bridge writes the config itself", () => {
    const steps = setupSteps(
      "desktop",
      "posix",
      SUBPATH,
      "agent@example.com",
      "pw",
    );
    expect(steps.map((s) => s.copy)).toEqual([
      "mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs 'https://d-pilot.example.com/d-pilot/mcp-bridge.mjs'",
      `node ~/.d-pilot/mcp-bridge.mjs --install-desktop '${SUBPATH}' '${AUTH}'`,
      undefined,
    ]);
    expect(steps[1].note).toContain(
      "~/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(steps[2].title).toContain("Cmd+Q");
    // The bridge records process.execPath, so no node-path advice here.
    expect(JSON.stringify(steps)).not.toMatch(/command -v node|<node path/);
  });

  it("notes say how to find node", () => {
    const [, register] = setupSteps("bridge", "posix", HTTPS, "u", "p");
    expect(register.note).toContain("`command -v node`");
    expect(register.note).toMatch(/claude mcp remove d-pilot -s user/);
  });
});

describe("Windows (PowerShell) commands", () => {
  const PS_DOWNLOAD = `New-Item -ItemType Directory -Force "$HOME\\.d-pilot" | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri 'https://d-pilot.example.com/d-pilot/mcp-bridge.mjs' -OutFile "$HOME\\.d-pilot\\mcp-bridge.mjs"`;

  it("bridge", () => {
    expect(codes("bridge", "windows")).toEqual([
      PS_DOWNLOAD,
      `claude mcp add -s user -e 'DPILOT_MCP_URL=${SUBPATH}' -e 'DPILOT_MCP_AUTH=${AUTH}' -t stdio d-pilot node "$HOME\\.d-pilot\\mcp-bridge.mjs"`,
      "claude mcp list",
    ]);
  });

  it("direct HTTP", () => {
    expect(codes("http", "windows")).toEqual([
      `claude mcp add --scope user --transport http d-pilot '${SUBPATH}' --header 'Authorization: ${AUTH}'`,
      "claude mcp list",
    ]);
  });

  it("Claude Desktop: the bridge writes the config itself", () => {
    const steps = setupSteps(
      "desktop",
      "windows",
      SUBPATH,
      "agent@example.com",
      "pw",
    );
    expect(steps.map((s) => s.copy)).toEqual([
      PS_DOWNLOAD,
      `node "$HOME\\.d-pilot\\mcp-bridge.mjs" --install-desktop '${SUBPATH}' '${AUTH}'`,
      undefined,
    ]);
    expect(steps[1].note).toContain(
      "$env:APPDATA\\Claude\\claude_desktop_config.json",
    );
    expect(steps[2].title).toContain("tray icon");
    expect(JSON.stringify(steps)).not.toMatch(/Get-Command node|<node path/);
  });

  it("notes say how to find node", () => {
    const [, register] = setupSteps("bridge", "windows", HTTPS, "u", "p");
    expect(register.note).toContain("`(Get-Command node).Source`");
  });

  // What PowerShell 5.1 gets wrong: curl is Invoke-WebRequest, there is no
  // `&&`, `~` is not expanded for native programs, embedded double quotes are
  // mangled, and `--` has not always reached native programs.
  it.each(["bridge", "http", "desktop"] as const)(
    "%s avoids what PowerShell 5.1 breaks",
    (client) => {
      const text = codes(client, "windows").join("\n");
      expect(text).not.toMatch(/\bcurl\b|&&|~|\s--\s/);
      for (const line of text
        .split("\n")
        .filter((l) => /^(claude|node) /.test(l)))
        // Double quotes only around a whole "$HOME\…" path, never inside a value.
        expect(
          line.replaceAll('"$HOME\\.d-pilot\\mcp-bridge.mjs"', ""),
        ).not.toContain('"');
    },
  );

  it("quotes a ' in a value by doubling it", () => {
    const url = "https://d-pilot.example.com/o'brien/api/mcp";
    const [, register] = codes("bridge", "windows", url);
    expect(register).toContain(
      `-e 'DPILOT_MCP_URL=https://d-pilot.example.com/o''brien/api/mcp'`,
    );
  });
});

describe("the credential is only in the copied text", () => {
  const OSES: SetupOs[] = ["posix", "windows"];
  const CLIENTS: SetupClient[] = ["bridge", "http", "desktop"];
  const real = basicAuthValue(TRICKY_USER, TRICKY_PASSWORD).slice(6);

  it.each(OSES.flatMap((os) => CLIENTS.map((c) => [c, os] as const)))(
    "%s on %s",
    (client, os) => {
      const steps = setupSteps(client, os, HTTPS, TRICKY_USER, TRICKY_PASSWORD);
      const withCred = steps.filter((s) => s.code?.includes(MASKED_AUTH));
      expect(withCred).toHaveLength(1);
      for (const s of steps) {
        expect(JSON.stringify([s.code, s.note, s.title])).not.toContain(real);
        if (s.code?.includes(MASKED_AUTH)) {
          expect(s.copy).toContain(real);
          expect(s.copy).toBe(s.code!.replace(MASKED_AUTH, `Basic ${real}`));
        } else expect(s.copy).toBe(s.code);
      }
    },
  );

  it.each([
    ["no password", "agent@example.com", ""],
    ["no username", "", "pw"],
  ])("credential steps can't be copied with %s", (_n, user, password) => {
    for (const client of CLIENTS) {
      const steps = setupSteps(client, "posix", HTTPS, user, password);
      for (const s of steps)
        expect(s.copy).toBe(s.code?.includes(MASKED_AUTH) ? null : s.code);
    }
  });
});

// The real thing: run the copied macOS commands in bash and zsh with a stub
// `claude` that prints its argv, and decode what would be registered.
describe.each(["/bin/bash", "/bin/zsh"].filter(existsSync))(
  "in %s",
  (shell) => {
    const argv = (code: string) => {
      const r = spawnSync(
        shell,
        [
          "-c",
          `claude() { printf '%s\\0' "$@"; }\nnode() { claude "$@"; }\n${code}`,
        ],
        {
          encoding: "utf8",
        },
      );
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.split("\0").slice(0, -1);
    };
    const register = (client: SetupClient) =>
      setupSteps(client, "posix", SUBPATH, TRICKY_USER, TRICKY_PASSWORD).find(
        (s) => /^(claude mcp add|node) /.test(s.copy ?? ""),
      )!.copy!;
    const auth = basicAuthValue(TRICKY_USER, TRICKY_PASSWORD);

    it("bridge: a tricky login and the bridge path arrive intact", () => {
      expect(decode(auth)).toEqual([TRICKY_USER, TRICKY_PASSWORD]);
      expect(argv(register("bridge"))).toEqual([
        "mcp",
        "add",
        "-s",
        "user",
        "-e",
        `DPILOT_MCP_URL=${SUBPATH}`,
        "-e",
        `DPILOT_MCP_AUTH=${auth}`,
        "-t",
        "stdio",
        "d-pilot",
        "node",
        `${homedir()}/.d-pilot/mcp-bridge.mjs`,
      ]);
    });

    it("direct HTTP: the header is one argument", () => {
      expect(argv(register("http"))).toEqual([
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "http",
        "d-pilot",
        SUBPATH,
        "--header",
        `Authorization: ${auth}`,
      ]);
    });

    it("Claude Desktop: URL and credential reach the bridge intact", () => {
      expect(argv(register("desktop"))).toEqual([
        `${homedir()}/.d-pilot/mcp-bridge.mjs`,
        "--install-desktop",
        SUBPATH,
        auth,
      ]);
    });

    it("a URL with shell syntax and a ' stays one literal word", () => {
      const url = "https://d-pilot.example.com/o'brien $HOME;`id`/api/mcp";
      for (const client of ["bridge", "http", "desktop"] as const) {
        const code = setupSteps(client, "posix", url, "u", "p").find((s) =>
          /^(claude mcp add|node) /.test(s.copy ?? ""),
        )!.copy!;
        const args = argv(code);
        expect(
          args.includes(url) || args.includes(`DPILOT_MCP_URL=${url}`),
        ).toBe(true);
      }
    });
  },
);
