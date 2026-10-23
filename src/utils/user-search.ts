import type { User } from "@src/types";

/** Case-insensitive match on name, email or username; blank query keeps everyone. */
export function filterUsers(users: User[], query: string): User[] {
  const q = query.trim().toLowerCase();
  if (!q) return users;
  return users.filter((u) =>
    [u.displayName, u.email, u.username].some((f) =>
      (f || "").toLowerCase().includes(q),
    ),
  );
}
