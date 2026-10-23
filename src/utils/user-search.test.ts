import { describe, expect, it } from "vitest";
import type { User } from "@src/types";
import { filterUsers } from "./user-search";

const u = (id: string, displayName: string, email: string): User => ({
  id,
  username: email.split("@")[0],
  email,
  displayName,
  isAdmin: false,
  createdAt: "",
});

const users = [
  u("1", "Ada Lovelace", "ada@example.com"),
  u("2", "Grace Hopper", "grace.hopper@example.com"),
];

describe("filterUsers", () => {
  it("returns everyone for a blank query", () => {
    expect(filterUsers(users, "  ")).toBe(users);
  });
  it("matches name case-insensitively", () => {
    expect(filterUsers(users, "LOVE").map((x) => x.id)).toEqual(["1"]);
  });
  it("matches email and username", () => {
    expect(filterUsers(users, "hopper@").map((x) => x.id)).toEqual(["2"]);
    expect(filterUsers(users, "grace.h").map((x) => x.id)).toEqual(["2"]);
  });
  it("returns nothing when no user matches", () => {
    expect(filterUsers(users, "zed")).toEqual([]);
  });
  it("ignores surrounding whitespace in the query", () => {
    expect(filterUsers(users, "  ada ").map((x) => x.id)).toEqual(["1"]);
  });
  it("tolerates missing email and display name", () => {
    const sparse = [
      { ...u("3", "", ""), email: undefined as unknown as string },
    ];
    expect(filterUsers(sparse, "x")).toEqual([]);
  });
  it("treats regex characters literally", () => {
    expect(filterUsers(users, ".*")).toEqual([]);
    expect(filterUsers(users, "grace.hopper").map((x) => x.id)).toEqual(["2"]);
  });
  it("keeps the original order and does not mutate the input", () => {
    const copy = [...users];
    expect(filterUsers(users, "example.com").map((x) => x.id)).toEqual([
      "1",
      "2",
    ]);
    expect(users).toEqual(copy);
  });
  it("matches a username that differs from the email", () => {
    const svc = [
      { ...u("4", "Build Bot", "ci@example.com"), username: "svc-build" },
    ];
    expect(filterUsers(svc, "svc-build").map((x) => x.id)).toEqual(["4"]);
  });
});
