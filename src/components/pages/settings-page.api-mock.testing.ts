/**
 * Test-only: a stand-in for `utils/api-client` whose `api` auto-creates a
 * vi.fn for every method it is asked for. Use as
 *   vi.mock("../../utils/api-client", async (orig) =>
 *     (await import("./settings-page.api-mock.testing")).apiModuleMock(
 *       await orig(),
 *     ));
 * The rest of the module (ApiError, …) stays real.
 */
import { vi, type Mock } from "vitest";

export function apiModuleMock(actual: object) {
  const fns: Record<string, Mock> = {};
  return {
    ...actual,
    api: new Proxy(fns, {
      // "then" stays undefined so the module is never mistaken for a promise.
      get: (t, k) =>
        typeof k === "string" && k !== "then" ? (t[k] ??= vi.fn()) : undefined,
    }),
  };
}
