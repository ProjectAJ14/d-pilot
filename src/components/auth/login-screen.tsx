import { useState } from "react";
import { TextInput, PasswordInput, Button, Text } from "@mantine/core";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";

export function LoginScreen() {
  const login = useStore((s) => s.login);
  const { appName, logoUrl, emailDomain } = useStore((s) => s.config);
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
        background: "var(--bg)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 200,
      }}
    >
      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse 60% 50% at 20% 20%, rgba(31,145,150,0.06) 0%, transparent 60%), radial-gradient(ellipse 50% 40% at 80% 80%, rgba(12,35,64,0.05) 0%, transparent 60%)",
        }}
      />

      {/* Login card */}
      <div
        style={{
          position: "relative",
          width: 420,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 40,
          boxShadow: "0 24px 80px rgba(0,0,0,0.1)",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
          {logoUrl && (
            <>
              <img src={logoUrl} alt={appName} style={{ height: 36 }} />
              <div style={{ width: 1, height: 28, background: "var(--border)" }} />
            </>
          )}
          <div>
            <Text fw={700} size="lg" c="var(--accent)">
              {appName}
            </Text>
            <Text
              size="xs"
              c="dimmed"
              ff="monospace"
              style={{ marginTop: 2 }}
            >
              Internal Query Tool &middot; HIPAA &middot; PHI Tokenized
            </Text>
          </div>
        </div>

        <Text fw={700} size="xl" mb={4}>
          Sign in
        </Text>
        <Text size="sm" c="dimmed" mb="lg">
          Use your {emailDomain ? `@${emailDomain}` : "organization"} credentials to sign in.
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
          mb="lg"
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
              marginTop: 6,
            },
          }}
        >
          Sign In &rarr;
        </Button>

        <Text size="xs" c="dimmed" ta="center" mt="lg" ff="monospace">
          PHI fields are tokenized on all PROD & STG connections &middot;{" "}
          <strong style={{ color: "var(--token)" }}>v1.0.0</strong>
        </Text>
      </div>
    </div>
  );
}
