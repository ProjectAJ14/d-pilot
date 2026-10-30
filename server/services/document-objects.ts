import type {
  ConnectionConfig,
  DbObjectDefinition,
  DbObjectKind,
} from "../types/index.js";
import { getEsClient, getMongoClient } from "./query-executor.js";

/**
 * The objects MongoDB and Elasticsearch keep beside their data — the parts of
 * their "schema" that are code or configuration. Read-only: definitions are
 * JSON, so they can be browsed, compared across connections and copied, but
 * not changed through an object_change.
 */

export const MONGO_OBJECT_KINDS: DbObjectKind[] = [
  "view",
  "index",
  "validator",
];
export const ES_OBJECT_KINDS: DbObjectKind[] = [
  "index_template",
  "ingest_pipeline",
  "alias",
  "ilm_policy",
];

const json = (v: unknown) => JSON.stringify(v, null, 2);
const byName = (a: DbObjectDefinition, b: DbObjectDefinition) =>
  a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind);

export async function getDocumentObjects(
  conn: ConnectionConfig,
): Promise<DbObjectDefinition[]> {
  if (conn.type === "mongodb") return getMongoObjects(conn);
  if (conn.type === "elasticsearch") return getEsObjects(conn);
  return [];
}

const mongoDbName = (conn: ConnectionConfig) =>
  conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";

/**
 * Views (`viewOn` + pipeline), validation rules (one per collection that has
 * one) and indexes (all but the implicit `_id_`, keyed by their collection).
 */
async function getMongoObjects(
  conn: ConnectionConfig,
): Promise<DbObjectDefinition[]> {
  const dbName = mongoDbName(conn);
  const db = (await getMongoClient(conn)).db(dbName);
  const collections = await db.listCollections().toArray();
  const out: DbObjectDefinition[] = [];
  const base = { schema: dbName };

  for (const c of collections as any[]) {
    if (c.name.startsWith("system.")) continue;
    if (c.type === "view") {
      out.push({
        ...base,
        name: c.name,
        kind: "view",
        definition: json({
          viewOn: c.options?.viewOn,
          pipeline: c.options?.pipeline ?? [],
        }),
      });
    } else if (c.options?.validator) {
      out.push({
        ...base,
        name: c.name,
        kind: "validator",
        definition: json({
          validator: c.options.validator,
          validationLevel: c.options.validationLevel ?? "strict",
          validationAction: c.options.validationAction ?? "error",
        }),
      });
    }
  }

  const indexed = (collections as any[]).filter(
    (c) => c.type !== "view" && !c.name.startsWith("system."),
  );
  const lists = await Promise.all(
    indexed.map((c) => db.collection(c.name).listIndexes().toArray()),
  );
  indexed.forEach((c, i) => {
    for (const { v: _v, ns: _ns, ...spec } of lists[i] as any[]) {
      if (spec.name === "_id_") continue;
      out.push({
        ...base,
        name: spec.name,
        kind: "index",
        parent: c.name,
        definition: json(spec),
      });
    }
  });
  return out.sort(byName);
}

/** Elastic's own templates, pipelines and policies are marked `_meta.managed`. */
const isManaged = (name: string, def: any) =>
  name.startsWith(".") || def?._meta?.managed === true;

async function getEsObjects(
  conn: ConnectionConfig,
): Promise<DbObjectDefinition[]> {
  const client = getEsClient(conn);
  // ILM is not in every distribution (OpenSearch, some managed services):
  // a missing API leaves its kind empty rather than failing the list.
  const optional = <T>(p: Promise<T>) => p.catch(() => null);
  const [templates, pipelines, aliases, policies] = await Promise.all([
    client.indices.getIndexTemplate(),
    optional(client.ingest.getPipeline()),
    client.indices.getAlias(),
    optional(client.ilm.getLifecycle()),
  ]);
  const base = { schema: "" };
  const out: DbObjectDefinition[] = [];

  for (const t of (templates as any).index_templates ?? [])
    if (!isManaged(t.name, t.index_template))
      out.push({
        ...base,
        name: t.name,
        kind: "index_template",
        definition: json(t.index_template),
      });

  for (const [name, def] of Object.entries((pipelines as any) ?? {}))
    if (!isManaged(name, def))
      out.push({
        ...base,
        name,
        kind: "ingest_pipeline",
        definition: json(def),
      });

  // getAlias answers per index; an alias is listed once with its indices.
  const byAlias = new Map<string, Record<string, unknown>>();
  for (const [index, { aliases: a }] of Object.entries(
    aliases as Record<string, { aliases?: object }>,
  )) {
    if (index.startsWith(".")) continue;
    for (const [alias, props] of Object.entries((a as object) ?? {}))
      byAlias.set(alias, { ...byAlias.get(alias), [index]: props });
  }
  for (const [name, indices] of byAlias)
    out.push({ ...base, name, kind: "alias", definition: json({ indices }) });

  for (const [name, def] of Object.entries((policies as any) ?? {}))
    if (!isManaged(name, (def as any).policy))
      out.push({
        ...base,
        name,
        kind: "ilm_policy",
        definition: json((def as any).policy),
      });

  return out.sort(byName);
}
