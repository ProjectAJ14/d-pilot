const BASE_URL = "/api";

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
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

    throw new Error(body.error || `Request failed: ${res.status}`);
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
    fetch("/api/config").then((r) => r.json()) as Promise<{ appName: string; logoUrl: string | null; lightLogoUrl: string | null; emailDomain: string | null; phiMaskedEnvironments: string[] }>,

  // Auth
  login: (username: string, password: string) =>
    request<{ token: string; user: any }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<any>("/auth/me"),

  // Connections
  getConnections: () => request<any[]>("/connections"),
  getConnectionsGrouped: () => request<Record<string, any[]>>("/connections/grouped"),
  testConnection: (id: string) => request<{ connected: boolean }>(`/connections/${id}/test`),

  // Query
  executeQuery: (connectionId: string, sql: string) =>
    request<any>("/query/execute", {
      method: "POST",
      body: JSON.stringify({ connectionId, sql }),
    }),
  getQueryHistory: (limit = 50) => request<any[]>(`/query/history?limit=${limit}`),

  // Saved Queries
  getSavedQueries: () => request<any[]>("/saved-queries"),
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
  getTables: (connectionId: string) => request<any[]>(`/schema/${connectionId}/tables`),
  getColumns: (connectionId: string, table: string) =>
    request<any[]>(`/schema/${connectionId}/tables/${table}/columns`),

  // PHI Config
  getPhiRules: () => request<any[]>("/phi-config"),
  createPhiRule: (data: any) =>
    request<any>("/phi-config", { method: "POST", body: JSON.stringify(data) }),
  updatePhiRule: (id: string, data: any) =>
    request<any>(`/phi-config/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deletePhiRule: (id: string) =>
    request<any>(`/phi-config/${id}`, { method: "DELETE" }),

  // PHI Masked Environments
  getMaskedEnvironments: () =>
    request<{ environments: string[] }>("/phi-config/masked-envs"),
  updateMaskedEnvironments: (environments: string[]) =>
    request<{ environments: string[] }>("/phi-config/masked-envs", {
      method: "PUT",
      body: JSON.stringify({ environments }),
    }),

  // Audit
  getAuditLog: (limit = 100, offset = 0) =>
    request<any[]>(`/audit?limit=${limit}&offset=${offset}`),

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
  createUser: (data: { email: string; displayName: string; role: string; password: string }) =>
    request<any>("/users", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateUser: (id: string, data: { displayName?: string; role?: string }) =>
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
};
