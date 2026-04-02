import { useState } from "react";
import { TextInput, PasswordInput, Button, Text } from "@mantine/core";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";

export function LoginScreen() {
  const login = useStore((s) => s.login);
  const { appName, logoUrl, lightLogoUrl, emailDomain } = useStore((s) => s.config);
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

  const emailPlaceholder = emailDomain ? `user@${emailDomain}` : "user@example.com";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        zIndex: 200,
      }}
    >
      {/* Left panel — dark branding */}
      <div
        style={{
          flex: 1,
          background: "linear-gradient(160deg, #143656 0%, #102a45 50%, #143656 100%)",
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
            background:
              "radial-gradient(ellipse 60% 50% at 30% 40%, rgba(31,145,150,0.15) 0%, transparent 60%)",
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
          <Text fw={700} size="28px" c="white" mb={8}>
            {appName}
          </Text>
          <Text size="sm" c="rgba(255,255,255,0.5)" ff="monospace">
            Internal Query Tool
          </Text>
          <Text size="xs" c="rgba(255,255,255,0.35)" ff="monospace" mt={4}>
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
            Use your {emailDomain ? `@${emailDomain}` : "organization"} credentials.
          </Text>

          {error && (
            <div
              style={{
                background: "rgba(215,54,54,0.08)",
                border: "1px solid rgba(215,54,54,0.3)",
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

          <Text size="xs" c="dimmed" ta="center" mt="xl" ff="monospace">
            v1.0.0
          </Text>
        </div>
      </div>
    </div>
  );
}
