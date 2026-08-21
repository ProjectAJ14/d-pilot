import { describe, it, expect } from "vitest";
import { buildTableDdl, buildTableMetadataText } from "./schema-metadata";
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
