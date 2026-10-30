import { describe, it, expect, vi } from "vitest";
import type { KeyboardEvent } from "react";
import { pressable } from "./pressable";

describe("pressable", () => {
  it("is a focusable button that Enter and Space activate, not other keys", () => {
    const onActivate = vi.fn();
    const p = pressable(onActivate);
    expect(p).toMatchObject({ role: "button", tabIndex: 0 });
    const key = (k: string) =>
      p.onKeyDown({ key: k, preventDefault: () => {} } as KeyboardEvent);
    key("Enter");
    key(" ");
    key("a");
    key("Tab");
    expect(onActivate).toHaveBeenCalledTimes(2);
  });
});
