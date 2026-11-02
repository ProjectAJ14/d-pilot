// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTextFile } from "./download-file";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("downloadTextFile", () => {
  it("clicks a detached anchor and revokes the URL only after a delay", async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    let connectedAtClick = false;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        connectedAtClick = this.isConnected;
      });

    downloadTextFile("out.csv", "a,b\n1,2");

    const clicked = click.mock.contexts[0] as HTMLAnchorElement;
    expect(clicked.download).toBe("out.csv");
    expect(clicked.href).toBe("blob:x");
    expect(connectedAtClick).toBe(true);
    expect(clicked.isConnected).toBe(false);
    expect(blobs[0].type).toBe("text/csv");
    expect(await blobs[0].text()).toBe("a,b\n1,2");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });

  it("uses the given mime type", () => {
    let type = "";
    URL.createObjectURL = vi.fn((b: Blob) => ((type = b.type), "blob:y"));
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadTextFile("q.sql", "select 1", "text/plain");
    expect(type).toBe("text/plain");
  });
});
