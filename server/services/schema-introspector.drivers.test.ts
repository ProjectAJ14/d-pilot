import { describe, it, expect, vi, beforeEach } from "vitest";
import type {
  ColumnInfo,
  ConnectionConfig,
  PhiFieldRule,
} from "../types/index.js";

// Every driver is faked: each records what it was asked and answers through a
// per-test handler, so no test reaches a real database or network.
const h = vi.hoisted(() => ({
  pg: (_sql: string, _params?: unknown[]): unknown[] => [],
  ms: (_sql: string, _inputs: Record<string, unknown>): unknown[] => [],
  pgCalls: [] as { sql: string; params?: unknown[] }[],
  msCalls: [] as { sql: string; inputs: Record<string, unknown> }[],
  pgPools: [] as unknown[],
  msConfigs: [] as Record<string, any>[],
  mongo: {
    uri: "",
    dbName: "",
    collections: [] as { name: string; type?: string }[],
    docs: {} as Record<string, unknown[] | Error>,
    closed: 0,
  },
  es: {
    opts: [] as Record<string, any>[],
    indices: [] as Record<string, string>[],
    mappings: {} as Record<string, unknown>,
  },
  ttlHours: 24,
  valuesOn: true,
  phi: new Set<string>(),
}));

vi.mock("pg", () => ({
  default: {
    Pool: class {
      constructor() {
        h.pgPools.push(this);
      }
      on() {
        return this;
      }
      async query(sql: string, params?: unknown[]) {
        h.pgCalls.push({ sql, params });
        return { rows: h.pg(sql, params) };
      }
      async end() {}
    },
  },
}));
vi.mock("mssql", () => ({
  default: {
    VarChar: "varchar",
    ConnectionPool: class {
      constructor(config: Record<string, any>) {
        h.msConfigs.push(config);
      }
      on() {
        return this;
      }
      async connect() {}
      async close() {}
      request() {
        const inputs: Record<string, unknown> = {};
        return {
          input(name: string, _t: unknown, value: unknown) {
            inputs[name] = value;
            return this;
          },
          async query(sql: string) {
            h.msCalls.push({ sql, inputs });
            return { recordset: h.ms(sql, inputs) };
          },
        };
      }
    },
  },
}));
vi.mock("mongodb", () => ({
  MongoClient: class {
    constructor(uri: string) {
      h.mongo.uri = uri;
    }
    async connect() {}
    async close() {
      h.mongo.closed++;
    }
    db(name: string) {
      h.mongo.dbName = name;
      return {
        listCollections: () => ({
          toArray: async () => h.mongo.collections,
        }),
        collection: (c: string) => ({
          find: () => ({
            limit: () => ({
              toArray: async () => {
                const d = h.mongo.docs[c];
                if (d instanceof Error) throw d;
                return d ?? [];
              },
            }),
          }),
        }),
      };
    }
  },
}));
vi.mock("@elastic/elasticsearch", () => ({
  Client: class {
    constructor(opts: Record<string, any>) {
      h.es.opts.push(opts);
    }
    cat = { indices: async () => h.es.indices };
    indices = {
      getMapping: async ({ index }: { index: string }) => {
        const m = h.es.mappings[index];
        if (m instanceof Error) throw m;
        return m ?? {};
      },
    };
  },
}));
vi.mock("./query-executor.js", () => ({
  mongoUri: (c: ConnectionConfig) => c.uri ?? `mongodb://${c.host}`,
  logDroppedConnections: (_c: unknown, pool: unknown) => pool,
}));
vi.mock("../config/settings.js", () => ({
  getConfigNumber: () => h.ttlHours,
}));
vi.mock("./sqlite-store.js", () => ({
  getAiColumnValuesEnabled: () => h.valuesOn,
}));
vi.mock("./phi-masking.js", () => ({
  findMatchingRule: (name: string) =>
    h.phi.has(name) ? ({ pattern: name } as PhiFieldRule) : null,
}));

