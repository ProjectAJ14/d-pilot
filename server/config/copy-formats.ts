import type { CopyFormat } from "../types/index.js";

/**
 * Fallback "Copy as" formats served when `COPY_FORMATS` is unset. Keep in sync
 * with `DEFAULT_COPY_FORMATS` in `src/utils/data-extractors.ts` (the renderer);
 * the client also carries its own copy as a last-resort fallback.
 */
export const DEFAULT_COPY_FORMATS: CopyFormat[] = [
  {
    id: "csv",
    label: "CSV",
    group: "Tabular",
    example: "id,code",
    builtin: "csv",
    columnMenu: true,
  },
  {
    id: "tsv",
    label: "TSV",
    group: "Tabular",
    example: "id\\tcode",
    builtin: "tsv",
  },
  {
    id: "json",
    label: "JSON",
    group: "Tabular",
    example: '[{ "id": 18 }]',
    builtin: "json",
    columnMenu: true,
  },
  {
    id: "markdown",
    label: "Markdown table",
    group: "Tabular",
    example: "| id | code |",
    builtin: "markdown",
  },
  {
    id: "sql-insert",
    label: "SQL INSERT",
    group: "Tabular",
    example: "INSERT INTO … VALUES (…);",
    builtin: "sql-insert",
  },
  {
    id: "comma",
    label: "Comma-separated",
    group: "List / SQL",
    example: "1560,1580,1593",
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "none" },
  },
  {
    id: "single-quoted",
    label: "Single-quoted (SQL IN)",
    group: "List / SQL",
    example: "'1560','1580'",
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "single" },
  },
  {
    id: "double-quoted",
    label: "Double-quoted",
    group: "List / SQL",
    example: '"1560","1580"',
    columnMenu: true,
    template: { columnSeparator: ",", rowSeparator: ",", quote: "double" },
  },
];

/** A format is usable only if it has an id/label and exactly one renderer source. */
function isValidFormat(f: unknown): f is CopyFormat {
  if (!f || typeof f !== "object") return false;
  const fmt = f as Record<string, unknown>;
  if (typeof fmt.id !== "string" || typeof fmt.label !== "string") return false;
  const hasBuiltin = typeof fmt.builtin === "string";
  const hasTemplate = !!fmt.template && typeof fmt.template === "object";
  // Exactly one source — a format with neither renders nothing; both is ambiguous.
  return hasBuiltin !== hasTemplate;
}

let cached: CopyFormat[] | null = null;

/**
 * The deployment's "Copy as" formats. Parsed from `COPY_FORMATS` (a JSON array
 * of `CopyFormat`); invalid entries are dropped and, if nothing valid remains,
 * we fall back to `DEFAULT_COPY_FORMATS` so the menu is never empty.
 */
export function loadCopyFormats(): CopyFormat[] {
  if (cached) return cached;

  const raw = process.env.COPY_FORMATS;
  if (!raw) {
    cached = DEFAULT_COPY_FORMATS;
    return cached;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed))
      throw new Error("COPY_FORMATS must be a JSON array");
    const valid = parsed.filter(isValidFormat);
    if (valid.length === 0) {
      console.warn("COPY_FORMATS had no valid entries, using defaults");
      cached = DEFAULT_COPY_FORMATS;
    } else {
      if (valid.length !== parsed.length) {
        console.warn(
          `COPY_FORMATS: dropped ${parsed.length - valid.length} invalid entr(y/ies)`,
        );
      }
      cached = valid;
    }
    return cached;
  } catch (err) {
    console.error("Failed to parse COPY_FORMATS, using defaults:", err);
    cached = DEFAULT_COPY_FORMATS;
    return cached;
  }
}
