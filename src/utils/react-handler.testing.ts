/**
 * Test-only: call an element's React event handler directly, the way a stale
 * click or a programmatic `.click()` on a re-enabled node would. The DOM's
 * `disabled` check is bypassed on purpose — this is for proving a handler's
 * own guard still holds when the button that should have prevented the call
 * did not.
 */
import { act } from "@testing-library/react";

export async function fireReactHandler(
  el: Element,
  handler = "onClick",
  ...args: unknown[]
): Promise<void> {
  const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"));
  const props = key
    ? (el as unknown as Record<string, Record<string, unknown>>)[key]
    : undefined;
  const fn = props?.[handler];
  if (typeof fn !== "function") {
    throw new Error(`element has no React ${handler} handler`);
  }
  await act(async () => {
    await fn(...args);
  });
}
