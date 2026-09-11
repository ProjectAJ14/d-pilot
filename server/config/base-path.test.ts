import { describe, it, expect } from "vitest";
import {
  normalizeBasePath,
  toBaseUrl,
  withBase,
  withBaseOrigin,
} from "./base-path.js";

describe("normalizeBasePath", () => {
  it("treats unset, empty and root as the domain root", () => {
    // "//" and "///" included: they must not survive as "/", which toBaseUrl()
    // would turn into a protocol-relative "//" base.
    for (const raw of [undefined, null, "", "   ", "/", "//", "///", " // "]) {
      expect(normalizeBasePath(raw)).toBe("");
      expect(toBaseUrl(normalizeBasePath(raw))).toBe("/");
    }
  });

  it("canonicalises whatever an operator is likely to type", () => {
    for (const raw of [
      "d-pilot",
      "/d-pilot",
      "/d-pilot/",
      " /d-pilot ",
      "//d-pilot//",
    ]) {
      expect(normalizeBasePath(raw)).toBe("/d-pilot");
    }
  });
});

describe("toBaseUrl", () => {
  it("is the trailing-slash spelling of the same value", () => {
    expect(toBaseUrl("")).toBe("/");
    expect(toBaseUrl("/d-pilot")).toBe("/d-pilot/");
  });
});

describe("withBase", () => {
  it("prefixes root-absolute paths", () => {
    expect(withBase("/d-pilot", "/logo.png")).toBe("/d-pilot/logo.png");
    expect(withBase("", "/logo.png")).toBe("/logo.png");
  });

  it("leaves somebody else's CDN alone", () => {
    expect(withBase("/d-pilot", "https://cdn.example/logo.png")).toBe(
      "https://cdn.example/logo.png",
    );
    expect(withBase("/d-pilot", "//cdn.example/logo.png")).toBe(
      "//cdn.example/logo.png",
    );
  });

  it("passes through empty values", () => {
    expect(withBase("/d-pilot", null)).toBeNull();
    expect(withBase("/d-pilot", "")).toBeNull();
  });
});

describe("withBaseOrigin", () => {
  it("adds the sub-path to an origin, which is how APP_BASE_URL is documented", () => {
    expect(withBaseOrigin("https://intranet.example", "/d-pilot")).toBe(
      "https://intranet.example/d-pilot",
    );
    expect(withBaseOrigin("https://intranet.example/", "/d-pilot")).toBe(
      "https://intranet.example/d-pilot",
    );
  });

  it("does not double a prefix the operator already spelled out", () => {
    expect(withBaseOrigin("https://intranet.example/d-pilot", "/d-pilot")).toBe(
      "https://intranet.example/d-pilot",
    );
    expect(
      withBaseOrigin("https://intranet.example/d-pilot/", "/d-pilot"),
    ).toBe("https://intranet.example/d-pilot");
  });

  it("leaves a root deployment's origin untouched", () => {
    expect(withBaseOrigin("https://d-pilot.internal", "")).toBe(
      "https://d-pilot.internal",
    );
  });

  it("falls back to the bare base path when no origin is configured", () => {
    for (const raw of [undefined, null, "", "   ", "/"]) {
      expect(withBaseOrigin(raw, "/d-pilot")).toBe("/d-pilot");
      expect(withBaseOrigin(raw, "")).toBe("");
    }
  });

  it("leaves an unparseable value as the operator wrote it", () => {
    expect(withBaseOrigin("intranet.example", "/d-pilot")).toBe(
      "intranet.example",
    );
  });

  it("is not fooled by a host that ends in the prefix", () => {
    expect(withBaseOrigin("https://d-pilot", "/d-pilot")).toBe(
      "https://d-pilot/d-pilot",
    );
  });
});
