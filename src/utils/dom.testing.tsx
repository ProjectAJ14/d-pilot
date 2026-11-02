/**
 * Test-only: shared setup for component tests. Use with a
 * `// @vitest-environment jsdom` docblock at the top of the test file.
 *
 * jsdom lacks the layout APIs Mantine probes on mount (matchMedia,
 * ResizeObserver, scrollIntoView); these stubs make them inert.
 */
import type { ReactElement } from "react";
import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render } from "@testing-library/react";
import { afterEach } from "vitest";

if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
// Assigned, not vi.stubGlobal'd, so a test's vi.unstubAllGlobals() can't remove it.
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

export function renderUi(ui: ReactElement, { route = "/" } = {}) {
  return render(
    <MantineProvider>
      <Notifications />
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </MantineProvider>,
  );
}
