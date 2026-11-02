import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, SavedQuery } from "../types";

const h = vi.hoisted(() => ({ copy: vi.fn(), show: vi.fn() }));
vi.mock("./clipboard", () => ({ copyToClipboard: h.copy }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: h.show } }));
vi.mock("./base-path", () => ({ BASE_PATH: "/d-pilot" }));
vi.stubGlobal("window", { location: { origin: "https://example.test" } });

const { copySavedQueryShareLink, copyArtifactShareLink } =
  await import("./share-links");

beforeEach(() => {
  h.copy.mockClear();
  h.show.mockClear();
});

describe("share links", () => {
  it("builds the saved-query link under the base path, silent when shared", () => {
    copySavedQueryShareLink({ id: "q1", isShared: true } as SavedQuery);
    expect(h.copy).toHaveBeenCalledWith(
      "https://example.test/d-pilot/saved-queries/q1",
      "share link",
    );
    expect(h.show).not.toHaveBeenCalled();
  });

  it("warns when the saved query is private", () => {
    copySavedQueryShareLink({ id: "q2", isShared: false } as SavedQuery);
    expect(h.show).toHaveBeenCalledWith(
      expect.objectContaining({
        color: "yellow",
        message: expect.stringContaining("query is private"),
      }),
    );
  });

  it("builds the artifact link and warns only when private", () => {
    copyArtifactShareLink({ id: "a1", isShared: true } as Artifact);
    expect(h.copy).toHaveBeenCalledWith(
      "https://example.test/d-pilot/artifacts/a1",
      "share link",
    );
    expect(h.show).not.toHaveBeenCalled();
    copyArtifactShareLink({ id: "a2", isShared: false } as Artifact);
    expect(h.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("artifact is private"),
      }),
    );
  });
});
