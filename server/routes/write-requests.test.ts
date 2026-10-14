import { describe, it, expect } from "vitest";
import router from "./write-requests.js";
import { requireAdmin } from "../middleware/auth.js";
import {
  DELETABLE_STATUSES,
  planDecision,
  planDraftSubmit,
  planRevise,
} from "./write-requests.js";
import type { AuthUser } from "../types/index.js";

/**
 * Submitting a draft is the only door between an agent-authored statement and a
 * target database, and it is where the two-person rule is kept honest — so the
 * transition gets the test.
 */
const user = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    sub: "u1",
    email: "dev@example.com",
    isAdmin: false,
    allowedEnvironments: ["QA"],
    unmaskEnvironments: [],
    writeEnvironments: ["QA"],
    approveEnvironments: [],
    ...over,
  }) as AuthUser;

const draft = { status: "DRAFT" as const, env: "QA", requestedBy: "u1" };

describe("planDraftSubmit", () => {
  it("runs immediately on a direct-write environment", () => {
    const plan = planDraftSubmit(user(), draft, ["QA"]);
    expect(plan).toEqual({ ok: true, takeOwnership: false, runNow: true });
  });

  it("queues for approval on an approval environment", () => {
    const plan = planDraftSubmit(user(), draft, []);
    expect(plan).toEqual({ ok: true, takeOwnership: false, runNow: false });
  });

  it("transfers ownership when someone else's draft is submitted", () => {
    // The submitter becomes the requester, so the approve route's
    // self-approval block stops them approving what they just raised.
    const plan = planDraftSubmit(
      user({ sub: "u2" }),
      { ...draft, requestedBy: "agent-authored" },
      [],
    );
    expect(plan).toMatchObject({ ok: true, takeOwnership: true });
  });

  it("refuses without write capability on the environment", () => {
    const plan = planDraftSubmit(user({ writeEnvironments: ["DEV"] }), draft, [
      "QA",
    ]);
    expect(plan).toMatchObject({ ok: false, status: 403 });
  });

  it("refuses anything that is not a draft", () => {
    for (const status of ["PENDING", "EXECUTED", "REJECTED"] as const) {
      expect(
        planDraftSubmit(user(), { ...draft, status }, ["QA"]),
      ).toMatchObject({ ok: false, status: 409 });
    }
  });
});

/**
 * Editing is the other door an agent can push on: a draft edit must stay a
 * draft (never run), and the MCP tool's `draftOnly` guard must keep an agent
 * out of anything a human has already taken on.
 */
describe("planRevise", () => {
  const rejected = {
    status: "REJECTED" as const,
    env: "QA",
    requestedBy: "u1",
  };

  it("keeps a draft edit a draft and runs nothing, even on a direct-write env", () => {
    expect(planRevise(user(), draft, ["QA"])).toEqual({
      ok: true,
      keepDraft: true,
      runNow: false,
    });
  });

  it("resubmits a rejected request, re-running it on a direct-write env", () => {
    expect(planRevise(user(), rejected, ["QA"])).toEqual({
      ok: true,
      keepDraft: false,
      runNow: true,
    });
  });

  it("queues a resubmit for approval on an approval env", () => {
    expect(planRevise(user(), rejected, [])).toMatchObject({ runNow: false });
  });

  it("refuses a non-draft when the caller asked for draft-only", () => {
    expect(planRevise(user(), rejected, [], true)).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  it("allows a draft when the caller asked for draft-only", () => {
    expect(planRevise(user(), draft, [], true)).toMatchObject({ ok: true });
  });

  it("refuses statuses that are live or done", () => {
    for (const status of ["PENDING", "APPROVED", "EXECUTED"] as const) {
      expect(planRevise(user(), { ...draft, status }, [])).toMatchObject({
        ok: false,
        status: 409,
      });
    }
  });

  it("refuses someone else's request, and lets an admin through", () => {
    const other = { ...draft, requestedBy: "someone-else" };
    expect(planRevise(user(), other, [])).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(planRevise(user({ isAdmin: true }), other, [])).toMatchObject({
      ok: true,
    });
  });

  it("refuses without write capability on the environment", () => {
    expect(
      planRevise(user({ writeEnvironments: ["DEV"] }), draft, []),
    ).toMatchObject({ ok: false, status: 403 });
  });
});

describe("DELETABLE_STATUSES", () => {
  it("never lets an executed or live request be deleted", () => {
    // An EXECUTED request is the record of a change already applied; the route
    // refuses it for everyone, admins included.
    for (const status of ["EXECUTED", "PENDING", "APPROVED"]) {
      expect(DELETABLE_STATUSES).not.toContain(status);
    }
  });
});

describe("planDecision", () => {
  const pending = {
    status: "PENDING" as const,
    env: "PROD",
    requestedBy: "u1",
  };
  const admin = user({ sub: "a1", isAdmin: true });

  it("lets an admin override their own request with a reason", () => {
    const own = { ...pending, requestedBy: "a1" };
    expect(planDecision(admin, own, true, "incident fix")).toEqual({
      ok: true,
    });
  });

  it("lets an admin override with no approve capability on the env", () => {
    const a = user({ isAdmin: true, approveEnvironments: [] });
    expect(planDecision(a, pending, true, "why")).toEqual({ ok: true });
  });

  it("refuses override from a non-admin, even with approve capability", () => {
    const approver = user({ sub: "u2", approveEnvironments: ["PROD"] });
    expect(planDecision(approver, pending, true, "why")).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("requires a reason to override", () => {
    expect(planDecision(admin, pending, true)).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("refuses override of a request that is not pending", () => {
    for (const status of ["DRAFT", "EXECUTED", "REJECTED"] as const) {
      expect(
        planDecision(admin, { ...pending, status }, true, "why"),
      ).toMatchObject({ ok: false, status: 409 });
    }
  });

  it("still blocks self-approval on the normal path, admin or not", () => {
    const own = { ...pending, requestedBy: "a1" };
    expect(planDecision(admin, own, false)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("approves normally for another user's request with capability", () => {
    const approver = user({ sub: "u2", approveEnvironments: ["PROD"] });
    expect(planDecision(approver, pending, false)).toEqual({ ok: true });
  });
});

describe("POST /:id/override wiring", () => {
  // The planner also checks isAdmin; this guards the middleware layer so a
  // refactor of decideAndRun cannot silently open the route to non-admins.
  it("is guarded by requireAdmin", () => {
    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/:id/override",
    );
    expect(layer?.route.methods.post).toBe(true);
    const handlers = layer.route.stack.map((l: any) => l.handle);
    expect(handlers).toContain(requireAdmin);
  });

  it("is not a route a normal approver can reach via /approve with override", () => {
    const planner = planDecision(
      user({ approveEnvironments: ["PROD"] }),
      { status: "PENDING", env: "PROD", requestedBy: "u9" },
      true,
      "x",
    );
    expect(planner).toMatchObject({ ok: false, status: 403 });
  });
});
