/**
 * Loopback HTTP client used by the MCP endpoint (`routes/mcp.ts`).
 *
 * The MCP tools deliberately call D-Pilot's own REST API over localhost instead
 * of reaching into the query executor directly. That leaves exactly one code path
 * for environment access, PHI masking, row limits and audit logging — an agent's
 * query is indistinguishable from a UI query on the way down, so the two can
 * never drift. This file owns only the session: exchange the agent's
 * username/password for a JWT, hold it in memory, re-login once when it expires.
 */

export interface DPilotApiClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class DPilotApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "DPilotApiError";
    this.status = status;
    this.code = code;
  }
}

export class DPilotApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;
  /** In-flight login, so concurrent tool calls issue only one. */
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly options: DPilotApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async login(): Promise<string> {
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const res = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: this.options.username,
          password: this.options.password,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new DPilotApiError(
          body.error || `Login failed (${res.status})`,
          res.status,
        );
      }

      const { token } = (await res.json()) as { token: string };
      this.token = token;
      return token;
    })().finally(() => {
      this.loginInFlight = null;
    });

    return this.loginInFlight;
  }

  /**
   * Calls an authenticated endpoint. `path` is relative to `/api`. A 401 costs
   * one silent re-login and replay; a second 401 surfaces to the caller.
   */
  async request<T>(
    path: string,
    init: RequestInit = {},
    allowRetry = true,
  ): Promise<T> {
    const token = this.token ?? (await this.login());

    const res = await this.fetchImpl(`${this.baseUrl}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(init.headers as Record<string, string> | undefined),
      },
    });

    if (res.status === 401 && allowRetry) {
      this.token = null;
      return this.request<T>(path, init, false);
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new DPilotApiError(
        body.error || `Request failed (${res.status})`,
        res.status,
        body.code,
      );
    }

    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }
}
