import { useState, useCallback, useRef, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor, languages } from "monaco-editor";
import { format as formatSql } from "sql-formatter";
import {
  Button,
  Group,
  Text,
  Badge,
  ActionIcon,
  Tooltip,
  TextInput,
  Modal,
  Checkbox,
  NumberInput,
  Select,
  Loader,
} from "@mantine/core";
import {
  IconPlayerPlay,
  IconDeviceFloppy,
  IconFileExport,
  IconAlignJustified,
  IconArrowsVertical,
  IconCircleCheck,
  IconSparkles,
  IconPencilBolt,
  IconDatabase,
  IconLink,
} from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "react-router-dom";
import { useStore } from "../../store";
import { api, ApiError } from "../../utils/api-client";
import { copySavedQueryShareLink } from "../../utils/share-links";
import { downloadTextFile } from "../../utils/download-file";
import type {
  DatabaseType,
  QueryTab,
  TableInfo,
  ColumnInfo,
} from "../../types";
import { getSqlCursorContext } from "../../utils/sql-context";
import {
  buildSqlSuggestions,
  pushKeywordItems,
  type SqlDialect,
} from "../../utils/sql-completions";
import { baseSqlEditorOptions } from "../../utils/monaco-editor-options";
import { useVimMode } from "../../utils/vim-mode";

interface Props {
  tab: QueryTab;
  height?: number;
  expanded?: boolean;
  onToggleHeight?: () => void;
}

// Cache schema data for autocomplete. Entries older than the TTL are served
// stale while a background refresh replaces them (stale-while-revalidate), so
// schema changes propagate without a full page reload and without a
// completions gap. The server's own 24h cache bounds actual DB load.
interface CachedSchema {
  tables: TableInfo[];
  columns: Record<string, ColumnInfo[]>;
  loadedAt: number;
  /** True when loaded via the full-schema path (all columns present). */
  full: boolean;
}
const schemaCache: Record<string, CachedSchema> = {};
const CLIENT_SCHEMA_TTL_MS = 5 * 60_000;

// Letters are intentionally absent: `quickSuggestions.other: true` already
// opens the popup while typing words; explicit triggers only matter after
// punctuation (dot-qualifiers, commas, paths, JSON bodies).
const TRIGGER_CHARS = " .,(\"'[{/".split("");

/** Monaco grammar: SQL for RDBMS; JavaScript for Mongo shell-style; plaintext for ES (GET + JSON body). */
export function monacoLanguageForDb(
  dbType: DatabaseType | null | undefined,
): string {
  switch (dbType) {
    case "mongodb":
      return "javascript";
    case "elasticsearch":
      return "plaintext";
    case "postgres":
    case "mssql":
    default:
      return "sql";
  }
}

const MONGO_KEYWORDS = [
  "db",
  "find",
  "findOne",
  "aggregate",
  "countDocuments",
  "distinct",
  "limit",
  "sort",
  "skip",
  "$eq",
  "$gt",
  "$gte",
  "$lt",
  "$lte",
  "$in",
  "$nin",
  "$ne",
  "$regex",
  "$exists",
  "$and",
  "$or",
  "$not",
  "$nor",
  "$match",
  "$group",
  "$project",
  "$sort",
  "$limit",
  "$skip",
  "$lookup",
  "$unwind",
];

const ELASTIC_KEYWORDS = [
  "GET",
  "POST",
  "_search",
  "_count",
  "query",
  "match_all",
  "match",
  "match_phrase",
  "term",
  "terms",
  "range",
  "bool",
  "must",
  "should",
  "must_not",
  "filter",
  "size",
  "from",
  "_source",
  "sort",
  "aggs",
  "wildcard",
  "prefix",
];

/** Autocomplete cache key: connection + active schema (schema-scoped for SQL). */
function schemaCacheKey(connectionId: string, schema?: string) {
  return schema ? `${connectionId}::${schema}` : connectionId;
}

