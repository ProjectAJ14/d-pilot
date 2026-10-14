/**
 * Parse pasted DBFORGE_CONNECTIONS-style JSON for Settings → Connections →
 * Import: an array of connections, or one connection object. Only the JSON
 * shape is checked here — each item is validated by the server (dry run), so
 * the field rules live in one place. Invalid JSON is reported, never repaired.
 */
export function parseConnectionsJson(
  text: string,
): { items: unknown[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: describeJsonError(text, (err as Error).message) };
  }
  if (Array.isArray(parsed)) {
    return parsed.length > 0
      ? { items: parsed }
      : { error: "The array is empty — nothing to import" };
  }
  if (parsed !== null && typeof parsed === "object") return { items: [parsed] };
  return {
    error: "Expected an array of connections or a single connection object",
  };
}

function lineCol(text: string, index: number): string {
  const lines = text.slice(0, index).split("\n");
  return `line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
}

/** Index of a `,` followed only by whitespace and `]`/`}`, outside strings. */
function trailingComma(text: string): number {
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "," && /^\s*[\]}]/.test(text.slice(i + 1))) return i;
  }
  return -1;
}

function describeJsonError(text: string, message: string): string {
  // The most common paste mistake, and one engines word inconsistently (V8
  // gives no position for it at all), so find it ourselves.
  const comma = trailingComma(text);
  if (comma >= 0)
    return `Trailing comma at ${lineCol(text, comma)} — remove the comma after the last item`;
  // Engines may quote the input back (`"…" is not valid JSON`) — it holds
  // passwords, so drop it; keep or add a line/column when there's a position.
  const reason = message.replace(/,\s*".*" is not valid JSON$/s, "");
  const pos = /position (\d+)/.exec(reason);
  return pos && !/line \d+/.test(reason)
    ? `Invalid JSON: ${reason} (${lineCol(text, Number(pos[1]))})`
    : `Invalid JSON: ${reason}`;
}
