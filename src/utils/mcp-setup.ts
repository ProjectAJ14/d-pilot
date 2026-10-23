/**
 * Builds the manual setup steps the MCP setup page shows. Pure, so the quoting
 * and the encoding can be tested without a DOM.
 *
 * The steps are for the user's own terminal, never for an agent: a credential
 * pasted into an AI chat lands in the model's context and the transcript. So
 * the Claude Code commands carry no password at all — the shell reads it with a
 * hidden prompt and encodes it itself. Only the Claude Desktop config, which the
 * user pastes into a file by hand, carries the encoded credential, and that is
 * encoded here in the browser and never sent anywhere.
 */

/** Where the setup page lives — the route, the account menu and the onboarding message all link here. */
export const MCP_SETUP_PATH = "/docs/mcp";

export interface SetupStep {
  title: string;
  /** A command or file snippet to copy. */
  code?: string;
  note?: string;
}

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

/** The bridge is served next to the API, under the same sub-path. */
export function bridgeUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/api\/mcp$/, "/mcp-bridge.mjs");
}

// `read -s` hides the typing in bash and zsh alike (zsh's `read -p` means
// something else, hence the separate printf). The password then lives only in
// a shell variable that `unset` clears. `IFS=` keeps leading/trailing spaces.
const READ_PASSWORD = "printf 'D-Pilot password: '; IFS= read -rs DP; echo";
const UNSET_PASSWORD = "unset DP";

/**
 * Wraps step 2 in `{ … }`. A paste lands on the terminal's input all at once,
 * so without the group the shell runs the `read` line first and `read` takes
 * the next pasted line as the password. A group is parsed whole before any of
 * it runs, so `read` waits for what the user types.
 */
const readPassword = (command: string): string =>
  ["{", READ_PASSWORD, command, UNSET_PASSWORD, "}"].join("\n");

/**
 * `Basic <base64>` computed by the shell from $DP. GNU base64 wraps at 76
 * columns, which would break the header, hence `tr -d '\n'` (a no-op on macOS).
 */
function shellAuth(username: string): string {
  return `Basic $(printf '%s' ${shellQuote(`${username}:`)}"$DP" | base64 | tr -d '\\n')`;
}

const NODE_NOTE =
  "Node from nvm or another version manager? Replace `node` with the full path that `command -v node` prints. " +
  "Already added d-pilot? Run `claude mcp remove d-pilot -s user` first.";

const CHECK_STEP: SetupStep = {
  title: "Restart Claude Code, then check the connection",
  code: "claude mcp list",
  note: "Expect d-pilot to show as Connected. Then ask the agent to “call the d-pilot whoami tool” — that prompt carries no credential.",
};

/** Claude Code through the local bridge (recommended): explains a VPN outage and recovers by itself. */
export function claudeCodeBridgeSteps(
  mcpUrl: string,
  username: string,
): SetupStep[] {
  return [
    {
      title: "Download the bridge",
      code: `mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs ${shellQuote(bridgeUrl(mcpUrl))}`,
    },
    {
      title:
        "Register it — type the password at the hidden prompt; your shell encodes it",
      code: readPassword(
        `claude mcp add d-pilot -s user -e DPILOT_MCP_URL=${shellQuote(mcpUrl)} -e "DPILOT_MCP_AUTH=${shellAuth(username)}" -- node ~/.d-pilot/mcp-bridge.mjs`,
      ),
      note: NODE_NOTE,
    },
    CHECK_STEP,
  ];
}

/** Claude Code straight to the HTTP endpoint: no Node needed, but no VPN explanation or recovery. */
export function claudeCodeHttpSteps(
  mcpUrl: string,
  username: string,
): SetupStep[] {
  return [
    {
      title:
        "Register the endpoint — type the password at the hidden prompt; your shell encodes it",
      code: readPassword(
        `claude mcp add --scope user --transport http d-pilot ${shellQuote(mcpUrl)} --header "Authorization: ${shellAuth(username)}"`,
      ),
      note: "Already added d-pilot? Run `claude mcp remove d-pilot -s user` first.",
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

/** Claude Desktop, by hand. `config` is `claudeDesktopConfig(...)` (masked or real). */
export function claudeDesktopSteps(
  mcpUrl: string,
  config: string,
): SetupStep[] {
  const url = bridgeUrl(mcpUrl);
  return [
    {
      title:
        "Download the bridge; the last two lines printed are the node and bridge paths",
      code: `mkdir -p ~/.d-pilot && curl -fsSo ~/.d-pilot/mcp-bridge.mjs ${shellQuote(url)} && command -v node && echo ~/.d-pilot/mcp-bridge.mjs`,
      note: "macOS / Linux terminal.",
    },
    {
      title: "On Windows, the same in PowerShell",
      code: `New-Item -ItemType Directory -Force "$HOME\\.d-pilot" | Out-Null; Invoke-WebRequest -Uri '${url.replaceAll("'", "''")}' -OutFile "$HOME\\.d-pilot\\mcp-bridge.mjs"; (Get-Command node).Source; "$HOME\\.d-pilot\\mcp-bridge.mjs"`,
    },
    {
      title: "Open Claude Desktop's config file",
      note:
        "Settings → Developer → Edit Config, or open it directly — macOS: ~/Library/Application Support/Claude/claude_desktop_config.json; " +
        'Windows: %APPDATA%\\Claude\\claude_desktop_config.json. Create it as {"mcpServers": {}} if it does not exist.',
    },
    {
      title:
        "Merge this entry into mcpServers, replacing the two <…> paths with the ones step 1 printed",
      code: config,
      note: "On Windows, double every backslash in the paths (C:\\\\Users\\\\…) or use forward slashes. This snippet contains your credential: paste it into the file yourself, don't share it.",
    },
    {
      title:
        "Fully quit Claude Desktop (not just close the window) and reopen it",
    },
  ];
}