/** The default schema for a connection, known client-side without a round-trip. */
function defaultSchemaOf(conn: {
  type: DatabaseType;
  schema?: string;
}): string {
  if (conn.type === "postgres") return conn.schema || "public";
  if (conn.type === "mssql") return conn.schema || "dbo";
  return "";
}

// De-dupe concurrent loads for the same key so multiple open tabs sharing a
// connection/schema trigger only ONE full-schema fetch, not one per editor.
const schemaInflight: Record<string, Promise<CachedSchema> | undefined> = {};

async function loadSchemaForConnection(
  connectionId: string,
  schema?: string,
  dbType?: DatabaseType | null,
) {
  // On a fresh page load the editor can mount before the connections list
  // resolves, leaving the DB type unknown. Loading now would take the wrong
  // introspection path (tables-only) and poison the cache for the real type,
  // so bail — the connection-change effect re-invokes once the type is known.
  if (!dbType) {
    return { tables: [], columns: {}, loadedAt: 0, full: false };
  }

  // SQL engines return the full schema (all tables + columns) in ONE cheap,
  // server-cached call. Mongo/ES introspect a client connection per collection,
  // so for those we only list collections and fetch fields for the first few —
  // avoiding a large concurrent fan-out on the server for autocomplete.
  const useFull = dbType === "postgres" || dbType === "mssql";

  const key = schemaCacheKey(connectionId, schema);
  const cached = schemaCache[key];
  const fresh =
    cached &&
    Date.now() - cached.loadedAt < CLIENT_SCHEMA_TTL_MS &&
    // A tables-only entry never satisfies a full-schema engine: upgrade it.
    (!useFull || cached.full);
  if (fresh) return cached;
  const inflight = schemaInflight[key];
  // Stale entry: return it immediately and let the refresh land in the
  // background so completions never go blank while refetching.
  if (inflight) return cached ?? inflight;

  const pending = (async () => {
    try {
      if (useFull) {
        const full = await api.getFullSchema(connectionId, schema);
        const entry: CachedSchema = {
          tables: full.tables.map((t) => ({
            schema: schema || "",
            name: t.name,
            type: t.type,
          })) as TableInfo[],
          columns: (full.columns || {}) as Record<string, ColumnInfo[]>,
          loadedAt: Date.now(),
          full: true,
        };
        schemaCache[key] = entry;
        return entry;
      }

      const tables = await api.getTables(connectionId, schema);
      const entry: CachedSchema = {
        tables,
        columns: {},
        loadedAt: Date.now(),
        full: false,
      };
      schemaCache[key] = entry;
      // Fields for the first 20 collections/indices, loaded in the background.
      for (const t of tables.slice(0, 20)) {
        api
          .getColumns(connectionId, t.name, schema)
          .then((cols) => {
            entry.columns[t.name] = cols;
          })
          .catch(() => {});
      }
      return entry;
    } catch {
      // Keep any stale entry rather than caching an empty failure result.
      return (
        schemaCache[key] ?? {
          tables: [],
          columns: {},
          loadedAt: 0,
          full: false,
        }
      );
    }
  })().finally(() => {
    delete schemaInflight[key];
  });

  schemaInflight[key] = pending;
  return cached ?? pending;
}

/**
 * Per-model completion context. Providers are registered ONCE per Monaco
 * language for the app lifetime and resolve the connection/schema for the
 * specific model being edited at provide time — so multiple tabs (and other
 * Monaco editors like the write composer) can never bleed suggestions into
 * each other the way dispose-and-reregister-per-tab did.
 */
interface ModelCompletionContext {
  cacheKey: string;
  dbType: DatabaseType | null;
}
const modelContexts = new Map<string, ModelCompletionContext>();
const modelDisposeHooked = new WeakSet<MonacoEditor.ITextModel>();

