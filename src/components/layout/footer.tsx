import { useEffect, useState } from "react";
import { Group, Text, Tooltip, Avatar } from "@mantine/core";
import { IconBrandGithub, IconStar, IconHistory } from "@tabler/icons-react";

const GITHUB_OWNER = "ProjectAJ14";
const GITHUB_REPO = "d-pilot";
const REPO_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
const CHANGELOG_URL = `${REPO_URL}/blob/main/CHANGELOG.md`;

const APP_VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

interface Contributor {
  login: string;
  html_url: string;
  avatar_url: string;
  type: string;
}

export function Footer() {
  const [contributors, setContributors] = useState<Contributor[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contributors?per_page=20`,
      { signal: controller.signal },
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((data: Contributor[]) => {
        if (Array.isArray(data)) {
          setContributors(data.filter((c) => c.type !== "Bot"));
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
          <IconHistory size={13} />
          v{APP_VERSION}
        </a>
      </Tooltip>

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
          <IconStar size={12} style={{ color: "#e3b341" }} />
        </a>
      </Tooltip>

      <div style={{ flex: 1 }} />

      {/* Contributors */}
      {contributors.length > 0 && (
        <Group gap={8} align="center">
          <Text size="xs" c="var(--muted2)">
            Built by
          </Text>
          <Avatar.Group spacing="sm">
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
                  style={{ cursor: "pointer", border: "1px solid var(--border)" }}
                />
              </Tooltip>
            ))}
          </Avatar.Group>
        </Group>
      )}
    </footer>
  );
}
