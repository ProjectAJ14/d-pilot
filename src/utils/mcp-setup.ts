/**
 * Builds the manual setup steps the MCP setup page shows. Pure, so the quoting
 * and the encoding can be tested without a DOM.
 *
 * The steps are for the user's own terminal, never for an agent: a credential
 * pasted into an AI chat lands in the model's context and the transcript. The
 * page encodes `user:password` in the browser (never sent anywhere) and puts it
 * only in the text it copies; what it shows carries `MASKED_AUTH` instead.
 */

/** Where the setup page lives — the route, the account menu and the onboarding message all link here. */
export const MCP_SETUP_PATH = "/docs/mcp";

export type SetupOs = "posix" | "windows";
export type SetupClient = "bridge" | "http" | "desktop";

export interface SetupStep {
  title: string;
  /** A command or file snippet, as shown — credential masked. */
  code?: string;
  /** What the copy button copies; null until the credential can be built. */
  copy?: string | null;
  note?: string;
}

/** Stands in for the credential in everything the page shows. */
export const MASKED_AUTH = "Basic ••••••••";

/**
 * `Basic base64(user:pass)`, the header `/api/mcp` accepts. Goes through
 * TextEncoder because `btoa` throws on anything outside Latin-1, and a
 * password is allowed to contain any character.
 */
export function basicAuthValue(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** POSIX single quotes: any string, quotes included, stays one literal word in bash and zsh. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * PowerShell single quotes (5.1 and 7): nothing inside is expanded, and a
 * quote is escaped by doubling it. PowerShell also reads the typographic
 * single quotes as quotes, so those are doubled too.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

/** The bridge is served next to the API, under the same sub-path. */
export function bridgeUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/api\/mcp$/, "/mcp-bridge.mjs");
}

/** `navigator.userAgentData?.platform || navigator.userAgent` → which commands to show. `\b` keeps "Darwin" out. */
export function detectOs(platform: string): SetupOs {
  return /\bwin/i.test(platform) ? "windows" : "posix";
}

interface Shell {
  quote: (s: string) => string;
  /** Downloads the bridge to ~/.d-pilot. */
  download: (url: string) => string;
  /** Joins two commands, the second running only if the first succeeded where the shell can say so. */
  then: string;
  /** The downloaded bridge, as an argument to a native program. */
  bridgePath: string;
  /** Prints the node and bridge paths, ready to paste into JSON. */
  printPaths: string;
  nodePath: string;
  desktopConfig: string;
}

// Windows commands target PowerShell 5.1 as well as 7: no `curl` (an alias for
// Invoke-WebRequest in 5.1), no `~` for native programs, and no double quotes
// inside a native argument (5.1 passes them on mangled). PowerShell 5.1 has no
// `&&`, hence `;`.
const SHELLS: Record<SetupOs, Shell> = {
  posix: {
    quote: shellQuote,
    download: (url) =>
      `mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs ${shellQuote(url)}`,
    then: " && ",
    bridgePath: "~/.d-pilot/mcp-bridge.mjs",
    printPaths: "command -v node && echo ~/.d-pilot/mcp-bridge.mjs",
    nodePath: "`command -v node`",
    desktopConfig:
      "~/Library/Application Support/Claude/claude_desktop_config.json",
  },
  windows: {
    quote: psQuote,
    download: (url) =>
      `New-Item -ItemType Directory -Force "$HOME\\.d-pilot" | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(url)} -OutFile "$HOME\\.d-pilot\\mcp-bridge.mjs"`,
    then: "; ",
    bridgePath: '"$HOME\\.d-pilot\\mcp-bridge.mjs"',
    // JSON needs each backslash doubled; .Replace is literal, not a regex.
    printPaths:
      "(Get-Command node).Source.Replace('\\','\\\\'); \"$HOME\\.d-pilot\\mcp-bridge.mjs\".Replace('\\','\\\\')",
    nodePath: "`(Get-Command node).Source`",
    desktopConfig: "$env:APPDATA\\Claude\\claude_desktop_config.json",
  },
};

const CREDENTIAL_NOTE =
  "The copied command contains your credential: it ends up in your shell history and in Claude's config, so don't share it.";
const REMOVE_NOTE =
  "Already added d-pilot? Run `claude mcp remove d-pilot -s user` first.";

