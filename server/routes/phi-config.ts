import { Router, Request, Response } from "express";
import {
  getPhiRules,
  upsertPhiRule,
  deletePhiRule,
  applyPhiRuleImport,
  deleteAllPhiRules,
  getPhiMaskedEnvs,
  setSetting,
  logAudit,
} from "../services/sqlite-store.js";
import { requireAdmin } from "../middleware/auth.js";
import { getConnection } from "../config/connections.js";
import type { Environment, MaskingType, PhiFieldRule } from "../types/index.js";

const router = Router();

// --- CSV helpers (RFC 4180) ---

const MASKING_TYPES: MaskingType[] = ["FULL", "PARTIAL", "HASH", "REDACT"];
const CSV_COLUMNS = [
  "pattern",
  "maskingType",
  "alwaysMasked",
  "database",
  "table",
] as const;
const MAX_IMPORT_ROWS = 1000;

// Cells starting with a formula trigger are prefixed with a single quote so
// spreadsheets treat them as text; unneutralize() strips it on import.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

function csvEscape(value: string): string {
  const v = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function unneutralize(value: string): string {
  return value.startsWith("'") && FORMULA_TRIGGER.test(value.slice(1))
    ? value.slice(1)
    : value;
}

interface CsvRow {
  cells: string[];
  line: number; // 1-based physical line in the file, for error messages
}

function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  // Strip BOM
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      // A quote only opens quoted mode at field start; mid-field quotes are
      // literal (matches common spreadsheet leniency for hand-edited files).
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      line++;
      cells.push(field);
      field = "";
      rows.push({ cells, line: rowLine });
      cells = [];
      rowLine = line;
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || cells.length > 0) {
    cells.push(field);
    rows.push({ cells, line: rowLine });
  }
  // Drop rows that are entirely empty (blank lines)
  return rows.filter((r) => r.cells.some((cell) => cell.trim() !== ""));
}

// Identity of a rule for duplicate detection: pattern + scope, case-insensitive.
function ruleKey(pattern: string, database?: string, table?: string): string {
  return [pattern, database ?? "", table ?? ""]
    .map((s) => s.trim().toLowerCase())
    .join("\u0000");
}

function parseBoolean(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  // An empty cell defaults to false.
  if (["false", "0", "no", "n", ""].includes(v)) return false;
  return null;
}

// Masked environments
router.get("/masked-envs", (_req: Request, res: Response) => {
  res.json({ environments: getPhiMaskedEnvs() });
});

router.put("/masked-envs", requireAdmin, (req: Request, res: Response) => {
  const { environments } = req.body;
  const valid: Environment[] = ["DEV", "QA", "UAT", "STG", "PROD"];
  if (
    !Array.isArray(environments) ||
    !environments.every((e: string) => valid.includes(e as Environment))
  ) {
    res.status(400).json({
      error: "Invalid environments list. Allowed: DEV, QA, UAT, STG, PROD",
    });
    return;
  }
  // Production PHI must always be tokenized — it can't be removed from masking.
  if (!environments.includes("PROD")) {
    res.status(422).json({
      error:
        "Production PHI is always tokenized and can't be exposed. PROD must remain a masked environment.",
    });
    return;
  }
  setSetting("phi_masked_envs", JSON.stringify(environments));
  res.json({ environments });
});

// Log PHI unmask event
router.post("/unmask", (req: Request, res: Response) => {
  const user = req.user!;

  const { reason, notes, connectionId } = req.body;

  // Unmask is environment-scoped: check the target connection's environment.
  const conn = connectionId ? getConnection(connectionId) : undefined;
  const canUnmaskHere = conn
    ? user.isAdmin || user.unmaskEnvironments.includes(conn.env)
    : user.canUnmaskPhi;
  if (!canUnmaskHere) {
    res
      .status(403)
      .json({ error: "PHI unmask permission required for this environment" });
    return;
  }

  if (!reason) {
    res.status(400).json({ error: "Reason is required" });
    return;
  }

  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "PHI_UNMASK",
    connectionId: connectionId ?? null,
    phiAccessed: true,
    phiUnmaskReason: reason,
    phiUnmaskNotes: notes || undefined,
  });

  res.json({ logged: true });
});

// Anyone can view PHI rules
router.get("/", (_req: Request, res: Response) => {
  res.json(getPhiRules());
});

