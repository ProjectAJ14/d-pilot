import { IconClock } from "@tabler/icons-react";
import { datetimeParts } from "../../utils/datetime";

/**
 * Custom AG Grid tooltip. For ISO datetimes it renders a labeled two-line card
 * (local time + original source); for everything else it falls back to a plain
 * wrapped-text preview. `props.value` is the tooltipValueGetter result.
 */
export function GridCellTooltip(props: { value?: unknown }) {
  const value = props.value;
  const parts = datetimeParts(value);

  const card: React.CSSProperties = {
    background: "#ffffff",
    color: "#0c2340",
    border: "1px solid #ccd0d2",
    borderRadius: 8,
    boxShadow: "0 8px 24px rgba(12,35,64,0.16)",
    padding: "10px 12px",
    maxWidth: 360,
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    lineHeight: 1.45,
  };

  if (parts) {
    const label: React.CSSProperties = {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: 0.7,
      textTransform: "uppercase",
    };
    return (
      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 5, color: "#1f9196" }}>
          <IconClock size={13} />
          <span style={label}>{parts.naive ? "Local time" : "Your time"}</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 3 }}>{parts.local}</div>

        <div style={{ height: 1, background: "#e8e8e8", margin: "9px 0" }} />

        <div style={{ ...label, color: "#7a8894" }}>{parts.sourceLabel}</div>
        <div
          style={{
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 11.5,
            color: "#475569",
            wordBreak: "break-all",
            marginTop: 2,
          }}
        >
          {parts.source}
        </div>
        {parts.naive && (
          <div style={{ fontSize: 10.5, color: "#94a3b8", marginTop: 5, fontStyle: "italic" }}>
            No time zone in source — shown as local.
          </div>
        )}
      </div>
    );
  }

  // Non-datetime fallback — plain, wrapped preview.
  return (
    <div
      style={{
        ...card,
        fontFamily: "IBM Plex Mono, monospace",
        fontSize: 11.5,
        maxWidth: 440,
        maxHeight: 320,
        overflow: "hidden",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {value === null || value === undefined ? "NULL" : String(value)}
    </div>
  );
}
