import { describe, it, expect } from "vitest";
import { planDraftSubmit } from "./write-requests.js";
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