const si = await import("./schema-introspector.js");
type FullSchema = import("./schema-introspector.js").FullSchema;

let seq = 0;
const conn = (over: Partial<ConnectionConfig>): ConnectionConfig =>
  ({
    id: `c${++seq}`,
    name: "c",
    env: "QA",
    type: "postgres",
    host: "db",
    database: "app_core",
    ...over,
  }) as ConnectionConfig;

beforeEach(() => {
  h.pg = () => [];
  h.ms = () => [];
  h.pgCalls = [];
  h.msCalls = [];
  h.pgPools = [];
  h.msConfigs = [];
  h.mongo = { uri: "", dbName: "", collections: [], docs: {}, closed: 0 };
  h.es = { opts: [], indices: [], mappings: {} };
  h.ttlHours = 24;
  h.valuesOn = true;
  h.phi = new Set();
});

describe("defaultSchema / resolveSchema", () => {
  it("falls back per engine and prefers a requested schema", () => {
    expect(si.defaultSchema(conn({ type: "postgres" }))).toBe("public");
    expect(si.defaultSchema(conn({ type: "mssql" }))).toBe("dbo");
    expect(si.defaultSchema(conn({ type: "mssql", schema: "sales" }))).toBe(
      "sales",
    );
    expect(si.defaultSchema(conn({ type: "mongodb" }))).toBe("");
    expect(
      si.defaultSchema(conn({ type: "elasticsearch", schema: "https" })),
    ).toBe("https");
    expect(si.resolveSchema(conn({}), "  app_core ")).toBe("app_core");
    expect(si.resolveSchema(conn({}), "   ")).toBe("public");
  });
});

describe("getSchemas", () => {
  it("returns nothing for document stores", async () => {
    expect(await si.getSchemas(conn({ type: "mongodb" }))).toEqual({
      schemas: [],
      default: "",
    });
  });

  it("intersects Postgres schemas with the allowlist and always shows the default", async () => {
    h.pg = () => [{ schema_name: "app_core" }, { schema_name: "staging" }];
    expect(
      await si.getSchemas(conn({ schemas: ["app_core", "missing"] })),
    ).toEqual({ schemas: ["public", "app_core"], default: "public" });
  });

  it("lists SQL Server schemas, keeping the default once", async () => {
    h.ms = () => [{ name: "dbo" }, { name: "sales" }];
    expect(await si.getSchemas(conn({ type: "mssql" }))).toEqual({
      schemas: ["dbo", "sales"],
      default: "dbo",
    });
  });
});

describe("introspection pools", () => {
  it("pins an MSSQL pool when asked, with defaults for host and port", () => {
    si.introspectMssqlPool(conn({ type: "mssql", host: undefined }), {
      max: 1,
    });
    si.introspectMssqlPool(conn({ type: "mssql", port: 1500 }));
    expect(h.msConfigs[0]).toMatchObject({
      server: "localhost",
      port: 1433,
      pool: { max: 1, min: 0 },
    });
    expect(h.msConfigs[1]).toMatchObject({ server: "db", port: 1500 });
    expect(h.msConfigs[1].pool).toBeUndefined();
  });
});

