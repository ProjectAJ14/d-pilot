import type {
  AiChatLogEntry,
  ApiErrorCode,
  WriteRequest,
  WriteAiReview,
  QueryResult,
} from "../types";

const BASE_URL = "/api";

// Error thrown for non-OK API responses. Carries the HTTP status and the
// server's machine-readable code (e.g. CONNECTION_FAILED) when present.
export class ApiError extends Error {
  status: number;
  code?: ApiErrorCode;

  constructor(message: string, status: number, code?: ApiErrorCode) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem("dbpilot_token");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  // PHI shield state
  const phiEnabled = localStorage.getItem("phi_shield") !== "off";
  if (!phiEnabled) {
    headers["X-PHI-Shield"] = "off";
    const reason = localStorage.getItem("phi_unmask_reason");
    const notes = localStorage.getItem("phi_unmask_notes");
    if (reason) headers["X-PHI-Unmask-Reason"] = reason;
    if (notes) headers["X-PHI-Unmask-Notes"] = notes;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));

    if (res.status === 401 && token) {
      // Token expired — logout via store so React re-renders to login screen
      const { useStore } = await import("../store");
      useStore.getState().logout();
      throw new Error("Session expired");
    }

    throw new ApiError(
      body.error || `Request failed: ${res.status}`,
      res.status,
      body.code,
    );
  }

  // For blob responses (CSV export)
  if (res.headers.get("Content-Type")?.includes("text/csv")) {
    return (await res.text()) as unknown as T;
  }

  return res.json();
}