function setModelCompletionContext(
  model: MonacoEditor.ITextModel,
  ctx: ModelCompletionContext,
) {
  modelContexts.set(model.uri.toString(), ctx);
  if (!modelDisposeHooked.has(model)) {
    modelDisposeHooked.add(model);
    model.onWillDispose(() => modelContexts.delete(model.uri.toString()));
  }
}

/** Idempotent: registers the SQL / Mongo / ES completion providers once. */
function ensureCompletionProvidersRegistered(monaco: any) {
  // The registered flag can't live in module state: a dev hot-reload
  // re-evaluates this module but keeps the same Monaco instance, and a
  // module-level flag would re-register the providers and duplicate every
  // suggestion. It can't live on `monaco` either — since Monaco is bundled
  // rather than CDN-loaded (see utils/monaco-setup.ts) that object is a sealed
  // ES module namespace and assigning to it throws. So: a WeakSet keyed by the
  // Monaco instance, parked on `globalThis`, which survives both.
  const g = globalThis as any;
  const registered: WeakSet<object> = (g.__dbPilotCompletionsRegistered ??=
    new WeakSet());
  if (registered.has(monaco)) return;
  registered.add(monaco);

  const wordRange = (model: any, position: any) => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
  };

  // SQL (postgres / mssql / no connection): context-aware via sql-context.
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: TRIGGER_CHARS,
    provideCompletionItems: (model: any, position: any) => {
      const mctx = modelContexts.get(model.uri.toString());
      const dialect: SqlDialect =
        mctx?.dbType === "mssql"
          ? "mssql"
          : mctx?.dbType === "postgres"
            ? "postgres"
            : "none";
      const schema = mctx ? schemaCache[mctx.cacheKey] : undefined;
      const ctx = getSqlCursorContext(
        model.getValue(),
        model.getOffsetAt(position),
      );
      return {
        suggestions: buildSqlSuggestions({
          monaco,
          ctx,
          schema,
          dialect,
          range: wordRange(model, position),
        }),
      };
    },
  });

  // MongoDB (javascript models). Models without a mongo context (e.g. other
  // javascript editors in the app) get no suggestions from this provider.
  monaco.languages.registerCompletionItemProvider("javascript", {
    triggerCharacters: TRIGGER_CHARS,
    provideCompletionItems: (model: any, position: any) => {
      const mctx = modelContexts.get(model.uri.toString());
      if (mctx?.dbType !== "mongodb") return { suggestions: [] };
      const range = wordRange(model, position);
      const suggestions: languages.CompletionItem[] = [];
      pushKeywordItems(monaco, suggestions, MONGO_KEYWORDS, range, "!0_");

      const lineUntil = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const dbMatch = lineUntil.match(/db\.(\w*)$/);
      const schema = schemaCache[mctx.cacheKey];
      if (schema && dbMatch) {
        const prefix = dbMatch[1].toLowerCase();
        for (const coll of schema.tables) {
          if (prefix && !coll.name.toLowerCase().startsWith(prefix)) continue;
          suggestions.push({
            label: coll.name,
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: `${coll.name}.find({})`,
            filterText: coll.name,
            sortText: "0_" + coll.name,
            detail: `${coll.type} · ${coll.schema}`,
            range,
          });
        }
      }

      if (schema && /\.\s*$/.test(lineUntil)) {
        suggestions.push(
          {
            label: "find({})",
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: "find({})",
            sortText: "0_find",
            detail: "MongoDB read",
            range,
          },
          {
            label: "findOne({})",
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: "findOne({})",
            sortText: "0_findOne",
            detail: "MongoDB read",
            range,
          },
          {
            label: "aggregate([])",
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: "aggregate([])",
            sortText: "0_agg",
            detail: "MongoDB read",
            range,
          },
          {
            label: "countDocuments({})",
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: "countDocuments({})",
            sortText: "0_count",
            detail: "MongoDB read",
            range,
          },
          {
            label: 'distinct("field", {})',
            kind: monaco.languages.CompletionItemKind.Method,
            insertText: 'distinct("field", {})',
            sortText: "0_distinct",
            detail: "MongoDB read",
            range,
          },
        );
      }

      const collForFields = lineUntil.match(
        /db\.(\w+)\.(?:find|findOne|aggregate|countDocuments|distinct)\(/,
      );
      if (schema && collForFields) {
        const collName = collForFields[1];
        const cols = schema.columns[collName];
        if (cols) {
          for (const col of cols) {
            suggestions.push({
              label: col.name,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: `"${col.name}"`,
              filterText: col.name,
              detail: col.dataType + (col.isPhiField ? " 🔐 PHI" : ""),
              range,
              sortText: "1_" + col.name,
            });
          }
        }
      }

      return { suggestions };
    },
  });

  // Elasticsearch (plaintext models): index-path suggestions.
  monaco.languages.registerCompletionItemProvider("plaintext", {
    triggerCharacters: TRIGGER_CHARS,
    provideCompletionItems: (model: any, position: any) => {
      const mctx = modelContexts.get(model.uri.toString());
      if (mctx?.dbType !== "elasticsearch") return { suggestions: [] };
      const range = wordRange(model, position);
      const suggestions: languages.CompletionItem[] = [];
      pushKeywordItems(monaco, suggestions, ELASTIC_KEYWORDS, range, "!0_");

      const lineUntil = model
        .getLineContent(position.lineNumber)
        .slice(0, position.column - 1);
      const pathMatch = lineUntil.match(/^(?:GET|POST)?\s*\/?([\w\-.*]*)$/i);
      const schema = schemaCache[mctx.cacheKey];
      if (schema && pathMatch) {
        const prefix = pathMatch[1].toLowerCase();
        for (const idx of schema.tables) {
          if (prefix && !idx.name.toLowerCase().startsWith(prefix)) continue;
          suggestions.push({
            label: idx.name + "/_search",
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: `${idx.name}/_search `,
            filterText: idx.name,
            sortText: "0_" + idx.name,
            detail: `${idx.type} · open _search body`,
            range,
          });
        }
      }

      return { suggestions };
    },
  });
}