describe("getTables / getColumns per engine", () => {
  it("returns nothing for an unknown engine", async () => {
    const odd = conn({ type: "sqlite" as ConnectionConfig["type"] });
    expect(await si.getTables(odd)).toEqual([]);
    expect(await si.getColumns(odd, "orders")).toEqual([]);
  });

  it("lists Postgres tables and views in the resolved schema", async () => {
    h.pg = () => [
      { table_name: "orders", table_type: "BASE TABLE" },
      { table_name: "open_orders", table_type: "VIEW" },
    ];
    expect(await si.getTables(conn({}), "app_core")).toEqual([
      { schema: "app_core", name: "orders", type: "TABLE" },
      { schema: "app_core", name: "open_orders", type: "VIEW" },
    ]);
    expect(h.pgCalls[0].params).toEqual(["app_core"]);
  });

  it("reads Postgres columns with PK, FK (schema-qualified only across schemas) and PHI flags", async () => {
    h.phi.add("email");
    h.pg = (sql) =>
      sql.includes("FOREIGN KEY")
        ? [
            {
              table_name: "orders",
              column_name: "customer_id",
              ref_schema: "public",
              ref_table: "customers",
              ref_column: "id",
            },
            {
              table_name: "orders",
              column_name: "region_id",
              ref_schema: "geo",
              ref_table: "regions",
              ref_column: "id",
            },
          ]
        : [
            {
              column_name: "id",
              data_type: "integer",
              is_nullable: "NO",
              column_default: "nextval()",
              is_pk: true,
            },
            {
              column_name: "customer_id",
              data_type: "integer",
              is_nullable: "YES",
              column_default: null,
              is_pk: false,
            },
            {
              column_name: "region_id",
              data_type: "integer",
              is_nullable: "YES",
              column_default: null,
              is_pk: false,
            },
            {
              column_name: "email",
              data_type: "text",
              is_nullable: "YES",
              column_default: null,
              is_pk: false,
            },
          ];
    const cols = await si.getColumns(conn({}), "orders");
    expect(cols.map((c) => [c.name, c.isPrimaryKey, c.references])).toEqual([
      ["id", true, undefined],
      ["customer_id", false, "customers.id"],
      ["region_id", false, "geo.regions.id"],
      ["email", false, undefined],
    ]);
    expect(cols[0]).toMatchObject({
      nullable: false,
      defaultValue: "nextval()",
    });
    expect(cols[1].isForeignKey).toBe(true);
    expect(cols[3].isPhiField).toBe(true);
    expect(h.pgCalls.every((c) => c.params?.[0] === "public")).toBe(true);
  });

  it("lists SQL Server tables and columns with bound schema and table", async () => {
    h.ms = (sql) =>
      sql.includes("INFORMATION_SCHEMA.TABLES")
        ? [
            {
              TABLE_NAME: "orders",
              TABLE_TYPE: "BASE TABLE",
              TABLE_SCHEMA: "sales",
            },
            {
              TABLE_NAME: "open_orders",
              TABLE_TYPE: "VIEW",
              TABLE_SCHEMA: "sales",
            },
          ]
        : sql.includes("sys.foreign_key_columns")
          ? [
              {
                table_name: "orders",
                column_name: "customer_id",
                ref_schema: "",
                ref_table: "customers",
                ref_column: "id",
              },
            ]
          : [
              {
                COLUMN_NAME: "id",
                DATA_TYPE: "int",
                IS_NULLABLE: "NO",
                COLUMN_DEFAULT: null,
                is_pk: 1,
              },
              {
                COLUMN_NAME: "customer_id",
                DATA_TYPE: "int",
                IS_NULLABLE: "YES",
                COLUMN_DEFAULT: null,
                is_pk: 0,
              },
            ];
    const ms = conn({ type: "mssql" });
    expect(await si.getTables(ms, "sales")).toEqual([
      { schema: "sales", name: "orders", type: "TABLE" },
      { schema: "sales", name: "open_orders", type: "VIEW" },
    ]);
    const cols = await si.getColumns(ms, "orders", "sales");
    expect(cols.map((c) => [c.name, c.isPrimaryKey, c.references])).toEqual([
      ["id", true, undefined],
      ["customer_id", false, "customers.id"],
    ]);
    expect(cols[1]).toMatchObject({ nullable: true, isForeignKey: true });
    expect(h.msCalls[1].inputs).toEqual({ table: "orders", schema: "sales" });
  });

  it("lists Mongo collections from the configured database", async () => {
    h.mongo.collections = [
      { name: "orders", type: "collection" },
      { name: "open_orders", type: "view" },
    ];
    expect(await si.getTables(conn({ type: "mongodb" }))).toEqual([
      { schema: "app_core", name: "orders", type: "TABLE" },
      { schema: "app_core", name: "open_orders", type: "VIEW" },
    ]);
    expect(h.mongo.closed).toBe(1);
  });

  it("takes the Mongo database from the URI, else 'test'", async () => {
    await si.getTables(
      conn({
        type: "mongodb",
        database: undefined,
        uri: "mongodb://db:27017/customers?authSource=admin",
      }),
    );
    expect(h.mongo.dbName).toBe("customers");
    await si.getColumns(
      conn({ type: "mongodb", database: undefined, uri: undefined }),
      "orders",
    );
    expect(h.mongo.dbName).toBe("test");
  });

  it("infers Mongo fields from sampled documents, first type wins", async () => {
    h.phi.add("email");
    h.mongo.docs.orders = [
      { _id: "a", total: 3, email: "x" },
      { _id: "b", total: "3", status: "placed" },
    ];
    const cols = await si.getColumns(conn({ type: "mongodb" }), "orders");
    expect(cols.map((c) => [c.name, c.dataType, c.isPrimaryKey])).toEqual([
      ["_id", "string", true],
      ["total", "number", false],
      ["email", "string", false],
      ["status", "string", false],
    ]);
    expect(cols.find((c) => c.name === "email")!.isPhiField).toBe(true);
    expect(h.mongo.closed).toBe(1);
  });

  it("lists Elasticsearch indices sorted, hiding system ones", async () => {
    h.es.indices = [
      { index: "orders", "docs.count": "12" },
      { index: ".kibana" },
      { index: "customers" },
    ];
    expect(
      await si.getTables(
        conn({
          type: "elasticsearch",
          host: "es",
          username: "u",
          password: "p",
        }),
      ),
    ).toEqual([
      {
        schema: "elasticsearch",
        name: "customers",
        type: "INDEX",
        rowCount: 0,
      },
      { schema: "elasticsearch", name: "orders", type: "INDEX", rowCount: 12 },
    ]);
    expect(h.es.opts[0]).toMatchObject({
      node: "http://es:9200",
      auth: { username: "u", password: "p" },
    });
  });

  it("flattens nested Elasticsearch mappings into dotted fields", async () => {
    h.phi.add("customer.email");
    h.es.mappings.orders = {
      orders: {
        mappings: {
          properties: {
            status: { type: "keyword" },
            customer: {
              properties: {
                email: { type: "text" },
                tier: { type: "keyword" },
              },
            },
          },
        },
      },
    };
    const es = conn({
      type: "elasticsearch",
      schema: "https",
      port: 9300,
      username: "u",
    });
    const cols = await si.getColumns(es, "orders");
    expect(cols.map((c) => [c.name, c.dataType, c.isPhiField])).toEqual([
      ["status", "keyword", false],
      ["customer", "object", false],
      ["customer.email", "text", true],
      ["customer.tier", "keyword", false],
    ]);
    expect(h.es.opts[0]).toMatchObject({ node: "https://db:9300" });
    expect(h.es.opts[0].auth).toBeUndefined();

    // An index with no mapping yields no fields; a uri wins over host/port.
    expect(
      await si.getColumns(
        conn({ type: "elasticsearch", uri: "http://es.local" }),
        "customers",
      ),
    ).toEqual([]);
    expect(h.es.opts[1].node).toBe("http://es.local");
  });
});