export const api = {
  // Config (public, no auth)
  getConfig: () =>
    fetch("/api/config").then((r) => r.json()) as Promise<{
      appName: string;
      logoUrl: string | null;
      lightLogoUrl: string | null;
      faviconUrl: string | null;
      emailDomain: string | null;
      phiMaskedEnvironments: string[];
      environments: string[];
    }>,

  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: any }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<any>("/auth/me"),

  // Connections
  getConnections: () => request<any[]>("/connections"),
  getWritableConnections: () => request<any[]>("/connections/writable"),
  getConnectionsGrouped: () =>
    request<Record<string, any[]>>("/connections/grouped"),
  testConnection: (id: string) =>
    request<{ connected: boolean }>(`/connections/${id}/test`),
  getConnectionStatus: () =>
    request<
      {
        id: string;
        name: string;
        env: string;
        type: string;
        database: string;
        live: boolean;
        totalSockets?: number;
        idleSockets?: number;
        lastUsedAt?: string;
      }[]
    >("/connections/status"),
  disconnectConnection: (id: string) =>
    request<{ closed: boolean }>(`/connections/${id}/disconnect`, {
      method: "POST",
    }),

  // Write requests / approval workflow
  getWritePolicy: () =>
    request<{ writeModeEnabled: boolean; directEnvs: string[] }>(
      "/write-requests/policy",
    ),
  updateWritePolicy: (data: {
    writeModeEnabled?: boolean;
    directEnvs?: string[];
  }) =>
    request<{ writeModeEnabled: boolean; directEnvs: string[] }>(
      "/write-requests/policy",
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    ),
  getWriteRequests: () => request<WriteRequest[]>("/write-requests"),
  getWriteRequest: (id: string) =>
    request<WriteRequest>(`/write-requests/${id}`),
  createWriteRequest: (data: {
    title: string;
    description?: string;
    connectionId: string;
    selectSql?: string;
    writeSql: string;
    noTransaction?: boolean;
  }) =>
    request<WriteRequest>("/write-requests", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  // Classify a draft write: single-DML vs migration, statement count, whether
  // it needs the no-rollback escape hatch. Powers live composer feedback.
  analyzeWrite: (data: { connectionId: string; writeSql: string }) =>
    request<{
      statementCount: number;
      isMigration: boolean;
      hasDdl: boolean;
      requiresNoTransaction: boolean;
      blocked?: string;
    }>("/write-requests/analyze", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  previewWriteRequest: (id: string, defaultLimit?: number | null) =>
    request<QueryResult>(`/write-requests/${id}/preview`, {
      method: "POST",
      body: JSON.stringify({ defaultLimit }),
    }),
  aiReviewWriteRequest: (id: string) =>
    request<WriteAiReview>(`/write-requests/${id}/ai-review`, {
      method: "POST",
    }),
  // Stateless composer helpers (before a request is saved)
  reviewWriteDraft: (data: {
    connectionId: string;
    selectSql?: string;
    writeSql: string;
  }) =>
    request<WriteAiReview>("/write-requests/ai-review", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  suggestWriteQuery: (data: {
    connectionId: string;
    selectSql: string;
    intent?: string;
    currentWrite?: string;
  }) =>
    request<{ query: string; explanation: string }>(
      "/write-requests/suggest-write",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  suggestSelectQuery: (data: {
    connectionId: string;
    writeSql: string;
    intent?: string;
    currentSelect?: string;
  }) =>
    request<{ query: string; explanation: string }>(
      "/write-requests/suggest-select",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
  approveWriteRequest: (id: string, notes?: string) =>
    request<WriteRequest>(`/write-requests/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    }),
  rejectWriteRequest: (id: string, notes?: string) =>
    request<WriteRequest>(`/write-requests/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ notes }),
    }),
  cancelWriteRequest: (id: string) =>
    request<WriteRequest>(`/write-requests/${id}/cancel`, { method: "POST" }),
  reviseWriteRequest: (
    id: string,
    data: {
      title?: string;
      description?: string;
      selectSql?: string;
      writeSql?: string;
      note?: string;
      noTransaction?: boolean;
    },
  ) =>
    request<WriteRequest>(`/write-requests/${id}/revise`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Query
  executeQuery: (
    connectionId: string,
    sql: string,
    defaultLimit?: number | null,
    schema?: string,
  ) =>
    request<any>("/query/execute", {
      method: "POST",
      body: JSON.stringify({ connectionId, sql, defaultLimit, schema }),
    }),
  getQueryHistory: (limit = 50) =>
    request<any[]>(`/query/history?limit=${limit}`),

  // Saved Queries
  getSavedQueries: () => request<any[]>("/saved-queries"),
  getSavedQuery: (id: string) => request<any>(`/saved-queries/${id}`),
  createSavedQuery: (data: any) =>
    request<any>("/saved-queries", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateSavedQuery: (id: string, data: any) =>
    request<any>(`/saved-queries/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteSavedQuery: (id: string) =>
    request<any>(`/saved-queries/${id}`, { method: "DELETE" }),

  // Schema
  getSchemas: (connectionId: string) =>
    request<{ schemas: string[]; default: string }>(
      `/schema/${connectionId}/schemas`,
    ),
  getTables: (connectionId: string, schema?: string) =>
    request<any[]>(
      `/schema/${connectionId}/tables${schema ? `?schema=${encodeURIComponent(schema)}` : ""}`,
    ),
  getFullSchema: (connectionId: string, schema?: string) =>
    request<{
      tables: { name: string; type: string }[];
      columns: Record<string, any[]>;
    }>(
      `/schema/${connectionId}/full${schema ? `?schema=${encodeURIComponent(schema)}` : ""}`,
    ),
  getColumns: (connectionId: string, table: string, schema?: string) =>
    request<any[]>(
      `/schema/${connectionId}/tables/${table}/columns${schema ? `?schema=${encodeURIComponent(schema)}` : ""}`,
    ),

  // PHI Config
  logPhiUnmask: (data: {
    reason: string;
    notes?: string;
    connectionId?: string;
  }) =>
    request<{ logged: boolean }>("/phi-config/unmask", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getPhiRules: () => request<any[]>("/phi-config"),
  createPhiRule: (data: any) =>
    request<any>("/phi-config", { method: "POST", body: JSON.stringify(data) }),
  updatePhiRule: (id: string, data: any) =>
    request<any>(`/phi-config/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deletePhiRule: (id: string) =>
    request<any>(`/phi-config/${id}`, { method: "DELETE" }),
  exportPhiRules: () => request<string>("/phi-config/export"),
  importPhiRules: (csv: string) =>
    request<{
      imported: number;
      updated: number;
      skipped: number;
      total: number;
    }>("/phi-config/import", { method: "POST", body: JSON.stringify({ csv }) }),
  deleteAllPhiRules: (includeLocked: boolean) =>
    request<{ deleted: number; kept: number }>(
      `/phi-config?includeLocked=${includeLocked}`,
      { method: "DELETE" },
    ),

  // PHI Masked Environments
  getMaskedEnvironments: () =>
    request<{ environments: string[] }>("/phi-config/masked-envs"),
  updateMaskedEnvironments: (environments: string[]) =>
    request<{ environments: string[] }>("/phi-config/masked-envs", {
      method: "PUT",
      body: JSON.stringify({ environments }),
    }),

  // Audit
  getAuditLog: (
    params: {
      limit?: number;
      offset?: number;
      from?: string;
      to?: string;
      action?: string;
      userId?: string;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    if (params.action) q.set("action", params.action);
    if (params.userId) q.set("userId", params.userId);
    return request<any[]>(`/audit?${q.toString()}`);
  },
  getArchiveLog: (
    params: {
      limit?: number;
      offset?: number;
      from?: string;
      to?: string;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    return request<any[]>(`/audit/archive?${q.toString()}`);
  },
  triggerArchive: () =>
    request<{ archived: number; message: string }>("/audit/archive", {
      method: "POST",
    }),

  // Analytics
  getAnalytics: () => request<any>("/analytics"),

  // Export
  exportCsv: (connectionId: string, sql: string) =>
    request<string>("/export/csv", {
      method: "POST",
      body: JSON.stringify({ connectionId, sql }),
    }),
  exportJson: (connectionId: string, sql: string) =>
    request<any[]>("/export/json", {
      method: "POST",
      body: JSON.stringify({ connectionId, sql }),
    }),

  // Profile
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ success: boolean; message: string }>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  updateProfile: (data: { displayName: string }) =>
    request<any>("/auth/profile", {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // User Management (admin)
  getUsers: () => request<any[]>("/users"),
  createUser: (data: {
    email: string;
    displayName: string;
    password: string;
    isAdmin?: boolean;
    allowedEnvironments?: string[];
    unmaskEnvironments?: string[];
    writeEnvironments?: string[];
    approveEnvironments?: string[];
  }) =>
    request<any>("/users", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateUser: (
    id: string,
    data: {
      displayName?: string;
      isAdmin?: boolean;
      allowedEnvironments?: string[];
      unmaskEnvironments?: string[];
      writeEnvironments?: string[];
      approveEnvironments?: string[];
    },
  ) =>
    request<any>(`/users/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteUser: (id: string) =>
    request<{ deleted: boolean }>(`/users/${id}`, { method: "DELETE" }),
  resetUserPassword: (id: string, newPassword: string) =>
    request<{ success: boolean }>(`/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ newPassword }),
    }),

  // Azure OpenAI (admin)
  testAzureConnection: () =>
    request<{
      success: boolean;
      message: string;
      endpoint?: string;
      deployment?: string;
      model?: string;
    }>("/azure-ai/test", { method: "POST" }),

  // AI Query Generation (any authenticated user)
  generateQuery: (data: {
    connectionId: string;
    prompt: string;
    currentQuery?: string;
    refreshSchema?: boolean;
    mode?: "read" | "write";
    schema?: string;
  }) =>
    request<{
      query: string;
      explanation: string;
      model?: string;
      schemaTruncated: boolean;
      tablesProvided: number;
      totalTables: number;
      schemaCached?: boolean;
      schemaCachedAt?: string;
      examplesUsed?: number;
      relevantSelection?: boolean;
    }>("/azure-ai/generate-query", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Clear cached schema summaries (admin)
  clearSchemaCache: (connectionId?: string) =>
    request<{ cleared: number; scope: string }>(
      "/azure-ai/schema-cache/clear",
      {
        method: "POST",
        body: JSON.stringify(connectionId ? { connectionId } : {}),
      },
    ),

  // AI Chat Log (admin)
  getAiChatLog: (
    params: {
      limit?: number;
      offset?: number;
      from?: string;
      to?: string;
      status?: string;
    } = {},
  ) => {
    const q = new URLSearchParams();
    if (params.limit) q.set("limit", String(params.limit));
    if (params.offset) q.set("offset", String(params.offset));
    if (params.from) q.set("from", params.from);
    if (params.to) q.set("to", params.to);
    if (params.status) q.set("status", params.status);
    return request<AiChatLogEntry[]>(`/azure-ai/chat-log?${q.toString()}`);
  },
};
