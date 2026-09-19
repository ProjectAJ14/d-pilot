import { useState } from "react";
import { TextInput, PasswordInput, Button, Text } from "@mantine/core";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { Footer } from "../layout/footer";

export function LoginScreen() {
  const login = useStore((s) => s.login);
  const { appName, logoUrl, lightLogoUrl, emailDomain } = useStore(
    (s) => s.config,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!username || !password) {
      setError("Username and password are required");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const { token, user } = await api.login(username, password);
      login(token, user);
    } catch (err: any) {
      setError(err.message || "Invalid credentials");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleLogin();
  };

  const emailPlaceholder = emailDomain
    ? `user@${emailDomain}`
    : "user@example.com";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        zIndex: 200,
      }}
    >
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left panel — dark branding */}
        <div
          style={{
            flex: 1,
            // The brand surface: one palette on BOTH grounds, because a logo
            // does not invert when you turn the lights on. The form beside it
            // is what switches. Defined in tokens.css so a new accent still
            // re-themes it; its contents are always light-on-verdigris.
            background: "var(--brand-bg)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            position: "relative",
            overflow: "hidden",
          }}
        >
          {/* Subtle glow */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "var(--brand-glow)",
            }}
          />
          <div style={{ position: "relative", textAlign: "center" }}>
            {(lightLogoUrl || logoUrl) && (
              <img
                src={lightLogoUrl || logoUrl!}
                alt={appName}
                style={{ height: 200, marginBottom: 36 }}
              />
            )}
            {/* The one place the display face gets to be loud. The two lines
                under it are micro-labels, so they take the mono treatment —
                and a solved ramp step rather than white-at-35%, which was
                2.2:1 and unreadable. */}
            <Text
              component="h1"
              c="var(--brand-ink)"
              mb={8}
              style={{
                fontFamily: "var(--font-disp)",
                fontWeight: "var(--weight-extra)",
                fontSize: "var(--display-1)",
                letterSpacing: "var(--tracking-display)",
                lineHeight: "var(--leading-display)",
              }}
            >
              {appName}
            </Text>
            <Text className="dp-eyebrow" c="var(--brand-dim)">
              Internal Query Tool
            </Text>
            <Text className="dp-eyebrow" c="var(--brand-faint)" mt={6}>
              HIPAA &middot; PHI Tokenized
            </Text>
          </div>
        </div>

        {/* Right panel — login form */}
        <div
          style={{
            flex: 1,
            background: "var(--bg)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div style={{ width: 360 }}>
            <Text fw={700} size="xl" mb={4}>
              Sign in
            </Text>
            <Text size="sm" c="dimmed" mb="xl">
              Use your {emailDomain ? `@${emailDomain}` : "organization"}{" "}
              credentials.
            </Text>

            {error && (
              <div
                style={{
                  background:
                    "color-mix(in srgb, var(--error) 8%, transparent)",
                  border:
                    "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
                  color: "var(--error)",
                  fontSize: 12,
                  padding: "10px 14px",
                  borderRadius: 7,
                  marginBottom: 14,
                }}
              >
                {error}
              </div>
            )}

            <TextInput
              label="EMAIL"
              placeholder={emailPlaceholder}
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              mb="sm"
              styles={{
                label: {
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: "var(--muted)",
                },
                input: {
                  background: "var(--surface2)",
                  border: "1px solid var(--border2)",
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: 13,
                },
              }}
            />

            <PasswordInput
              label="PASSWORD"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              mb="xl"
              styles={{
                label: {
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: "var(--muted)",
                },
                input: {
                  background: "var(--surface2)",
                  border: "1px solid var(--border2)",
                  fontFamily: "IBM Plex Mono, monospace",
                  fontSize: 13,
                },
              }}
            />

            <Button
              fullWidth
              size="md"
              loading={loading}
              onClick={handleLogin}
              styles={{
                root: {
                  fontWeight: 700,
                  fontSize: 14,
                },
              }}
            >
              Sign In &rarr;
            </Button>
          </div>
        </div>
      </div>
      <Footer />
    </div>
  );
}
