/**
 * Builds the agent-setup text the MCP setup page hands out. Pure, so the encoding
 * and the prompts can be tested without a DOM.
 *
 * Everything here runs in the browser only: the password is encoded locally
 * and never sent to the server by this page.
 */

/** Where the setup page lives — the route, the account menu and the onboarding message all link here. */
export const MCP_SETUP_PATH = "/docs/mcp";

/**
 * `Basic base64(user:pass)`, the header `/api/mcp` accepts. Goes through
 * TextEncoder because `btoa` throws on anything outside Latin-1, and a
 * password is allowed to contain any character.
 */
export function basicAuthValue(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

export function claudeCodePrompt(mcpUrl: string, auth: string): string {
  return [
    "Add the d-pilot MCP server to Claude Code for me. Run this command exactly as written:",
    "",
    `claude mcp add --scope user --transport http d-pilot ${mcpUrl} --header "Authorization: ${auth}"`,
    "",
    "Then call the d-pilot `whoami` tool to confirm the connection works and tell me which account and environments it reports. If the tool is not available yet, tell me to restart this Claude Code session so it picks up the new server, then try again.",
    "",
    "The Authorization value is a credential: do not write it to any file in a repository, commit it, or repeat it back to me.",
  ].join("\n");
}

/**
 * Claude Desktop's config file only launches local (stdio) servers, so the
 * remote endpoint goes through the `mcp-remote` bridge. The header rides in an
 * env var because a space inside an `args` entry is split on Windows.
 * mcp-remote refuses a plain-http URL that isn't localhost unless told
 * `--allow-http`, so an http deployment gets it.
 */
export function claudeDesktopConfig(mcpUrl: string, auth: string): string {
  return JSON.stringify(
    {
      "d-pilot": {
        command: "npx",
        args: [
          "-y",
          "mcp-remote",
          mcpUrl,
          "--header",
          "Authorization:${DPILOT_AUTH}",
          ...(mcpUrl.startsWith("http:") ? ["--allow-http"] : []),
        ],
        env: { DPILOT_AUTH: auth },
      },
    },
    null,
    2,
  );
}

export function claudeDesktopPrompt(mcpUrl: string, auth: string): string {
  return [
    "Add the d-pilot MCP server to my Claude Desktop config.",
    "",
    "The config file is:",
    "- macOS: ~/Library/Application Support/Claude/claude_desktop_config.json",
    "- Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
    "",
    'Merge the entry below into its "mcpServers" object. Keep every other server and setting as it is, do not overwrite the file. Create the file (as {"mcpServers": {}}) if it does not exist, and replace any existing "d-pilot" entry.',
    "",
    claudeDesktopConfig(mcpUrl, auth),
    "",
    "Make sure the result is valid JSON. Then tell me to fully quit Claude Desktop (not just close the window) and reopen it so it loads the server.",
    "",
    "The DPILOT_AUTH value is a credential: do not write it anywhere else, commit it, or repeat it back to me.",
  ].join("\n");
}
