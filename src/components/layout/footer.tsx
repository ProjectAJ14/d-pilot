import { useEffect, useState } from "react";
import { Group, Text, Tooltip, Avatar } from "@mantine/core";
import { IconBrandGithub, IconStar, IconHistory } from "@tabler/icons-react";
import { InstallAppButton } from "./pwa-prompts";

const GITHUB_OWNER = "ProjectAJ14";
const GITHUB_REPO = "d-pilot";
const REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

const CALLOUTS = [
  { text: "Open source — issues & PRs welcome", url: `${REPO_URL}/issues` },
  { text: "Found a bug or missing a feature? Tell us", url: `${REPO_URL}/issues/new` },
  { text: "Built in the open — come build with us", url: REPO_URL },
  { text: "Enjoying it? Leave a ⭐ on GitHub", url: REPO_URL },
];
const CALLOUT_INTERVAL_MS = 9000;
const CALLOUT_FADE_MS = 400;

interface Contributor {
  login: string;
  html_url: string;
  avatar_url: string;
  type: string;
}

export function Footer() {
  const [contributors, setContributors] = useState<Contributor[]>([]);
  const [calloutIndex, setCalloutIndex] = useState(0);
  const [calloutVisible, setCalloutVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setCalloutVisible(false);
      setTimeout(() => {
        setCalloutIndex((i) => (i + 1) % CALLOUTS.length);
        setCalloutVisible(true);
      }, CALLOUT_FADE_MS);
    }, CALLOUT_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contributors?per_page=20`,
      { signal: controller.signal },
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Contributor[]) => {
        if (Array.isArray(data)) {
          // Some bot accounts (e.g. semantic-release-bot) report type "User",
          // so also exclude bot-suffixed logins.
          setContributors(
            data.filter(
              (c) => c.type !== "Bot" && !/(\[bot\]|-bot)$/i.test(c.login),
            ),
          );
        }
      })
      .catch(() => {
        // GitHub API is best-effort (rate limits / offline) — footer degrades
        // gracefully without contributor avatars.
      });
    return () => controller.abort();
  }, []);

  return (
    <footer
      style={{
        height: 34,
        flexShrink: 0,
        background: "var(--surface)",
        borderTop: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        gap: 14,
        fontSize: 11.5,
        color: "var(--muted2)",
        zIndex: 40,
      }}
    >
      {/* Version + changelog */}
      <Tooltip label="View changelog">
        <a
          href={CHANGELOG_URL}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "inherit",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          <IconHistory size={13} />v{APP_VERSION}
        </a>
      </Tooltip>

      {/* Install as an app — renders only when the browser offers it */}
      <InstallAppButton />

      <div style={{ width: 1, height: 16, background: "var(--border)" }} />

      {/* GitHub star link */}
      <Tooltip label="Star us on GitHub">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            color: "inherit",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          <IconBrandGithub size={13} />
          GitHub
          <IconStar size={12} style={{ color: "var(--warning)" }} />
        </a>
      </Tooltip>

      {/* Rotating open-source callout */}
      <div
        style={{
          flex: 1,
          display: "flex",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <a
          href={CALLOUTS[calloutIndex].url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            color: "inherit",
            textDecoration: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            opacity: calloutVisible ? 1 : 0,
            transition: `opacity ${CALLOUT_FADE_MS}ms ease`,
          }}
        >
          {CALLOUTS[calloutIndex].text}
        </a>
      </div>

      {/* Contributors */}
      {contributors.length > 0 && (
        <Group gap={8} align="center" wrap="nowrap" style={{ maxWidth: "50%" }}>
          <Text size="xs" c="var(--muted2)">
            Built by
          </Text>
          <Group gap={6} align="center" wrap="nowrap">
            {contributors.slice(0, 8).map((c) => (
              <Tooltip key={c.login} label={c.login} withArrow>
                <Avatar
                  component="a"
                  href={c.html_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  src={c.avatar_url}
                  alt={c.login}
                  size={22}
                  radius="xl"
                  style={{
                    cursor: "pointer",
                    border: "1px solid var(--border)",
                  }}
                />
              </Tooltip>
            ))}
          </Group>
        </Group>
      )}
    </footer>
  );
}
