import { vi } from "vitest";

/**
 * Test-only: api-client builds `new Request("/api/...")`, which a browser
 * resolves against the page. Node's Request has no page, so this resolves
 * relative URLs against http://localhost. Import it before api-client.
 */
const NodeRequest = Request;
vi.stubGlobal(
  "Request",
  class extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" ? new URL(input, "http://localhost") : input,
        init,
      );
    }
  },
);
