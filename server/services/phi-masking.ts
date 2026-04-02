import { createHash } from "crypto";
import { getPhiRules } from "./sqlite-store.js";
import type { MaskingType, PhiFieldRule, QueryColumn } from "../types/index.js";

/**
 * Matches a column name against a glob-like pattern (case-insensitive).
 * Supports * as wildcard.
 */
function matchPattern(columnName: string, pattern: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(columnName);
}

/**
 * Finds the matching PHI rule for a column, if any.
 */
export function findMatchingRule(
  columnName: string,
  database?: string,
  table?: string
): PhiFieldRule | null {
  const rules = getPhiRules();

  for (const rule of rules) {
    // If rule is scoped to a specific database/table, check those first
    if (rule.database && database && rule.database.toLowerCase() !== database.toLowerCase()) continue;
    if (rule.table && table && rule.table.toLowerCase() !== table.toLowerCase()) continue;

    if (matchPattern(columnName, rule.pattern)) {
      return rule;
    }
  }
  return null;
}

/**
 * Applies masking to a single value based on the masking type.
 */
export function maskValue(value: unknown, maskingType: MaskingType): unknown {
  if (value === null || value === undefined) return value;

  const str = String(value);

  switch (maskingType) {
    case "FULL":
      return "********";

    case "PARTIAL": {
      if (str.length <= 4) return "****";
      const visible = str.slice(-4);
      return "*".repeat(str.length - 4) + visible;
    }

    case "HASH": {
      const hash = createHash("sha256").update(str).digest("hex").slice(0, 12);
      return `tok_${hash}`;
    }

    case "REDACT":
      return "[REDACTED]";

    default:
      return "********";
  }
}

/**
 * Processes query results and masks PHI fields.
 * Returns the masked rows + metadata about which columns were masked.
 */
export function maskQueryResults(
  columns: string[],
  rows: Record<string, unknown>[],
  options: {
    phiEnabled: boolean; // is PHI shield on?
    isAdmin: boolean;
    database?: string;
    table?: string;
  }
): {
  maskedRows: Record<string, unknown>[];
  maskedColumns: QueryColumn[];
  maskedFieldNames: string[];
} {
  const columnMeta: QueryColumn[] = [];
  const maskedFieldNames: string[] = [];

  // Determine which columns need masking
  const columnMasks = new Map<string, { type: MaskingType; alwaysMasked: boolean }>();

  for (const col of columns) {
    const rule = findMatchingRule(col, options.database, options.table);
    if (rule) {
      // Always-masked fields are ALWAYS masked, regardless of toggle or role
      const shouldMask = rule.alwaysMasked || options.phiEnabled;
      if (shouldMask) {
        columnMasks.set(col, { type: rule.maskingType, alwaysMasked: rule.alwaysMasked });
        maskedFieldNames.push(col);
      }
      columnMeta.push({
        name: col,
        type: "string",
        isMasked: shouldMask,
        maskingType: shouldMask ? rule.maskingType : undefined,
      });
    } else {
      columnMeta.push({ name: col, type: "string", isMasked: false });
    }
  }

  // Apply masking to rows
  const maskedRows = rows.map((row) => {
    const masked = { ...row };
    for (const [col, mask] of columnMasks) {
      if (col in masked) {
        masked[col] = maskValue(masked[col], mask.type);
      }
    }
    return masked;
  });

  return { maskedRows, maskedColumns: columnMeta, maskedFieldNames };
}