describe("summarizeTables / tableCatalog / formatTable", () => {
  const c = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
    name,
    dataType: "integer",
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
    isPhiField: false,
    ...extra,
  });
  const full: FullSchema = {
    tables: [
      { name: "orders", type: "TABLE" },
      { name: "open_orders", type: "VIEW" },
      { name: "customers", type: "" },
    ],
    columns: {
      orders: [c("id"), c("customer_id"), c("status")],
      open_orders: [c("id")],
    },
  };

  it("renders only the requested known tables, once each", () => {
    const s = si.summarizeTables(full, ["customers", "nope", "customers"]);
    expect(s).toMatchObject({
      totalTables: 3,
      includedTables: 1,
      truncated: true,
      tableNames: ["customers"],
    });
    expect(s.text).toBe("customers\n");
  });

  it("caps the table count when no list is given", () => {
    const s = si.summarizeTables(full, [], 2);
    expect(s.tableNames).toEqual(["orders", "open_orders"]);
    expect(s.text).toContain("open_orders (view)");
  });

  it("builds a compact catalog with a column cap and view labels", () => {
    expect(si.tableCatalog(full, 2)).toBe(
      [
        "orders: id, customer_id, +1 more",
        "open_orders (view): id",
        "customers: ",
      ].join("\n"),
    );
    expect(si.tableCatalog(full).split("\n")[0]).toBe(
      "orders: id, customer_id, status",
    );
  });

  it("flags FK without a target, PHI, and elides columns past the cap", () => {
    const text = si.formatTable(
      "orders",
      "VIEW",
      [
        c("ref", { isForeignKey: true }),
        c("email", { isPhiField: true, nullable: false }),
        c("plain"),
        c("extra"),
      ],
      false,
      3,
    );
    expect(text).toBe(
      [
        "orders (view)",
        "  - ref: integer [FK]",
        "  - email: integer [NOT NULL, PHI]",
        "  - plain: integer",
        "  - ...(1 more columns)",
      ].join("\n"),
    );
  });
});