const CHECK_STEP: SetupStep = {
  title: "Restart Claude Code, then check the connection",
  code: "claude mcp list",
  note: "Expect d-pilot to show as Connected. Then ask the agent to “call the d-pilot whoami tool” — that prompt carries no credential.",
};

/**
 * Claude Code through the local bridge (recommended): explains a VPN outage
 * and recovers by itself. `-t stdio` ends the variadic `-e` list, so the
 * command needs no `--`, which PowerShell has not always passed through.
 */
function bridgeSteps(os: SetupOs, mcpUrl: string, auth: string): SetupStep[] {
  const sh = SHELLS[os];
  return [
    { title: "Download the bridge", code: sh.download(bridgeUrl(mcpUrl)) },
    {
      title: "Register it",
      code: `claude mcp add -s user -e ${sh.quote(`DPILOT_MCP_URL=${mcpUrl}`)} -e ${sh.quote(`DPILOT_MCP_AUTH=${auth}`)} -t stdio d-pilot node ${sh.bridgePath}`,
      note: `${CREDENTIAL_NOTE} Node from nvm or another version manager? Replace \`node\` with the full path that ${sh.nodePath} prints. ${REMOVE_NOTE}`,
    },
    CHECK_STEP,
  ];
}

/** Claude Code straight to the HTTP endpoint: no Node needed, but no VPN explanation or recovery. */
function httpSteps(os: SetupOs, mcpUrl: string, auth: string): SetupStep[] {
  const q = SHELLS[os].quote;
  return [
    {
      title: "Register the endpoint",
      code: `claude mcp add --scope user --transport http d-pilot ${q(mcpUrl)} --header ${q(`Authorization: ${auth}`)}`,
      note: `${CREDENTIAL_NOTE} ${REMOVE_NOTE}`,
    },
    CHECK_STEP,
  ];
}

const NODE_PATH = "<node path from step 1>";
const BRIDGE_PATH = "<bridge path from step 1>";

/**
 * The `mcpServers` entry for Claude Desktop, which launches local (stdio)
 * servers only — so it runs the same bridge. Desktop starts it without your
 * shell's PATH or `~`, hence absolute paths, which step 1 prints.
 */
export function claudeDesktopConfig(mcpUrl: string, auth: string): string {
  return JSON.stringify(
    {
      "d-pilot": {
        command: NODE_PATH,
        args: [BRIDGE_PATH],
        env: { DPILOT_MCP_URL: mcpUrl, DPILOT_MCP_AUTH: auth },
      },
    },
    null,
    2,
  );
}

function desktopSteps(os: SetupOs, mcpUrl: string, auth: string): SetupStep[] {
  const sh = SHELLS[os];
  return [
    {
      title:
        "Download the bridge; the last two lines printed are the node and bridge paths",
      code: sh.download(bridgeUrl(mcpUrl)) + sh.then + sh.printPaths,
    },
    {
      title: "Open Claude Desktop's config file",
      note: `Settings → Developer → Edit Config, or open ${sh.desktopConfig}. Create it as {"mcpServers": {}} if it does not exist.`,
    },
    {
      title:
        "Merge this entry into mcpServers, replacing the two <…> paths with the ones step 1 printed",
      code: claudeDesktopConfig(mcpUrl, auth),
      note: "The copied entry contains your credential: paste it into the file yourself, and don't share it.",
    },
    {
      title:
        "Fully quit Claude Desktop (not just close the window) and reopen it",
    },
  ];
}

const BUILDERS = {
  bridge: bridgeSteps,
  http: httpSteps,
  desktop: desktopSteps,
};

/**
 * The steps for one client on one OS. `code` always shows `MASKED_AUTH`; a
 * step that carries the credential copies the real one, or null (copy
 * disabled) until there is a username and password to encode.
 */
export function setupSteps(
  client: SetupClient,
  os: SetupOs,
  mcpUrl: string,
  username: string,
  password: string,
): SetupStep[] {
  const shown = BUILDERS[client](os, mcpUrl, MASKED_AUTH);
  const real =
    username && password
      ? BUILDERS[client](os, mcpUrl, basicAuthValue(username, password))
      : null;
  return shown.map((step, i) => ({
    ...step,
    copy: step.code?.includes(MASKED_AUTH)
      ? (real?.[i].code ?? null)
      : step.code,
  }));
}