// Export all rules as CSV (same visibility as GET /)
router.get("/export", (req: Request, res: Response) => {
  const user = req.user!;
  const rules = getPhiRules();
  const lines = [CSV_COLUMNS.join(",")];
  for (const r of rules) {
    lines.push(
      [
        r.pattern,
        r.maskingType,
        r.alwaysMasked ? "true" : "false",
        r.database ?? "",
        r.table ?? "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "PHI_RULES_EXPORT",
    sql: `Exported ${rules.length} PHI rule(s) as CSV`,
    rowsReturned: rules.length,
    phiAccessed: false,
  });

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=phi-rules.csv");
  res.send(lines.join("\n"));
});

// Import rules from CSV. Validation errors reject the whole file (nothing is
// applied). Rows are matched to existing rules on pattern + database + table
// (case-insensitive): identical rows are skipped (re-imports never create
// duplicates), rows with a different maskingType/alwaysMasked update the
// existing rule, and new rows are inserted — all in one transaction.
router.post("/import", requireAdmin, (req: Request, res: Response) => {
  const user = req.user!;
  const { csv } = req.body;

  if (typeof csv !== "string" || !csv.trim()) {
    res.status(400).json({ error: "csv (file content) is required" });
    return;
  }

  const rows = parseCsv(csv);
  if (rows.length === 0) {
    res.status(400).json({ error: "CSV file is empty" });
    return;
  }

  // Header row: case-insensitive, any column order, unknown columns ignored.
  const header = rows[0].cells.map((h) => h.trim().toLowerCase());
  const col: Record<(typeof CSV_COLUMNS)[number], number> = {
    pattern: header.indexOf("pattern"),
    maskingType: header.indexOf("maskingtype"),
    alwaysMasked: header.indexOf("alwaysmasked"),
    database: header.indexOf("database"),
    table: header.indexOf("table"),
  };
  if (col.pattern === -1 || col.maskingType === -1) {
    res.status(400).json({
      error:
        'CSV must have a header row with at least "pattern" and "maskingType" columns. Use Export CSV to get a template.',
    });
    return;
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    res.status(400).json({ error: "CSV has no data rows below the header" });
    return;
  }
  if (dataRows.length > MAX_IMPORT_ROWS) {
    res.status(400).json({
      error: `CSV has ${dataRows.length} rows — the limit per import is ${MAX_IMPORT_ROWS}`,
    });
    return;
  }

  const cell = (cells: string[], idx: number) =>
    idx === -1 ? "" : unneutralize((cells[idx] ?? "").trim());

  const errors: string[] = [];
  const parsed: Omit<PhiFieldRule, "id">[] = [];
  for (const { cells, line } of dataRows) {
    const pattern = cell(cells, col.pattern);
    const maskingType = cell(cells, col.maskingType).toUpperCase();
    const alwaysMasked = parseBoolean(cell(cells, col.alwaysMasked));

    const rowErrors: string[] = [];
    if (!pattern) rowErrors.push(`line ${line}: pattern is required`);
    if (!MASKING_TYPES.includes(maskingType as MaskingType))
      rowErrors.push(
        `line ${line}: invalid maskingType "${cell(cells, col.maskingType)}" (allowed: ${MASKING_TYPES.join(", ")})`,
      );
    if (alwaysMasked === null)
      rowErrors.push(
        `line ${line}: invalid alwaysMasked "${cell(cells, col.alwaysMasked)}" (use true/false)`,
      );
    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
      continue;
    }

    parsed.push({
      pattern,
      maskingType: maskingType as MaskingType,
      alwaysMasked: alwaysMasked === true,
      database: cell(cells, col.database) || undefined,
      table: cell(cells, col.table) || undefined,
    });
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, 5).join("; ");
    const more = errors.length > 5 ? ` (and ${errors.length - 5} more)` : "";
    res.status(400).json({
      error: `Import rejected, nothing was applied: ${shown}${more}`,
      errors,
    });
    return;
  }

  // Reconcile against existing rules and within the file itself.
  const existingByKey = new Map(
    getPhiRules().map((r) => [ruleKey(r.pattern, r.database, r.table), r]),
  );
  const seenInFile = new Set<string>();
  const toInsert: Omit<PhiFieldRule, "id">[] = [];
  const toUpdate: PhiFieldRule[] = [];
  let skipped = 0;
  for (const rule of parsed) {
    const key = ruleKey(rule.pattern, rule.database, rule.table);
    if (seenInFile.has(key)) {
      skipped++;
      continue;
    }
    seenInFile.add(key);

    const existing = existingByKey.get(key);
    if (!existing) {
      toInsert.push(rule);
    } else if (
      existing.maskingType === rule.maskingType &&
      existing.alwaysMasked === rule.alwaysMasked
    ) {
      skipped++;
    } else {
      toUpdate.push({ ...rule, id: existing.id });
    }
  }

  applyPhiRuleImport(toInsert, toUpdate);
  const imported = toInsert.length;
  const updated = toUpdate.length;

  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "PHI_RULES_IMPORT",
    sql: `Imported ${imported}, updated ${updated}, skipped ${skipped} identical PHI rule(s) from CSV`,
    rowsReturned: imported + updated,
    phiAccessed: false,
  });

  res.json({ imported, updated, skipped, total: parsed.length });
});

// Only admins can modify PHI rules
router.post("/", requireAdmin, (req: Request, res: Response) => {
  const { pattern, maskingType, alwaysMasked, database, table } = req.body;

  if (!pattern || !maskingType) {
    res.status(400).json({ error: "pattern and maskingType are required" });
    return;
  }

  const rule = upsertPhiRule({
    pattern,
    maskingType,
    alwaysMasked: alwaysMasked ?? false,
    database,
    table,
  });
  res.status(201).json(rule);
});

router.put("/:id", requireAdmin, (req: Request, res: Response) => {
  const { pattern, maskingType, alwaysMasked, database, table } = req.body;
  const rule = upsertPhiRule({
    id: req.params.id as string,
    pattern,
    maskingType,
    alwaysMasked,
    database,
    table,
  });
  res.json(rule);
});

// Delete all rules. Locked (alwaysMasked) rules are kept unless
// includeLocked=true is passed explicitly.
router.delete("/", requireAdmin, (req: Request, res: Response) => {
  const user = req.user!;
  const includeLocked = req.query.includeLocked === "true";
  const { deleted, kept } = deleteAllPhiRules(includeLocked);

  logAudit({
    userId: user.sub,
    userEmail: user.email,
    action: "PHI_RULES_DELETE_ALL",
    sql: `Deleted ${deleted} PHI rule(s)${includeLocked ? " including locked" : `, kept ${kept} locked`}`,
    rowsReturned: deleted,
    phiAccessed: false,
  });

  res.json({ deleted, kept });
});

router.delete("/:id", requireAdmin, (req: Request, res: Response) => {
  const deleted = deletePhiRule(req.params.id as string);
  if (!deleted) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json({ deleted: true });
});

export default router;
