import { Component, type ReactNode } from "react";
import { Button, Group, Text } from "@mantine/core";
import {
  IconAlertTriangle,
  IconBrandGithub,
  IconRefresh,
} from "@tabler/icons-react";
import { reportUrl } from "../../utils/notify-error";

interface State {
  message: string | null;
  href: string | null;
}

/**
 * A render crash used to unmount the whole tree and leave a blank page. This
 * catches it and says so. Only render-time errors land here — async and event
 * handler failures are caught at their call sites and go through notifyError.
 */
export class CrashScreen extends Component<{ children: ReactNode }, State> {
  state: State = { message: null, href: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : String(error);
    return { message, href: reportUrl({ where: "App", message }) };
  }

  render() {
    const { message, href } = this.state;
    if (message === null) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          height: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 16,
          background: "var(--bg)",
          color: "var(--error)",
        }}
      >
        <IconAlertTriangle size={32} />
        <Text size="sm" fw={600}>
          Something went wrong
        </Text>
        <Text
          size="xs"
          ff="monospace"
          style={{
            maxWidth: 500,
            textAlign: "center",
            background: "color-mix(in srgb, var(--error) 8%, transparent)",
            padding: "10px 16px",
            borderRadius: "var(--radius-md)",
            border:
              "1px solid color-mix(in srgb, var(--error) 25%, transparent)",
            whiteSpace: "pre-wrap",
          }}
        >
          {message}
        </Text>
        <Group gap="xs" mt="xs">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={() => window.location.reload()}
          >
            Reload
          </Button>
          {href && (
            <Button
              component="a"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              variant="default"
              size="xs"
              leftSection={<IconBrandGithub size={14} />}
            >
              Report issue
            </Button>
          )}
        </Group>
      </div>
    );
  }
}
