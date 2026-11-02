/**
 * Test-only: shared setup for the settings-page component tests.
 * Pair with the api mock in settings-page.api-mock.testing.ts.
 */
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, type Mock } from "vitest";
import { notifications } from "@mantine/notifications";
import { api } from "../../utils/api-client";
import { useStore } from "../../store";
import { renderUi } from "../../utils/dom.testing";
import { SettingsPage } from "./settings-page";

// Notifications live in a global store: clear them so one test's toasts
// never push the next test's past the visible limit.
afterEach(() => notifications.clean());

/** The mocked api, typed loosely so tests can stub any method. */
export const mockApi = api as unknown as Record<string, Mock>;

export function setEnvironments(environments: string[], masked = ["PROD"]) {
  useStore.setState((s) => ({
    config: { ...s.config, environments, phiMaskedEnvironments: masked },
  }));
}

export function renderSettings(tab?: string) {
  return renderUi(<SettingsPage />, {
    route: tab ? `/settings?tab=${tab}` : "/settings",
  });
}

export const user = () => userEvent.setup();

/** The open Mantine modal; it mounts a frame after its trigger, hence async. */
export const dialog = async () => within(await screen.findByRole("dialog"));
