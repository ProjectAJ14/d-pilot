import type { KeyboardEvent } from "react";

/**
 * Button semantics for an element styled as a row or link: focusable, and
 * activated by Enter or Space as well as a click.
 */
export function pressable(onActivate: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onActivate();
    },
  };
}
