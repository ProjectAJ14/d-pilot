import type { ColumnInfo, ConnectionInfo, TableInfo } from "../types";

export type MetadataFormat = "json" | "ddl" | "text";

/** True for SQL engines where a CREATE TABLE / DDL export makes sense. */
export function supportsDdl(connection: ConnectionInfo): boolean {
  return connection.type === "postgres" || connection.type === "mssql";
}

/** Quote an identifier for the connection's SQL dialect. */
function quoteIdent(connection: ConnectionInfo, ident: string): string {
  if (connection.type === "mssql") return `[${ident}]`;
  return `"${ident}"`;
}

/**
 * Render an FK target (`[schema.]table.column`) as a quoted `REFERENCES` target,
 * or null when it has no column part to point at.
 */
function refClause(connection: ConnectionInfo, reference: string): string | null {
  const dot = reference.lastIndexOf(".");
  if (dot <= 0) return null;
  const table = reference
    .slice(0, dot)
    .split(".")
    .map((part) => quoteIdent(connection, part))
    .join(".");
  return `${table}(${quoteIdent(connection, reference.slice(dot + 1))})`;
}

function qualifiedName(connection: ConnectionInfo, table: TableInfo): string {
  const name = quoteIdent(connection, table.name);
  return table.schema ? `${quoteIdent(connection, table.schema)}.${name}` : name;
}

/**
 * Build a copyable JSON string describing a table's structure/metadata.
 *
 * Structure only — never row data. Reuses the introspected `ColumnInfo`
 * (dataType, nullable, keys, default, PHI flag) returned by the schema API.
 */
export function buildTableMetadataJson(
  connection: ConnectionInfo,
  table: TableInfo,
  columns: ColumnInfo[],
): string {
  const metadata = {
    connection: connection.name,
    databaseType: connection.type,
    database: connection.database ?? null,
    schema: table.schema || null,
    table: table.name,
    type: table.type,
    columns: columns.map((c) => ({
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      isPrimaryKey: c.isPrimaryKey,
      isForeignKey: c.isForeignKey,
      references: c.references ?? null,
      defaultValue: c.defaultValue ?? null,
      isPhiField: c.isPhiField,
    })),
  };

  return JSON.stringify(metadata, null, 2);
}

/**
 * Build a best-effort `CREATE TABLE` statement for SQL engines.
 *
 * Introspection gives us name/type/nullable/PK/default/FK target but not column
 * length/precision, and an FK whose target is unknown (Mongo/ES, or a
 * permission-restricted catalogue) falls back to an inline comment. Meant as a
 * structure starting point, not a byte-exact schema dump.
 */
export function buildTableDdl(
  connection: ConnectionInfo,
  table: TableInfo,
  columns: ColumnInfo[],
): string {
  const q = (id: string) => quoteIdent(connection, id);
  const colLines = columns.map((c) => {
    let line = `  ${q(c.name)} ${c.dataType}`;
    if (!c.nullable) line += " NOT NULL";
    if (c.defaultValue != null && c.defaultValue !== "") line += ` DEFAULT ${c.defaultValue}`;
    const notes: string[] = [];
    const ref = c.references ? refClause(connection, c.references) : null;
    if (ref) line += ` REFERENCES ${ref}`;
    else if (c.isForeignKey) notes.push("FK");
    if (c.isPhiField) notes.push("PHI");
    return { line, notes };
  });

  const pkCols = columns.filter((c) => c.isPrimaryKey).map((c) => q(c.name));
  const bodyLines = colLines.map((c) => c.line);
  if (pkCols.length) bodyLines.push(`  PRIMARY KEY (${pkCols.join(", ")})`);

  // Join with commas first, then append per-column inline notes so the comment
  // sits after the comma and stays valid SQL.
  const rendered = bodyLines
    .map((line, i) => {
      const isLast = i === bodyLines.length - 1;
      const withComma = isLast ? line : `${line},`;
      const notes = colLines[i]?.notes ?? [];
      return notes.length ? `${withComma} -- ${notes.join(", ")}` : withComma;
    })
    .join("\n");

  return `CREATE TABLE ${qualifiedName(connection, table)} (\n${rendered}\n);`;
}

/**
 * Build a human-readable text block: one aligned line per column with
 * [PK, FK, NOT NULL, DEFAULT ..., PHI] flags.
 */
export function buildTableMetadataText(
  connection: ConnectionInfo,
  table: TableInfo,
  columns: ColumnInfo[],
): string {
  const header = `${table.schema ? `${table.schema}.` : ""}${table.name} (${table.type}) — ${connection.name}`;
  const nameWidth = columns.reduce((w, c) => Math.max(w, c.name.length), 0);
  const typeWidth = columns.reduce((w, c) => Math.max(w, c.dataType.length), 0);

  const lines = columns.map((c) => {
    const flags: string[] = [];
    if (c.isPrimaryKey) flags.push("PK");
    if (c.isForeignKey) flags.push(c.references ? `FK \u2192 ${c.references}` : "FK");
    if (!c.nullable) flags.push("NOT NULL");
    if (c.defaultValue != null && c.defaultValue !== "") flags.push(`DEFAULT ${c.defaultValue}`);
    if (c.isPhiField) flags.push("PHI");
    const flagStr = flags.length ? `  [${flags.join(", ")}]` : "";
    return `  ${c.name.padEnd(nameWidth)}  ${c.dataType.padEnd(typeWidth)}${flagStr}`;
  });

  return `${header}\n${lines.join("\n")}`;
}

/** Dispatch to the requested format. Returns the string + a short copy label. */
export function buildTableMetadata(
  format: MetadataFormat,
  connection: ConnectionInfo,
  table: TableInfo,
  columns: ColumnInfo[],
): { text: string; label: string } {
  switch (format) {
    case "ddl":
      return { text: buildTableDdl(connection, table, columns), label: "CREATE TABLE" };
    case "text":
      return { text: buildTableMetadataText(connection, table, columns), label: "metadata (text)" };
    case "json":
    default:
      return { text: buildTableMetadataJson(connection, table, columns), label: "metadata (JSON)" };
  }
}
