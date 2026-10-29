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
  /** The downloaded bridge, as an argument to a native program. */
  bridgePath: string;
  quitDesktop: string;
  nodePath: string;
  desktopConfig: string;
}

// Windows commands target PowerShell 5.1 as well as 7: no `curl` (an alias for
// Invoke-WebRequest in 5.1), no `~` for native programs, and no double quotes
// inside a native argument (5.1 passes them on mangled).
const SHELLS: Record<SetupOs, Shell> = {
  posix: {
    quote: shellQuote,
    download: (url) =>
      `mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs ${shellQuote(url)}`,
    bridgePath: "~/.d-pilot/mcp-bridge.mjs",
    quitDesktop: "Cmd+Q on macOS; quit from the tray or menu on Linux",
    nodePath: "`command -v node`",
    // Where the bridge's desktopConfigPath writes on each.
    desktopConfig:
      "~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or ~/.config/Claude/claude_desktop_config.json (Linux)",
  },
  windows: {
    quote: psQuote,
    download: (url) =>
      `New-Item -ItemType Directory -Force "$HOME\\.d-pilot" | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(url)} -OutFile "$HOME\\.d-pilot\\mcp-bridge.mjs"`,
    bridgePath: '"$HOME\\.d-pilot\\mcp-bridge.mjs"',
    quitDesktop: "right-click its tray icon, then Quit",
    nodePath: "`(Get-Command node).Source`",
    desktopConfig:
      "$env:APPDATA\\Claude\\claude_desktop_config.json (the Microsoft Store version's is under $env:LOCALAPPDATA\\Packages\\Claude_*; the command prints which)",
  },
};

const CREDENTIAL_NOTE =
  "The copied command contains your credential: it ends up in your shell history and in Claude's config, so don't share it.";
const SYSTEM_CA_NOTE =
  "If you see UNABLE_TO_GET_ISSUER_CERT_LOCALLY, add `--use-system-ca` before the bridge path (Node 22.15+).";
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
      note: `${CREDENTIAL_NOTE} Node from nvm or another version manager? Replace \`node\` with the full path that ${sh.nodePath} prints. ${REMOVE_NOTE} ${SYSTEM_CA_NOTE}`,
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

/**
 * Claude Desktop: the bridge writes its own config entry (this node, this
 * file, absolute paths), so nobody edits JSON or looks up a path by hand.
 * Desktop rewrites that config while it runs, so it is quit first.
 */
function desktopSteps(os: SetupOs, mcpUrl: string, auth: string): SetupStep[] {
  const sh = SHELLS[os];
  return [
    { title: "Download the bridge", code: sh.download(bridgeUrl(mcpUrl)) },
    {
      title: `Fully quit Claude Desktop (${sh.quitDesktop})`,
      note: "Closing the window is not enough: it keeps running, and it rewrites its config while it runs, so the next step's change would be lost.",
    },
    {
      title: "Add it to Claude Desktop's config",
      code: `node ${sh.bridgePath} --install-desktop ${sh.quote(mcpUrl)} ${sh.quote(auth)}`,
      note: `${CREDENTIAL_NOTE} It keeps everything else in ${sh.desktopConfig} and backs the file up first.`,
    },
    {
      title: "Start Claude Desktop",
      note: "Its Settings → Developer page should then list d-pilot.",
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

/** Login and /api/mcp authenticate with the username; the email is the fallback. */
export function defaultMcpUsername(
  user: { username?: string; email?: string } | null,
): string {
  return user?.username || user?.email || "";
}

/** A copy button's label: what to copy, or what's still missing to build it. */
export function copyButtonLabel(
  label: string,
  canCopy: boolean,
  username: string,
  password: string,
): string {
  if (canCopy) return `Copy ${label}`;
  const missing = [!username && "username", !password && "password"]
    .filter(Boolean)
    .join(" and ");
  return `Enter the ${missing} to copy`;
}
