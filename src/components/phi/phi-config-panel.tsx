import { useState, useEffect } from "react";
import { Text, ScrollArea, ActionIcon, Switch } from "@mantine/core";
import { IconX, IconShieldLock } from "@tabler/icons-react";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import type { PhiFieldRule } from "../../types";

const FIELD_ICONS: Record<string, string> = {
  "*firstName*": "👤",
  "*lastName*": "👤",
  "*middleName*": "👤",
  "*preferredName*": "👤",
  "*dateOfBirth*": "🎂",
  "*date_of_birth*": "🎂",
  "*dob*": "🎂",
  "*email*": "✉️",
  "*phone*": "📞",
  "*addressLine1*": "🏠",
  "*addressLine2*": "🏠",
  "*zipCode*": "🏠",
  "*memberId*": "💳",
  "*policyNumber*": "💳",
  "*ethnicity*": "🧬",
};

function getIcon(pattern: string): string {
  return FIELD_ICONS[pattern] || "🔐";
}

function getTokenLabel(pattern: string): string {
  const clean = pattern.replace(/\*/g, "").toUpperCase();
  return `${clean}_TOKEN_#####`;
}

export function PhiConfigPanel() {
  const phiPanelOpen = useStore((s) => s.phiPanelOpen);
  const togglePhiPanel = useStore((s) => s.togglePhiPanel);
  const [rules, setRules] = useState<PhiFieldRule[]>([]);

  useEffect(() => {
    if (phiPanelOpen) {
      api.getPhiRules().then(setRules).catch(console.error);
    }
  }, [phiPanelOpen]);

  return (
    <div
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: 340,
        background: "var(--surface)",
        borderLeft: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        transform: phiPanelOpen ? "translateX(0)" : "translateX(100%)",
        transition: "transform 0.25s ease",
        zIndex: 30,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: 16,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text fw={700} size="sm">
          <IconShieldLock size={14} style={{ marginRight: 6 }} />
          PHI Tokenization Config
        </Text>
        <ActionIcon variant="subtle" color="gray" onClick={togglePhiPanel}>
          <IconX size={18} />
        </ActionIcon>
      </div>

      {/* Body */}
      <ScrollArea style={{ flex: 1, padding: 14 }} scrollbarSize={4}>
        {/* Token Strategy Banner */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            background: "rgba(31,145,150,0.08)",
            border: "1px solid rgba(31,145,150,0.25)",
            borderRadius: 10,
            padding: 14,
            marginBottom: 14,
          }}
        >
          <div style={{ fontSize: 22, flexShrink: 0, marginTop: 1 }}>🪙</div>
          <div>
            <Text fw={700} size="xs" c="primary" mb={4}>
              Tokenized Placeholder Strategy
            </Text>
            <Text size="xs" c="dimmed" style={{ lineHeight: 1.6 }}>
              Real PHI is replaced at query time with deterministic tokens. The
              same patient always gets the same token — enabling joins and
              analytics without exposing data.
            </Text>
            <div
              style={{
                fontFamily: "IBM Plex Mono, monospace",
                fontSize: 10,
                color: "var(--token)",
                background: "rgba(31,145,150,0.1)",
                borderRadius: 4,
                padding: "6px 8px",
                marginTop: 8,
              }}
            >
              name &nbsp;&nbsp;&nbsp;&rarr; PATIENT_NAME_04821
              <br />
              ssn &nbsp;&nbsp;&nbsp;&nbsp;&rarr; SSN_TOKEN_7823
              <br />
              email &nbsp;&nbsp;&rarr; EMAIL_TOKEN_3341
              <br />
              dob &nbsp;&nbsp;&nbsp;&nbsp;&rarr; DOB_TOKEN_1192
            </div>
          </div>
        </div>

        {/* PHI Field Rules */}
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mb={6}
          style={{ letterSpacing: 1 }}
        >
          Auto-Flagged PHI Fields
        </Text>

        {rules.map((rule) => (
          <div
            key={rule.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: 10,
              borderRadius: 8,
              border: "1px solid var(--border)",
              marginBottom: 6,
              background: "var(--surface2)",
            }}
          >
            <span style={{ fontSize: 16 }}>{getIcon(rule.pattern)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="xs" fw={600}>
                {rule.pattern.replace(/\*/g, "")}
              </Text>
              <Text size="xs" c="dimmed" ff="monospace" truncate>
                {rule.pattern}
              </Text>
            </div>
            <Text
              size="xs"
              ff="monospace"
              style={{
                color: "var(--token)",
                background: "rgba(31,145,150,0.1)",
                borderRadius: 4,
                padding: "2px 6px",
                whiteSpace: "nowrap",
                fontSize: 9,
              }}
            >
              {rule.maskingType}
            </Text>
            {rule.alwaysMasked && (
              <Text size="xs" c="red" fw={700} style={{ fontSize: 9 }}>
                LOCKED
              </Text>
            )}
          </div>
        ))}

        {/* Unmask Permission */}
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mt="md"
          mb={6}
          style={{ letterSpacing: 1 }}
        >
          Unmask Permission
        </Text>
        <div
          style={{
            fontSize: 12,
            color: "var(--muted2)",
            padding: "10px 12px",
            background: "var(--surface2)",
            borderRadius: 8,
            border: "1px solid var(--border)",
            lineHeight: 1.7,
          }}
        >
          <strong style={{ color: "var(--error)" }}>ADMIN</strong> role only
          &middot; Reason required
          <br />
          Tokens are resolved server-side on unmask.
          <br />
          All de-tokenization events are audit-logged.
        </div>

        {/* Scope */}
        <Text
          size="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          mt="md"
          mb={6}
          style={{ letterSpacing: 1 }}
        >
          Scope
        </Text>
        <div
          style={{
            fontSize: 12,
            color: "var(--muted2)",
            padding: "10px 12px",
            background: "var(--surface2)",
            borderRadius: 8,
            border: "1px solid var(--border)",
            lineHeight: 1.7,
          }}
        >
          Tokenization enforced on{" "}
          <strong style={{ color: "var(--error)" }}>PROD</strong> and{" "}
          <strong style={{ color: "var(--phi)" }}>STAGING</strong>.
          <br />
          <span style={{ color: "var(--accent2)" }}>QA</span> and{" "}
          <span style={{ color: "var(--accent2)" }}>DEV</span> connections
          return real values.
        </div>
      </ScrollArea>
    </div>
  );
}
