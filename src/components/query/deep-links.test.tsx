// @vitest-environment jsdom
import { notifications } from "@mantine/notifications";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { renderUi } from "../../utils/dom.testing";
import { ArtifactLink } from "./artifact-link";
import { SavedQueryLink } from "./saved-query-link";

vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: { getArtifact: vi.fn(), getSavedQuery: vi.fn() },
}));

const getArtifact = vi.mocked(api.getArtifact);
const getSavedQuery = vi.mocked(api.getSavedQuery);
const initial = useStore.getState();
const show = vi.spyOn(notifications, "show").mockReturnValue("");
const toast = () => show.mock.calls.at(-1)![0];

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const mount = (route: string) =>
  renderUi(
    <Routes>
      <Route path="/artifacts/:id" element={<ArtifactLink />} />
      <Route path="/artifacts" element={<ArtifactLink />} />
      <Route path="/saved-queries/:id" element={<SavedQueryLink />} />
      <Route path="/saved-queries" element={<SavedQueryLink />} />
      <Route path="/" element={<Where />} />
    </Routes>,
    { route },
  );

const landedHome = () =>
  waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/"));

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState(
    { ...initial, user: { email: "me@example.com" } as never },
    true,
  );
});

describe("ArtifactLink", () => {
  it("opens the artifact as a tab and credits another author", async () => {
    getArtifact.mockResolvedValue({
      id: "a1",
      title: "Orders report",
      createdByEmail: "other@example.com",
    } as never);
    mount("/artifacts/a1");
    expect(screen.getByText("Opening artifact…")).toBeTruthy();
    await landedHome();
    expect(getArtifact).toHaveBeenCalledWith("a1");
    const { tabs, activeTabId } = useStore.getState();
    expect(tabs.find((t) => t.id === activeTabId)).toMatchObject({
      kind: "artifact",
      artifactId: "a1",
      title: "Orders report",
    });
    expect(toast().message).toBe(
      'Opened "Orders report" — shared by other@example.com',
    );
  });

  it("omits the author for your own artifact", async () => {
    getArtifact.mockResolvedValue({
      id: "a2",
      title: "Mine",
      createdByEmail: "me@example.com",
    } as never);
    mount("/artifacts/a2");
    await landedHome();
    expect(toast().message).toBe('Opened "Mine"');
  });

  it("explains a bad link and goes home", async () => {
    getArtifact.mockRejectedValue(new Error("404"));
    mount("/artifacts/nope");
    await landedHome();
    expect(toast()).toMatchObject({ color: "red" });
    expect(toast().message).toMatch(/artifact link is invalid/);
  });

  it("does nothing without an id", () => {
    mount("/artifacts");
    expect(getArtifact).not.toHaveBeenCalled();
  });
});

describe("SavedQueryLink", () => {
  it("opens the query in a new tab on its own connection", async () => {
    getSavedQuery.mockResolvedValue({
      id: "q1",
      name: "Recent orders",
      sql: "SELECT * FROM orders",
      connectionId: "conn-qa",
      createdByEmail: "other@example.com",
    } as never);
    mount("/saved-queries/q1");
    expect(screen.getByText("Opening shared query…")).toBeTruthy();
    await landedHome();
    const { tabs, activeTabId } = useStore.getState();
    expect(tabs.find((t) => t.id === activeTabId)).toMatchObject({
      sql: "SELECT * FROM orders",
      title: "Recent orders",
      connectionId: "conn-qa",
    });
    expect(toast().message).toBe(
      'Opened "Recent orders" — shared by other@example.com',
    );
  });

  it("falls back to the active connection and omits your own name", async () => {
    useStore.setState({ activeConnectionId: "conn-dev" });
    getSavedQuery.mockResolvedValue({
      id: "q2",
      name: "Mine",
      sql: "SELECT 1",
      connectionId: "",
      createdByEmail: "me@example.com",
    } as never);
    mount("/saved-queries/q2");
    await landedHome();
    expect(toast().message).toBe('Opened "Mine"');
    const { tabs, activeTabId } = useStore.getState();
    expect(tabs.find((t) => t.id === activeTabId)?.connectionId).toBe(
      "conn-dev",
    );
  });

  it("explains a bad link and goes home", async () => {
    getSavedQuery.mockRejectedValue(new Error("404"));
    mount("/saved-queries/nope");
    await landedHome();
    expect(toast()).toMatchObject({ color: "red" });
    expect(toast().message).toMatch(/query link is invalid/);
  });

  it("does nothing without an id", () => {
    mount("/saved-queries");
    expect(getSavedQuery).not.toHaveBeenCalled();
  });
});
