import pg from "pg";
import mssql from "mssql";
import { MongoClient } from "mongodb";
import { Client as EsClient } from "@elastic/elasticsearch";
import type { ConnectionConfig, TableInfo, ColumnInfo } from "../types/index.js";
import { findMatchingRule } from "./phi-masking.js";

export async function getTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresTables(conn);
    case "mssql":
      return getMssqlTables(conn);
    case "mongodb":
      return getMongoCollections(conn);
    case "elasticsearch":
      return getEsIndices(conn);
    default:
      return [];
  }
}

export async function getColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  switch (conn.type) {
    case "postgres":
      return getPostgresColumns(conn, tableName);
    case "mssql":
      return getMssqlColumns(conn, tableName);
    case "mongodb":
      return getMongoFields(conn, tableName);
    case "elasticsearch":
      return getEsFields(conn, tableName);
    default:
      return [];
  }
}

// --- PostgreSQL ---

async function getPostgresTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
  });

  try {
    const schema = conn.schema || "public";
    const result = await pool.query(
      `SELECT table_name, table_type
       FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema]
    );

    return result.rows.map((r) => ({
      schema,
      name: r.table_name,
      type: r.table_type === "VIEW" ? "VIEW" : "TABLE",
    }));
  } finally {
    await pool.end();
  }
}

async function getPostgresColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  const pool = new pg.Pool({
    host: conn.host,
    port: conn.port || 5432,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    max: 2,
  });

  try {
    const schema = conn.schema || "public";

    const colResult = await pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_pk,
              CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_fk
       FROM information_schema.columns c
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
       ) pk ON c.column_name = pk.column_name
       LEFT JOIN (
         SELECT ku.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
       ) fk ON c.column_name = fk.column_name
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, tableName]
    );

    return colResult.rows.map((r) => ({
      name: r.column_name,
      dataType: r.data_type,
      nullable: r.is_nullable === "YES",
      isPrimaryKey: r.is_pk,
      isForeignKey: r.is_fk,
      defaultValue: r.column_default,
      isPhiField: !!findMatchingRule(r.column_name, conn.database, tableName),
    }));
  } finally {
    await pool.end();
  }
}

// --- SQL Server ---

async function getMssqlTables(conn: ConnectionConfig): Promise<TableInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
  });

  try {
    await pool.connect();
    const result = await pool.request().query(
      `SELECT TABLE_NAME, TABLE_TYPE, TABLE_SCHEMA
       FROM INFORMATION_SCHEMA.TABLES
       ORDER BY TABLE_NAME`
    );

    return result.recordset.map((r: any) => ({
      schema: r.TABLE_SCHEMA,
      name: r.TABLE_NAME,
      type: r.TABLE_TYPE === "VIEW" ? "VIEW" : "TABLE",
    }));
  } finally {
    await pool.close();
  }
}

async function getMssqlColumns(conn: ConnectionConfig, tableName: string): Promise<ColumnInfo[]> {
  const pool = new mssql.ConnectionPool({
    server: conn.host || "localhost",
    port: conn.port || 1433,
    database: conn.database,
    user: conn.username,
    password: conn.password,
    options: { encrypt: false, trustServerCertificate: true },
  });

  try {
    await pool.connect();
    const result = await pool.request().input("table", mssql.VarChar, tableName).query(
      `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_pk,
              CASE WHEN fk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END as is_fk
       FROM INFORMATION_SCHEMA.COLUMNS c
       LEFT JOIN (
         SELECT ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
         WHERE tc.TABLE_NAME = @table AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
       ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
       LEFT JOIN (
         SELECT ku.COLUMN_NAME
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
         WHERE tc.TABLE_NAME = @table AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
       ) fk ON c.COLUMN_NAME = fk.COLUMN_NAME
       WHERE c.TABLE_NAME = @table
       ORDER BY c.ORDINAL_POSITION`
    );

    return result.recordset.map((r: any) => ({
      name: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      nullable: r.IS_NULLABLE === "YES",
      isPrimaryKey: !!r.is_pk,
      isForeignKey: !!r.is_fk,
      defaultValue: r.COLUMN_DEFAULT,
      isPhiField: !!findMatchingRule(r.COLUMN_NAME, conn.database, tableName),
    }));
  } finally {
    await pool.close();
  }
}

// --- MongoDB ---

async function getMongoCollections(conn: ConnectionConfig): Promise<TableInfo[]> {
  const uri = conn.uri || `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const dbName = conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
    const db = client.db(dbName);
    const collections = await db.listCollections().toArray();

    return collections.map((c) => ({
      schema: dbName,
      name: c.name,
      type: c.type === "view" ? "VIEW" : "TABLE",
    }));
  } finally {
    await client.close();
  }
}

async function getMongoFields(conn: ConnectionConfig, collectionName: string): Promise<ColumnInfo[]> {
  const uri = conn.uri || `mongodb://${conn.username}:${conn.password}@${conn.host}:${conn.port || 27017}/${conn.database}`;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000 });

  try {
    await client.connect();
    const dbName = conn.database || conn.uri?.split("/").pop()?.split("?")[0] || "test";
    const db = client.db(dbName);

    // Sample documents to infer fields
    const sample = await db.collection(collectionName).find({}).limit(100).toArray();
    const fieldMap = new Map<string, string>();

    for (const doc of sample) {
      for (const [key, value] of Object.entries(doc)) {
        if (!fieldMap.has(key)) {
          fieldMap.set(key, typeof value);
        }
      }
    }

    return Array.from(fieldMap.entries()).map(([name, type]) => ({
      name,
      dataType: type,
      nullable: true,
      isPrimaryKey: name === "_id",
      isForeignKey: false,
      isPhiField: !!findMatchingRule(name, conn.database, collectionName),
    }));
  } finally {
    await client.close();
  }
}