// Toolbar + padding takes roughly 56px; subtract from total height for the editor area
const TOOLBAR_HEIGHT = 56;

export function QueryEditor({ tab, height, expanded, onToggleHeight }: Props) {
  const updateTab = useStore((s) => s.updateTab);
  const setSchemaForConnection = useStore((s) => s.setSchemaForConnection);
  const connections = useStore((s) => s.connections);
  const toggleAiAssistant = useStore((s) => s.toggleAiAssistant);
  const aiAssistantOpen = useStore((s) => s.aiAssistantOpen);
  const addSavedQuery = useStore((s) => s.addSavedQuery);
  const savedQueries = useStore((s) => s.savedQueries);
  const updateSavedQueryInStore = useStore((s) => s.updateSavedQuery);
  const defaultLimitEnabled = useStore((s) => s.defaultLimitEnabled);
  const defaultLimitValue = useStore((s) => s.defaultLimitValue);
  const setDefaultLimitEnabled = useStore((s) => s.setDefaultLimitEnabled);
  const setDefaultLimitValue = useStore((s) => s.setDefaultLimitValue);
  const setWriteHandoff = useStore((s) => s.setWriteHandoff);
  const canWrite = useStore((s) => !!s.user?.canWrite);
  const navigate = useNavigate();
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<any>(null);
  const readyTimerRef = useRef<number | null>(null);
  const vim = useVimMode();

  const activeConn = connections.find((c) => c.id === tab.connectionId);
  const supportsSchemas =
    activeConn?.type === "postgres" || activeConn?.type === "mssql";
  const [schemas, setSchemas] = useState<string[]>([]);
  // Monaco lazy-loads its chunk and mounts asynchronously, which flashes a blank
  // area then pops in text. We overlay a stable placeholder until it has mounted.
  const [editorReady, setEditorReady] = useState(false);

  // Cancel the pending reveal timer if the editor unmounts first.
  useEffect(() => {
    return () => {
      if (readyTimerRef.current) window.clearTimeout(readyTimerRef.current);
    };
  }, []);

  // Default the tab's schema synchronously from connection metadata (no
  // round-trip) so schema-scoped autocomplete loads once with the right key,
  // then fetch the full schema list only to populate the dropdown.
  useEffect(() => {
    const connId = tab.connectionId;
    if (!connId || !supportsSchemas) {
      setSchemas([]);
      return;
    }
    if (!tab.schema && activeConn) {
      // Prefer the schema already selected for this connection (shared with the
      // sidebar); fall back to the connection default. Route the write through
      // the store so both dropdowns learn it.
      const def =
        useStore.getState().schemaByConnection[connId] ??
        defaultSchemaOf(activeConn);
      if (def) setSchemaForConnection(connId, def);
    }
    let cancelled = false;
    api
      .getSchemas(connId)
      .then((r) => {
        if (!cancelled) setSchemas(r.schemas);
      })
      .catch((err) => {
        if (cancelled) return;
        setSchemas([]);
        notifications.show({
          id: `schemas-failed-${connId}`,
          color: "red",
          title: "Unable to load schemas",
          message:
            err instanceof ApiError && err.code === "CONNECTION_FAILED"
              ? "The database host could not be reached. Check your network connection."
              : err.message,
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.connectionId, supportsSchemas]);

  // Load schema, switch Monaco language, and register dialect-specific completions
  useEffect(() => {
    const connId = tab.connectionId || "";
    const dbType = activeConn?.type ?? null;
    // Resolve the schema up front (default when unset) so the cache key is
    // stable and we don't fire a throwaway fetch for the undefined key.
    const effectiveSchema =
      tab.schema ?? (activeConn ? defaultSchemaOf(activeConn) : undefined);
    const cacheKey = schemaCacheKey(connId, effectiveSchema);

    const tryApply = () => {
      if (!monacoRef.current) return false;
      ensureCompletionProvidersRegistered(monacoRef.current);
      const model = editorRef.current?.getModel();
      if (!model) return false;
      setModelCompletionContext(model, { cacheKey, dbType });
      monacoRef.current.editor.setModelLanguage(
        model,
        monacoLanguageForDb(dbType),
      );
      return true;
    };

    const run = async () => {
      if (connId)
        await loadSchemaForConnection(connId, effectiveSchema, dbType);
      if (tryApply()) return;
      const interval = window.setInterval(() => {
        if (tryApply()) window.clearInterval(interval);
      }, 200);
      window.setTimeout(() => window.clearInterval(interval), 5000);
    };

    void run();
  }, [tab.connectionId, tab.schema, activeConn?.type]);

  const handleRun = useCallback(async () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selectedText =
      selection && model && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : "";
    const sqlToRun = selectedText.trim() || tab.sql.trim();

    if (!sqlToRun || !tab.connectionId) {
      notifications.show({
        message: "Enter a query and select a connection first",
        color: "orange",
      });
      return;
    }

    updateTab(tab.id, { loading: true, error: null });

    try {
      const result = await api.executeQuery(
        tab.connectionId,
        sqlToRun,
        defaultLimitEnabled ? defaultLimitValue : null,
        tab.schema,
      );
      const conn = useStore
        .getState()
        .connections.find((c) => c.id === tab.connectionId);
      const dbDefault =
        conn?.type === "mongodb" || conn?.type === "elasticsearch"
          ? ("json" as const)
          : ("table" as const);
      updateTab(tab.id, {
        result,
        loading: false,
        viewMode: tab.viewMode ?? dbDefault,
      });
      const connLabel = conn
        ? `${conn.name} · ${conn.env} · ${conn.type}`
        : "Unknown connection";
      const dbLabel = conn?.database ? ` · ${conn.database}` : "";
      notifications.show({
        title: "Query executed successfully",
        message: `${connLabel}${dbLabel} · ${result.totalRows} rows in ${result.executionTimeMs}ms${result.truncated ? " · Truncated" : ""}`,
        color: "green",
        icon: <IconCircleCheck size={16} />,
        autoClose: 4000,
      });
    } catch (err: any) {
      updateTab(tab.id, {
        error: err.message,
        loading: false,
        result: null,
      });
      notifications.show({ message: err.message, color: "red" });
    }
  }, [
    tab.sql,
    tab.connectionId,
    tab.schema,
    tab.id,
    defaultLimitEnabled,
    defaultLimitValue,
  ]);

  // Take the selected text (or the whole query) into the Write composer.
  const handleNewWriteRequest = () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const model = editor?.getModel();
    const selectedText =
      selection && model && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : "";
    const seed = selectedText.trim() || tab.sql.trim();
    if (!seed) {
      notifications.show({
        message: "Select or write a statement first",
        color: "orange",
      });
      return;
    }
    setWriteHandoff({
      writeSql: seed,
      connectionId: tab.connectionId,
      title: tab.title.startsWith("Query ") ? "" : tab.title,
    });
    navigate("/write");
  };

  const handleSave = async () => {
    if (!saveName.trim()) return;
    try {
      if (editingSavedId) {
        const updated = await api.updateSavedQuery(editingSavedId, {
          name: saveName,
          sql: tab.sql,
          connectionId: tab.connectionId,
        });
        updateSavedQueryInStore(updated);
        notifications.show({ message: "Query updated!", color: "green" });
      } else {
        const saved = await api.createSavedQuery({
          name: saveName,
          sql: tab.sql,
          connectionId: tab.connectionId,
          isShared: true,
          tags: [],
        });
        addSavedQuery(saved);
        notifications.show({ message: "Query saved!", color: "green" });
      }
      setSaveModalOpen(false);
      setSaveName("");
      setEditingSavedId(null);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  const openSaveAsNew = () => {
    setEditingSavedId(null);
    setSaveName("");
    setSaveModalOpen(true);
  };

  // The saved query backing this tab, if any (tabs opened from / saved to the
  // library carry the query name as their title).
  const savedMatch = savedQueries.find((q) => q.name === tab.title);

  const openUpdateExisting = () => {
    const match = savedQueries.find((q) => q.name === tab.title);
    if (match) {
      setEditingSavedId(match.id);
      setSaveName(match.name);
    } else {
      setEditingSavedId(null);
      setSaveName(tab.title.startsWith("Query ") ? "" : tab.title);
    }
    setSaveModalOpen(true);
  };

  const handleExportCsv = async () => {
    if (!tab.connectionId || !tab.sql) return;
    try {
      const csv = await api.exportCsv(tab.connectionId, tab.sql);
      downloadTextFile("query-export.csv", csv);
    } catch (err: any) {
      notifications.show({ message: err.message, color: "red" });
    }
  };

  const handleFormat = useCallback(() => {
    const dbType = activeConn?.type ?? null;

    if (dbType === "mongodb") {
      // Use Monaco's built-in JS formatter
      editorRef.current?.getAction("editor.action.formatDocument")?.run();
      return;
    }

    if (dbType === "elasticsearch") {
      // Format JSON body (lines after the first GET/POST line)
      const lines = tab.sql.split("\n");
      const firstLine = lines[0];
      const jsonBody = lines.slice(1).join("\n").trim();
      if (jsonBody) {
        try {
          const formatted = JSON.stringify(JSON.parse(jsonBody), null, 2);
          updateTab(tab.id, { sql: firstLine + "\n" + formatted });
        } catch {
          notifications.show({ message: "Invalid JSON body", color: "orange" });
        }
      }
      return;
    }

    // SQL (postgres, mssql, default)
    try {
      const language = dbType === "mssql" ? "tsql" : "postgresql";
      const formatted = formatSql(tab.sql, {
        language,
        tabWidth: 2,
        keywordCase: "upper",
      });
      updateTab(tab.id, { sql: formatted });
    } catch {
      notifications.show({
        message: "Could not format query",
        color: "orange",
      });
    }
  }, [tab.sql, tab.id, activeConn?.type]);

  // Store handleRun in a ref so editor commands always call the latest version
  const handleRunRef = useRef(handleRun);
  handleRunRef.current = handleRun;

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    vim.attachEditor(editor);
    // Hold the placeholder ~500ms after mount so Monaco's initial layout/theme
    // paint (the brief black-box flicker) happens behind it, then fade out.
    readyTimerRef.current = window.setTimeout(() => setEditorReady(true), 500);

    // Cmd+Enter / Ctrl+Enter to run query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleRunRef.current();
    });

    // Cmd+S / Ctrl+S to save query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      openUpdateExisting();
    });

    const connId = tab.connectionId || "";
    const conn = useStore.getState().connections.find((c) => c.id === connId);
    const dbType = conn?.type ?? null;
    const effectiveSchema =
      tab.schema ?? (conn ? defaultSchemaOf(conn) : undefined);
    const cacheKey = schemaCacheKey(connId, effectiveSchema);
    ensureCompletionProvidersRegistered(monaco);
    const model = editor.getModel();
    if (model) setModelCompletionContext(model, { cacheKey, dbType });
    // Providers read schemaCache at provide time, so no re-registration is
    // needed once the fetch lands.
    if (connId) void loadSchemaForConnection(connId, effectiveSchema, dbType);
  };

  return (
    <>
      <div
        style={{
          background: "var(--surface2)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {/* Toolbar */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 14px",
          }}
        >
          <Button
            size="xs"
            color="green"
            leftSection={<IconPlayerPlay size={14} />}
            loading={tab.loading}
            onClick={handleRun}
            styles={{
              root: { fontWeight: 700 },
            }}
          >
            Run
          </Button>

          <Tooltip label="Generate query from plain English">
            <Button
              size="xs"
              variant={aiAssistantOpen ? "filled" : "light"}
              color="primary"
              leftSection={<IconSparkles size={14} />}
              onClick={toggleAiAssistant}
            >
              Generate
            </Button>
          </Tooltip>

          {canWrite && (
            <Tooltip label="Turn the selected text (or this query) into a write request">
              <Button
                size="xs"
                variant="light"
                color="grape"
                leftSection={<IconPencilBolt size={14} />}
                onClick={handleNewWriteRequest}
              >
                Write request
              </Button>
            </Tooltip>
          )}

          <Text
            size="xs"
            fw={700}
            tt="uppercase"
            c="dimmed"
            style={{ letterSpacing: 1 }}
          >
            Query
            {activeConn?.type === "mongodb" && (
              <Text
                component="span"
                size="xs"
                c="dimmed"
                ml={6}
                ff="monospace"
                fw={400}
              >
                · Mongo shell
              </Text>
            )}
            {activeConn?.type === "elasticsearch" && (
              <Text
                component="span"
                size="xs"
                c="dimmed"
                ml={6}
                ff="monospace"
                fw={400}
              >
                · ES REST / JSON
              </Text>
            )}
          </Text>

          <Tooltip label={expanded ? "Collapse editor" : "Expand editor"}>
            <ActionIcon variant="subtle" color="gray" onClick={onToggleHeight}>
              <IconArrowsVertical size={16} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Format">
            <ActionIcon variant="subtle" color="gray" onClick={handleFormat}>
              <IconAlignJustified size={16} />
            </ActionIcon>
          </Tooltip>

          <Tooltip label="Save query (Cmd+S)">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={openUpdateExisting}
            >
              <IconDeviceFloppy size={16} />
            </ActionIcon>
          </Tooltip>

          {savedMatch && (
            <Tooltip label="Copy share link">
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => copySavedQueryShareLink(savedMatch)}
              >
                <IconLink size={16} />
              </ActionIcon>
            </Tooltip>
          )}

          <Tooltip label="Export CSV">
            <ActionIcon variant="subtle" color="gray" onClick={handleExportCsv}>
              <IconFileExport size={16} />
            </ActionIcon>
          </Tooltip>

          {/* Default Limit controls */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginLeft: 4,
            }}
          >
            <Checkbox
              size="xs"
              label="Limit"
              checked={defaultLimitEnabled}
              onChange={(e) => setDefaultLimitEnabled(e.currentTarget.checked)}
              styles={{
                label: {
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--mantine-color-dimmed)",
                  paddingLeft: 4,
                },
              }}
            />
            <NumberInput
              size="xs"
              value={defaultLimitValue}
              onChange={(val) =>
                setDefaultLimitValue(typeof val === "number" ? val : 500)
              }
              min={1}
              max={10000}
              step={100}
              disabled={!defaultLimitEnabled}
              w={80}
              styles={{
                input: { fontFamily: "IBM Plex Mono, monospace", fontSize: 12 },
              }}
            />
          </div>

          <div style={{ flex: 1 }} />

          {supportsSchemas && schemas.length > 0 && (
            <Tooltip label="Active schema — tables resolve against this schema">
              <Select
                size="xs"
                data={schemas}
                value={tab.schema ?? null}
                onChange={(val) => {
                  if (val && tab.connectionId)
                    setSchemaForConnection(tab.connectionId, val);
                }}
                allowDeselect={false}
                checkIconPosition="right"
                leftSection={<IconDatabase size={13} />}
                w={160}
                comboboxProps={{ withinPortal: true }}
                styles={{
                  input: {
                    fontFamily: "IBM Plex Mono, monospace",
                    fontSize: 12,
                  },
                }}
              />
            </Tooltip>
          )}

          {activeConn && (
            <Badge size="sm" variant="light" color="gray" ff="monospace">
              {activeConn.name}
            </Badge>
          )}
        </div>

        {/* Monaco Editor */}
        <div
          style={{
            position: "relative",
            margin: "0 14px 12px",
            border: "1px solid var(--border)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          {/* Stable placeholder shown until Monaco has mounted (+500ms), then
              fades out — hides the blank → text-pop → layout flicker. */}
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 2,
              background: "#ffffff",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: editorReady ? 0 : 1,
              visibility: editorReady ? "hidden" : "visible",
              transition: "opacity 260ms ease, visibility 0s linear 260ms",
              pointerEvents: "none",
            }}
          >
            <Loader size="sm" color="var(--accent)" type="dots" />
            <Text size="xs" c="dimmed" style={{ letterSpacing: 0.3 }}>
              Preparing editor…
            </Text>
          </div>
          <Editor
            height={
              height ? `${Math.max(60, height - TOOLBAR_HEIGHT)}px` : "150px"
            }
            language={monacoLanguageForDb(activeConn?.type ?? null)}
            theme="vs"
            value={tab.sql}
            onChange={(value) => updateTab(tab.id, { sql: value || "" })}
            onMount={handleEditorMount}
            loading={null}
            options={baseSqlEditorOptions}
          />
        </div>
      </div>

      {/* Save Query Modal */}
      <Modal
        opened={saveModalOpen}
        onClose={() => {
          setSaveModalOpen(false);
          setEditingSavedId(null);
        }}
        title={editingSavedId ? "Update Query" : "Save Query"}
        size="sm"
      >
        <TextInput
          label="Query Name"
          placeholder="e.g., Patient orders with missing kits"
          value={saveName}
          onChange={(e) => setSaveName(e.currentTarget.value)}
          mb="md"
        />
        <Group justify="flex-end">
          <Button
            variant="subtle"
            onClick={() => {
              setSaveModalOpen(false);
              setEditingSavedId(null);
            }}
          >
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {editingSavedId ? "Update" : "Save"}
          </Button>
        </Group>
      </Modal>
    </>
  );
}
