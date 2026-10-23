import { useState } from "react";
import {
  Text,
  TextInput,
  PasswordInput,
  Button,
  Tabs,
  Code,
  List,
  Alert,
} from "@mantine/core";
import {
  IconArrowLeft,
  IconRobot,
  IconKey,
  IconTerminal2,
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
  claudeCodeBridgeSteps,
  claudeCodeHttpSteps,
  claudeDesktopConfig,
  claudeDesktopSteps,
  type SetupStep,
} from "../../utils/mcp-setup";

/**
 * Manual, numbered steps for connecting an agent to `/api/mcp`, run by the user
 * in their own terminal. Nothing here is meant to be pasted into an AI chat:
 * the Claude Code commands carry no password (the shell reads it), and only the
 * Claude Desktop config — pasted into a file by hand — carries the credential,
 * encoded here in the browser and never sent anywhere.
 */
export function McpSetupPage() {
  const navigate = useNavigate();
  const appName = useStore((s) => s.config.appName);
  const user = useStore((s) => s.user);
  const [username, setUsername] = useState(user?.email || user?.username || "");
  const [password, setPassword] = useState("");

  // Assembled at runtime, so it has to carry the sub-path itself.
  const mcpUrl = `${window.location.origin}${BASE_PATH}/api/mcp`;
  const name = username.trim() || "<username>";
  const ready = !!username.trim() && !!password;
  const masked = ready ? "Basic ••••••••" : "Basic <enter the password above>";
  const desktopShown = claudeDesktopConfig(mcpUrl, masked);
  const desktopCopy = ready
    ? claudeDesktopConfig(mcpUrl, basicAuthValue(username.trim(), password))
    : null;

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
          title="Account"
          desc="Your own login, or a service account's. The Claude Code commands ask for its password in your terminal."
        >
          <TextInput
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.currentTarget.value)}
          />
        </Card>

        <Card
          icon={<IconTerminal2 size={16} color="var(--accent)" />}
          title="Setup steps"
        >
          <Alert color="orange" variant="light" mb="md" p="sm">
            <Text size="xs" c="var(--text)">
              Run these <strong>yourself, in your own terminal</strong> — not
              through an agent. Don't use Claude Code's <Code>!</Code> prefix
              and don't paste them into a chat: anything an AI sees ends up in
              its context and its transcript.
            </Text>
          </Alert>
          <Tabs defaultValue="bridge">
            <Tabs.List mb="md">
              <Tabs.Tab value="bridge">Claude Code (recommended)</Tabs.Tab>
              <Tabs.Tab value="http">Claude Code, direct HTTP</Tabs.Tab>
              <Tabs.Tab value="desktop">Claude Desktop</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="bridge">
              <Text size="xs" c="dimmed" mb="md">
                Goes through a small local bridge (Node 18+, no dependencies).
                When {appName} is unreachable — the VPN is off, say — the agent
                is told why instead of the server just failing, and the tools
                come back by themselves once it is reachable again. On Windows,
                run these in Git Bash.
              </Text>
              <Steps steps={claudeCodeBridgeSteps(mcpUrl, name)} />
            </Tabs.Panel>
            <Tabs.Panel value="http">
              <Text size="xs" c="dimmed" mb="md">
                No Node needed, but no explanation when {appName} is unreachable
                and no automatic recovery: you reconnect the server by hand. On
                Windows, run these in Git Bash.
              </Text>
              <Steps steps={claudeCodeHttpSteps(mcpUrl, name)} />
            </Tabs.Panel>
            <Tabs.Panel value="desktop">
              <Text size="xs" c="dimmed" mb="sm">
                Claude Desktop launches local servers only, so it runs the same
                bridge. Its config file holds the credential, so enter the
                password here to build it — it is encoded in this browser and
                never sent anywhere.
              </Text>
              <PasswordInput
                label="Password"
                placeholder="Password for this account"
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
                mb="md"
              />
              <Steps
                steps={claudeDesktopSteps(mcpUrl, desktopShown)}
                copyOverride={{ [desktopShown]: desktopCopy }}
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
              The Claude Desktop config contains a credential equivalent to the
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

/**
 * Numbered steps. A step's code is copied as shown unless `copyOverride` maps
 * it to something else — the real credential behind a masked one — or to null,
 * which disables the copy until that can be built.
 */
function Steps({
  steps,
  copyOverride = {},
}: {
  steps: SetupStep[];
  copyOverride?: Record<string, string | null>;
}) {
  return (
    <List type="ordered" size="sm" spacing="md" c="var(--text)">
      {steps.map((step, i) => (
        <List.Item key={step.title}>
          <Text size="sm" fw={500} mb={step.code || step.note ? 6 : 0}>
            {step.title}
          </Text>
          {step.code && (
            <Snippet
              label={`step ${i + 1}`}
              shown={step.code}
              copy={
                step.code in copyOverride ? copyOverride[step.code] : step.code
              }
            />
          )}
          {step.note && (
            <Text size="xs" c="dimmed" mt={6}>
              {step.note}
            </Text>
          )}
        </List.Item>
      ))}
    </List>
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
        {copy ? `Copy ${label}` : "Enter the password to copy"}
      </Button>
    </div>
  );
}
