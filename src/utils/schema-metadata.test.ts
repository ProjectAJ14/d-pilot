import { describe, it, expect } from "vitest";
import {
  buildTableDdl,
  buildTableMetadata,
  buildTableMetadataText,
  supportsDdl,
} from "./schema-metadata";
import type { ColumnInfo, ConnectionInfo, TableInfo } from "../types";

const conn = { id: "c1", name: "core", type: "postgres" } as ConnectionInfo;
const table = { schema: "public", name: "orders", type: "TABLE" } as TableInfo;

const col = (over: Partial<ColumnInfo>): ColumnInfo => ({
  name: "id",
  dataType: "integer",
  nullable: false,
  isPrimaryKey: false,
  isForeignKey: false,
  isPhiField: false,
  ...over,
});

describe("foreign keys in table metadata", () => {
  it("renders a REFERENCES clause when the FK target is known", () => {
    const ddl = buildTableDdl(conn, table, [
      col({ name: "id", isPrimaryKey: true }),
      col({
        name: "customer_id",
        isForeignKey: true,
        references: "customers.id",
      }),
    ]);
    expect(ddl).toContain(
      '"customer_id" integer NOT NULL REFERENCES "customers"("id")',
    );
  });

  it("qualifies a cross-schema FK target and falls back to a comment without one", () => {
    const ddl = buildTableDdl(conn, table, [
      col({
        name: "region_id",
        isForeignKey: true,
        references: "geo.regions.id",
      }),
      col({ name: "legacy_id", isForeignKey: true }),
    ]);
    expect(ddl).toContain('REFERENCES "geo"."regions"("id")');
    expect(ddl).toContain("-- FK");
  });

  it("shows the FK target in the text flags", () => {
    const text = buildTableMetadataText(conn, table, [
      col({
        name: "customer_id",
        isForeignKey: true,
        references: "customers.id",
      }),
    ]);
    expect(text).toContain("FK → customers.id");
  });
});

describe("table metadata formats", () => {
  const mssql = { ...conn, type: "mssql" } as ConnectionInfo;
  const mongo = { ...conn, type: "mongodb" } as ConnectionInfo;
  const noSchema = { name: "orders", type: "TABLE" } as TableInfo;
  const cols = [
    col({ name: "id", isPrimaryKey: true, defaultValue: "1" }),
    col({ name: "email", dataType: "text", nullable: true, isPhiField: true }),
    col({ name: "note", dataType: "text", nullable: true, defaultValue: "" }),
  ];

  it("supportsDdl is true only for SQL engines", () => {
    expect(supportsDdl(conn)).toBe(true);
    expect(supportsDdl(mssql)).toBe(true);
    expect(supportsDdl(mongo)).toBe(false);
  });

  it("DDL quotes per dialect, adds defaults, PK and PHI notes", () => {
    expect(buildTableDdl(mssql, noSchema, cols)).toBe(
      [
        "CREATE TABLE [orders] (",
        "  [id] integer NOT NULL DEFAULT 1,",
        "  [email] text, -- PHI",
        "  [note] text,",
        "  PRIMARY KEY ([id])",
        ");",
      ].join("\n"),
    );
  });

  it("DDL without a PK ends on the last column, notes after it", () => {
    expect(
      buildTableDdl(conn, table, [col({ name: "x", isPhiField: true })]),
    ).toBe(
      'CREATE TABLE "public"."orders" (\n  "x" integer NOT NULL -- PHI\n);',
    );
  });

  it("an FK target without a column part becomes a comment", () => {
    const ddl = buildTableDdl(conn, table, [
      col({ name: "r", isForeignKey: true, references: "regions" }),
    ]);
    expect(ddl).not.toContain("REFERENCES");
    expect(ddl).toContain("-- FK");
  });

  it("text aligns columns and lists every flag", () => {
    expect(
      buildTableMetadataText(conn, noSchema, [
        ...cols,
        col({ name: "fk", isForeignKey: true }),
      ]),
    ).toBe(
      [
        "orders (TABLE) — core",
        "  id     integer  [PK, NOT NULL, DEFAULT 1]",
        "  email  text     [PHI]",
        "  note   text   ",
        "  fk     integer  [FK, NOT NULL]",
      ].join("\n"),
    );
  });

  it("dispatches each format with its copy label; JSON is the default", () => {
    expect(buildTableMetadata("ddl", conn, table, cols).label).toBe(
      "CREATE TABLE",
    );
    expect(buildTableMetadata("text", conn, table, cols).label).toBe(
      "metadata (text)",
    );
    const json = buildTableMetadata("json", conn, noSchema, [
      col({ references: "a.b", defaultValue: "0" }),
      col({ name: "y" }),
    ]);
    expect(json.label).toBe("metadata (JSON)");
    const parsed = JSON.parse(json.text);
    expect(parsed).toMatchObject({
      connection: "core",
      databaseType: "postgres",
      database: null,
      schema: null,
      table: "orders",
    });
    expect(parsed.columns[0]).toMatchObject({
      references: "a.b",
      defaultValue: "0",
    });
    expect(parsed.columns[1]).toMatchObject({
      references: null,
      defaultValue: null,
    });
    expect(
      JSON.parse(
        buildTableMetadata(
          "other" as never,
          { ...conn, database: "app" } as ConnectionInfo,
          table,
          [],
        ).text,
      ),
    ).toMatchObject({ database: "app", schema: "public" });
  });
});
