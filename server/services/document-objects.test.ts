import { describe, it, expect, vi } from "vitest";
import type { ConnectionConfig } from "../types/index.js";

const h = vi.hoisted(() => ({ mongo: null as any, es: null as any }));
vi.mock("./query-executor.js", () => ({
  getMongoClient: async () => h.mongo,
  getEsClient: () => h.es,
}));

const { getDocumentObjects } = await import("./document-objects.js");

const toArray = (v: unknown) => ({ toArray: async () => v });

describe("MongoDB objects", () => {
  it("lists views, validation rules and indexes — not _id_ or system collections", async () => {
    h.mongo = {
      db: () => ({
        listCollections: () =>
          toArray([
            {
              name: "orders",
              type: "collection",
              options: { validator: { $jsonSchema: { required: ["status"] } } },
            },
            {
              name: "open_orders",
              type: "view",
              options: {
                viewOn: "orders",
                pipeline: [{ $match: { status: "placed" } }],
              },
            },
            { name: "system.profile", type: "collection", options: {} },
          ]),
        collection: (name: string) => ({
          listIndexes: () =>
            toArray(
              name === "orders"
                ? [
                    { v: 2, key: { _id: 1 }, name: "_id_" },
                    {
                      v: 2,
                      key: { status: 1, due_date: -1 },
                      name: "status_due",
                      ns: "app_core.orders",
                    },
                  ]
                : [],
            ),
        }),
      }),
    };
    const objects = await getDocumentObjects({
      id: "m",
      type: "mongodb",
      env: "QA",
      database: "app_core",
    } as ConnectionConfig);
    expect(objects.map((o) => [o.kind, o.name, o.parent])).toEqual([
      ["view", "open_orders", undefined],
      ["validator", "orders", undefined],
      ["index", "status_due", "orders"],
    ]);
    expect(JSON.parse(objects[2].definition!)).toEqual({
      key: { status: 1, due_date: -1 },
      name: "status_due",
    });
    expect(JSON.parse(objects[1].definition!)).toMatchObject({
      validationLevel: "strict",
      validationAction: "error",
    });
  });
});

describe("Elasticsearch objects", () => {
  it("skips Elastic's managed and dot-named objects, groups aliases, and survives a missing ILM API", async () => {
    h.es = {
      indices: {
        getIndexTemplate: async () => ({
          index_templates: [
            {
              name: "orders",
              index_template: { index_patterns: ["orders-*"] },
            },
            { name: "logs", index_template: { _meta: { managed: true } } },
          ],
        }),
        getAlias: async () => ({
          "orders-2026.10": { aliases: { orders: { is_write_index: true } } },
          "orders-2026.09": { aliases: { orders: {} } },
          ".kibana_1": { aliases: { ".kibana": {} } },
        }),
      },
      ingest: {
        getPipeline: async () => ({
          "orders-enrich": { processors: [] },
          "logs@json": { _meta: { managed: true } },
        }),
      },
      ilm: {
        getLifecycle: async () => {
          throw new Error("no handler found for uri [/_ilm/policy]");
        },
      },
    };
    const objects = await getDocumentObjects({
      id: "e",
      type: "elasticsearch",
      env: "QA",
    } as ConnectionConfig);
    expect(objects.map((o) => [o.kind, o.name])).toEqual([
      ["alias", "orders"],
      ["index_template", "orders"],
      ["ingest_pipeline", "orders-enrich"],
    ]);
    expect(JSON.parse(objects[0].definition!)).toEqual({
      indices: {
        "orders-2026.10": { is_write_index: true },
        "orders-2026.09": {},
      },
    });
  });
});

describe("other engines and edge cases", () => {
  it("has no document objects for a SQL engine", async () => {
    h.mongo = h.es = null;
    expect(
      await getDocumentObjects({
        id: "p",
        type: "postgres",
        env: "QA",
      } as ConnectionConfig),
    ).toEqual([]);
  });

  it("names the Mongo database from the URI (else 'test'), defaults a view's pipeline and skips a plain collection", async () => {
    const dbNames: string[] = [];
    h.mongo = {
      db: (name: string) => {
        dbNames.push(name);
        return {
          listCollections: () =>
            toArray([
              {
                name: "open_orders",
                type: "view",
                options: { viewOn: "orders" },
              },
              { name: "customers", type: "collection" },
              {
                name: "orders",
                type: "collection",
                options: {
                  validator: { status: { $exists: true } },
                  validationLevel: "moderate",
                  validationAction: "warn",
                },
              },
            ]),
          collection: () => ({ listIndexes: () => toArray([]) }),
        };
      },
    };
    const objects = await getDocumentObjects({
      id: "m",
      type: "mongodb",
      env: "QA",
      uri: "mongodb://db:27017/app_core?authSource=admin",
    } as ConnectionConfig);
    expect(objects.map((o) => [o.kind, o.name])).toEqual([
      ["view", "open_orders"],
      ["validator", "orders"],
    ]);
    expect(objects[0].schema).toBe("app_core");
    expect(JSON.parse(objects[0].definition!)).toEqual({
      viewOn: "orders",
      pipeline: [],
    });
    expect(JSON.parse(objects[1].definition!)).toMatchObject({
      validationLevel: "moderate",
      validationAction: "warn",
    });

    await getDocumentObjects({
      id: "m2",
      type: "mongodb",
      env: "QA",
    } as ConnectionConfig);
    expect(dbNames).toEqual(["app_core", "test"]);
  });

  it("lists user ILM policies, survives a missing ingest API and indices without aliases", async () => {
    h.es = {
      indices: {
        getIndexTemplate: async () => ({}),
        getAlias: async () => ({ "orders-2026.10": {} }),
      },
      ingest: {
        getPipeline: async () => {
          throw new Error("no ingest");
        },
      },
      ilm: {
        getLifecycle: async () => ({
          "orders-retention": { policy: { phases: { delete: {} } } },
          ".internal": { policy: {} },
          "logs-default": { policy: { _meta: { managed: true } } },
        }),
      },
    };
    const objects = await getDocumentObjects({
      id: "e",
      type: "elasticsearch",
      env: "QA",
    } as ConnectionConfig);
    expect(objects).toEqual([
      {
        schema: "",
        name: "orders-retention",
        kind: "ilm_policy",
        definition: JSON.stringify({ phases: { delete: {} } }, null, 2),
      },
    ]);
  });
});
