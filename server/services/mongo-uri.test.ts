import { describe, it, expect } from "vitest";
import { mongoUri } from "./query-executor.js";

describe("mongoUri", () => {
  it("escapes credentials so they cannot change the host", () => {
    const uri = mongoUri({
      id: "docs",
      name: "Docs",
      env: "DEV",
      type: "mongodb",
      host: "docs.example.com",
      port: 27017,
      database: "orders",
      username: "x@attacker.example.com:27017/orders?",
      password: "p@ss:w/rd",
    } as any);
    expect(new URL(uri).hostname).toBe("docs.example.com");
    expect(decodeURIComponent(new URL(uri).password)).toBe("p@ss:w/rd");
  });

  it("prefers a stored uri", () => {
    expect(mongoUri({ uri: "mongodb://h/db", type: "mongodb" } as any)).toBe(
      "mongodb://h/db",
    );
  });
});