describe("value helpers", () => {
  it("drops pg_stats values that would break the prompt", () => {
    const full: FullSchema = {
      tables: [{ name: "orders", type: "TABLE" }],
      columns: {
        orders: [
          {
            name: "status",
            dataType: "text",
            nullable: true,
            isPrimaryKey: false,
            isForeignKey: false,
            isPhiField: false,
          },
        ],
      },
    };
    si.applyPgStatsValues(full, "app_core", [
      { tablename: "orders", attname: "status", n_distinct: 1, vals: ["a|b"] },
      { tablename: "orders", attname: "status", n_distinct: 1, vals: null },
    ]);
    expect(full.columns.orders[0].values).toBeUndefined();
  });

  it("skips a table with no column list while sampling", async () => {
    const run = vi.fn(async () => ["x"]);
    await si.sampleColumnValues(
      { tables: [{ name: "orders", type: "TABLE" }], columns: {} },
      "app_core",
      new Map([["orders", 1]]),
      run,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("full-schema introspection", () => {
  it("builds a Postgres schema with PKs, FKs, views and pg_stats values", async () => {
    h.pg = (sql) => {
      if (sql.includes("pg_stats"))
        return [
          {
            tablename: "orders",
            attname: "status",
            n_distinct: 2,
            vals: ["placed", "draft"],
          },
        ];
      if (sql.includes("FOREIGN KEY"))
        return [
          {
            table_name: "orders",
            column_name: "customer_id",
            ref_schema: "app_core",
            ref_table: "customers",
            ref_column: "id",
          },
        ];
      if (sql.includes("PRIMARY KEY"))
        return [{ table_name: "orders", column_name: "id" }];
      if (sql.includes("information_schema.columns"))
        return [
          {
            table_name: "orders",
            column_name: "id",
            data_type: "integer",
            is_nullable: "NO",
          },
          {
            table_name: "orders",
            column_name: "customer_id",
            data_type: "integer",
            is_nullable: "YES",
          },
          {
            table_name: "orders",
            column_name: "status",
            data_type: "text",
            is_nullable: "YES",
          },
        ];
      return [
        { table_name: "orders", table_type: "BASE TABLE" },
        { table_name: "open_orders", table_type: "VIEW" },
      ];
    };
    const { schema } = await si.getCachedFullSchema(
      conn({ schema: "app_core" }),
    );
    expect(schema.tables).toEqual([
      { name: "orders", type: "TABLE" },
      { name: "open_orders", type: "VIEW" },
    ]);
    expect(
      schema.columns.orders.map((c) => [c.name, c.isPrimaryKey, c.references]),
    ).toEqual([
      ["id", true, undefined],
      ["customer_id", false, "customers.id"],
      ["status", false, undefined],
    ]);
    expect(schema.columns.orders[2].values).toEqual(["draft", "placed"]);
  });

  it("builds a SQL Server schema and samples values with quoted identifiers", async () => {
    h.ms = (sql) => {
      if (sql.includes("INFORMATION_SCHEMA.TABLES"))
        return [
          { TABLE_NAME: "orders]x", TABLE_TYPE: "BASE TABLE" },
          { TABLE_NAME: "open_orders", TABLE_TYPE: "VIEW" },
        ];
      if (sql.includes("INFORMATION_SCHEMA.COLUMNS"))
        return [
          {
            TABLE_NAME: "orders]x",
            COLUMN_NAME: "id",
            DATA_TYPE: "int",
            IS_NULLABLE: "NO",
          },
          {
            TABLE_NAME: "orders]x",
            COLUMN_NAME: "status",
            DATA_TYPE: "varchar",
            IS_NULLABLE: "YES",
          },
        ];
      if (sql.includes("PRIMARY KEY"))
        return [{ TABLE_NAME: "orders]x", COLUMN_NAME: "id" }];
      if (sql.includes("sys.partitions"))
        return [{ table_name: "orders]x", row_count: "3" }];
      if (sql.includes("SELECT DISTINCT"))
        return [{ v: "placed" }, { v: "draft" }];
      return [];
    };
    const { schema } = await si.getCachedFullSchema(
      conn({ type: "mssql", schema: "sales" }),
    );
    expect(schema.tables[1]).toEqual({ name: "open_orders", type: "VIEW" });
    expect(schema.columns["orders]x"][0].isPrimaryKey).toBe(true);
    expect(schema.columns["orders]x"][1].values).toEqual(["draft", "placed"]);
    expect(h.msCalls.find((c) => c.sql.includes("DISTINCT"))!.sql).toBe(
      "SELECT DISTINCT TOP 21 [status] AS v FROM [sales].[orders]]x]",
    );
  });

  it("samples Mongo collections one by one, an unreadable one yielding no columns", async () => {
    h.mongo.collections = [{ name: "orders" }, { name: "broken" }];
    h.mongo.docs.orders = [{ _id: 1 }];
    h.mongo.docs.broken = new Error("not authorized");
    const { schema } = await si.getCachedFullSchema(conn({ type: "mongodb" }));
    expect(schema.tables).toEqual([
      { name: "orders", type: "TABLE" },
      { name: "broken", type: "TABLE" },
    ]);
    expect(schema.columns.orders.map((c) => c.name)).toEqual(["_id"]);
    expect(schema.columns.broken).toEqual([]);
  });
});

describe("schema cache", () => {
  const tables = () => [{ table_name: "orders", table_type: "BASE TABLE" }];

  it("serves a fresh hit from cache and shares one in-flight introspection", async () => {
    h.pg = (sql) => (sql.includes("information_schema.tables") ? tables() : []);
    const c = conn({});
    const [a, b] = await Promise.all([
      si.getCachedFullSchema(c),
      si.getCachedFullSchema(c),
    ]);
    expect(a.schema).toBe(b.schema);
    expect(h.pgPools).toHaveLength(1);
    expect(a).toMatchObject({ cached: false, ttlHours: 24 });

    const hit = await si.getCachedFullSchema(c);
    expect(hit.cached).toBe(true);
    expect(hit.cachedAt).toBe(a.cachedAt);
    expect(h.pgPools).toHaveLength(1);
  });

  it("caches nothing when the TTL is zero", async () => {
    h.ttlHours = 0;
    const c = conn({});
    await si.getCachedFullSchema(c);
    expect((await si.getCachedFullSchema(c)).cached).toBe(false);
    expect(h.pgPools).toHaveLength(2);
  });

  it("peeks: undefined (and warms) when cold, the schema when warm", async () => {
    h.pg = (sql) =>
      sql.includes("information_schema.tables")
        ? tables()
        : sql.includes("FOREIGN KEY")
          ? [
              {
                table_name: "orders",
                column_name: "customer_id",
                ref_schema: "public",
                ref_table: "customers",
                ref_column: "id",
              },
            ]
          : sql.includes("information_schema.columns")
            ? [
                {
                  table_name: "orders",
                  column_name: "customer_id",
                  data_type: "integer",
                  is_nullable: "YES",
                },
              ]
            : [];
    const c = conn({});
    const sql = "SELECT customer_id FROM (SELECT 1) x JOIN orders o ON true";
    expect(si.fkTargetsForColumns(c, sql, ["customer_id"]).size).toBe(0);
    await vi.waitFor(() => expect(si.peekCachedFullSchema(c)).toBeDefined());
    expect(si.fkTargetsForColumns(c, sql, ["customer_id"])).toEqual(
      new Map([["customer_id", "customers.id"]]),
    );
  });

  it("clears one connection's schemas, or everything", async () => {
    const a = conn({});
    const b = conn({});
    await si.getCachedFullSchema(a);
    await si.getCachedFullSchema(a, { schema: "app_core" });
    await si.getCachedFullSchema(b);
    expect(si.clearSchemaCache(a.id)).toEqual({ cleared: 2 });
    expect(si.clearSchemaCache(a.id)).toEqual({ cleared: 0 });
    expect((await si.getCachedFullSchema(b)).cached).toBe(true);

    // A full clear also drops in-flight introspections: a new caller starts over.
    const pending = si.getCachedFullSchema(a);
    expect(si.clearSchemaCache().cleared).toBeGreaterThanOrEqual(1);
    await pending;
    expect((await si.getCachedFullSchema(b)).cached).toBe(false);
  });
});

describe("remaining fallbacks", () => {
  it("lists Mongo collections of 'test' with no database configured", async () => {
    await si.getTables(conn({ type: "mongodb", database: undefined }));
    expect(h.mongo.dbName).toBe("test");
  });

  it("connects to Elasticsearch anonymously on the default port, or with credentials", async () => {
    await si.getTables(conn({ type: "elasticsearch" }));
    await si.getColumns(
      conn({ type: "elasticsearch", username: "u", password: "p" }),
      "orders",
    );
    expect(h.es.opts[0]).toMatchObject({ node: "http://db:9200" });
    expect(h.es.opts[0].auth).toBeUndefined();
    expect(h.es.opts[1]).toMatchObject({
      node: "http://db:9200",
      auth: { username: "u", password: "p" },
    });
  });

  it("swallows a failed background warm-up from a peek", async () => {
    h.pg = () => {
      throw new Error("connection refused");
    };
    const c = conn({});
    expect(si.peekCachedFullSchema(c)).toBeUndefined();
    await expect(si.getCachedFullSchema(c)).rejects.toThrow(
      "connection refused",
    );
    expect(si.peekCachedFullSchema(c)).toBeUndefined();
  });

  it("keeps another connection's in-flight introspection on a targeted clear", async () => {
    const c = conn({});
    const first = si.getCachedFullSchema(c);
    si.clearSchemaCache("someone-else");
    // Not dropped by the clear, so a second caller still joins it.
    const second = si.getCachedFullSchema(c);
    const [a, b] = await Promise.all([first, second]);
    expect(a.schema).toBe(b.schema);
    expect(h.pgPools).toHaveLength(1);
  });
});
