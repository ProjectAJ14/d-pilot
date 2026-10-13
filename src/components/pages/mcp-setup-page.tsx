import { useState } from "react";
import {
  Text,
  TextInput,
  PasswordInput,
  Button,
  Tabs,
  Code,
  List,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconRobot,
  IconKey,
  IconCopy,
  IconShieldLock,
} from "@tabler/icons-react";
import { useNavigate } from "react-router-dom";
import { useStore } from "../../store";
import { BASE_PATH } from "../../utils/base-path";
import { copyToClipboard } from "../../utils/clipboard";
import { Card } from "./profile-page";
import {
  basicAuthValue,
  claudeCodePrompt,
  claudeDesktopConfig,
  claudeDesktopPrompt,
} from "../../utils/mcp-setup";

/**
 * Generates a ready-to-paste prompt that has an AI agent register the
 * `/api/mcp` endpoint itself, so nobody base64-encodes credentials by hand.
 * The password is encoded here in the browser and never sent anywhere.
 */
export function McpSetupPage() {
  const navigate = useNavigate();
  const appName = useStore((s) => s.config.appName);
  const user = useStore((s) => s.user);
  const [username, setUsername] = useState(user?.email || user?.username || "");
  const [password, setPassword] = useState("");

  // Assembled at runtime, so it has to carry the sub-path itself.
  const mcpUrl = `${window.location.origin}${BASE_PATH}/api/mcp`;
  const ready = !!username.trim() && !!password;
  const auth = ready ? basicAuthValue(username.trim(), password) : "";
  // What is shown on screen hides the credential; the copy carries the real one.
  const shown = ready
    ? "Basic ••••••••"
    : "Basic <enter your username and password above>";

  return (
    <div style={{ flex: 1, minWidth: 0, overflow: "auto" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 32px" }}>
        <Button
          variant="subtle"
          color="gray"
          size="xs"
          leftSection={<IconArrowLeft size={14} />}
          onClick={() => navigate("/")}
          mb="md"
          px={8}
        >
          Back to queries
        </Button>
        <Text fw={700} size="xl" mb={2} c="var(--text)">
          Connect an AI agent
        </Text>
        <Text size="sm" c="dimmed" mb="lg">
          Let Claude Code or Claude Desktop query {appName} through its MCP
          endpoint.
        </Text>

        <Card
          icon={<IconRobot size={16} color="var(--accent)" />}
          title="What the agent can do"
        >
          <List size="sm" spacing={4} c="var(--text)">
            <List.Item>
              Browse connections, schemas and tables, and run{" "}
              <strong>read-only</strong> queries.
            </List.Item>
            <List.Item>
              Create and edit shareable artifacts (prose + runnable queries).
            </List.Item>
            <List.Item>
              Save <strong>draft</strong> write requests for a human to review —
              a draft never runs on its own.
            </List.Item>
          </List>
          <Text size="xs" c="dimmed" mt="sm">
            It acts as the account below, with exactly that account's
            environment capabilities. PHI stays tokenized for agents, and every
            agent query is audited under the account.
          </Text>
        </Card>

        <Card
          icon={<IconKey size={16} color="var(--accent)" />}
          title="Credentials"
          desc="Your own login, or a service account's. The password never leaves this browser — it is encoded here and not sent anywhere."
        >
          <TextInput
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
            mb="sm"
          />
          <PasswordInput
            label="Password"
            placeholder="Password for this account"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
        </Card>

        <Card
          icon={<IconCopy size={16} color="var(--accent)" />}
          title="Agent prompt"
          desc="Copy the prompt and paste it into Claude Code — it does the setup itself."
        >
          <Tabs defaultValue="code">
            <Tabs.List mb="md">
              <Tabs.Tab value="code">Claude Code</Tabs.Tab>
              <Tabs.Tab value="desktop">Claude Desktop</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="code">
              <Snippet
                label="Claude Code prompt"
                shown={claudeCodePrompt(mcpUrl, shown)}
                copy={ready ? claudeCodePrompt(mcpUrl, auth) : null}
              />
            </Tabs.Panel>
            <Tabs.Panel value="desktop">
              <Text size="xs" c="dimmed" mb="sm">
                Paste this into Claude Code (or any agent that can edit files);
                it adds the server to Claude Desktop's config. Claude Desktop
                only launches local servers, so this goes through the{" "}
                <Code>mcp-remote</Code> bridge.
              </Text>
              <Snippet
                label="Claude Desktop prompt"
                shown={claudeDesktopPrompt(mcpUrl, shown)}
                copy={ready ? claudeDesktopPrompt(mcpUrl, auth) : null}
              />
              <Text size="xs" c="dimmed" mt="md" mb="sm">
                Doing it by hand? Merge this into <Code>mcpServers</Code>, then
                fully quit and reopen Claude Desktop.
              </Text>
              <Snippet
                label="Claude Desktop config"
                shown={claudeDesktopConfig(mcpUrl, shown)}
                copy={ready ? claudeDesktopConfig(mcpUrl, auth) : null}
              />
            </Tabs.Panel>
          </Tabs>
        </Card>

        <Card
          icon={<IconShieldLock size={16} color="var(--accent)" />}
          title="Keep it safe"
        >
          <List size="sm" spacing={4} c="var(--text)">
            <List.Item>
              The copied prompt contains a credential equivalent to the
              password. Don't commit it or share it.
            </List.Item>
            <List.Item>
              Serve {appName} over HTTPS — the credential is sent on every
              request.
            </List.Item>
            <List.Item>
              Changing the password revokes it (sessions already issued last
              until they expire).
            </List.Item>
            <List.Item>
              Prefer an account with only Read capability for agents.
            </List.Item>
          </List>
        </Card>
      </div>
    </div>
  );
}

/** A read-only text block with a copy button; disabled until `copy` is set. */
function Snippet({
  label,
  shown,
  copy,
}: {
  label: string;
  shown: string;
  copy: string | null;
}) {
  return (
    <div>
      <Code
        block
        style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
        mb="xs"
      >
        {shown}
      </Code>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconCopy size={14} />}
        disabled={!copy}
        onClick={() => copy && copyToClipboard(copy, label)}
      >
        {copy ? `Copy ${label}` : "Enter a password to copy"}
      </Button>
    </div>
  );
}