// --- Elasticsearch ---

async function getEsIndices(conn: ConnectionConfig): Promise<TableInfo[]> {
  const protocol = conn.schema || "http";
  const node = conn.uri || `${protocol}://${conn.host}:${conn.port || 9200}`;
  const client = new EsClient({
    node,
    auth: conn.username && conn.password ? { username: conn.username, password: conn.password } : undefined,
    tls: { rejectUnauthorized: false },
    requestTimeout: 10000,
  });

  const indices = await client.cat.indices({ format: "json" });
  return (indices as any[])
    .filter((idx: any) => !idx.index.startsWith(".")) // hide system indices
    .sort((a: any, b: any) => a.index.localeCompare(b.index))
    .map((idx: any) => ({
      schema: "elasticsearch",
      name: idx.index,
      type: "INDEX",
      rowCount: parseInt(idx["docs.count"] || "0", 10),
    }));
}

async function getEsFields(conn: ConnectionConfig, indexName: string): Promise<ColumnInfo[]> {
  const protocol = conn.schema || "http";
  const node = conn.uri || `${protocol}://${conn.host}:${conn.port || 9200}`;
  const client = new EsClient({
    node,
    auth: conn.username && conn.password ? { username: conn.username, password: conn.password } : undefined,
    tls: { rejectUnauthorized: false },
    requestTimeout: 10000,
  });

  const mapping = await client.indices.getMapping({ index: indexName });
  const properties = (mapping as any)[indexName]?.mappings?.properties || {};

  function flattenProps(props: Record<string, any>, prefix = ""): ColumnInfo[] {
    const result: ColumnInfo[] = [];
    for (const [name, def] of Object.entries(props) as [string, any][]) {
      const fullName = prefix ? `${prefix}.${name}` : name;
      result.push({
        name: fullName,
        dataType: def.type || "object",
        nullable: true,
        isPrimaryKey: false,
        isForeignKey: false,
        isPhiField: !!findMatchingRule(fullName, undefined, indexName),
      });
      if (def.properties) {
        result.push(...flattenProps(def.properties, fullName));
      }
    }
    return result;
  }

  return flattenProps(properties);
}
