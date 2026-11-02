// @vitest-environment jsdom
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import { renderUi } from "../../utils/dom.testing";
import { fireReactHandler } from "../../utils/react-handler.testing";
import { PhiUnmaskModal } from "./phi-unmask-modal";

vi.mock("../../utils/api-client", async (orig) => ({
  ...(await orig<typeof import("../../utils/api-client")>()),
  api: { logPhiUnmask: vi.fn() },
}));
const logPhiUnmask = vi.mocked(api.logPhiUnmask);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  logPhiUnmask.mockResolvedValue(undefined as never);
  useStore.setState({
    phiEnabled: true,
    connections: [{ id: "c1", env: "QA" } as never],
    activeConnectionId: "c1",
  });
});

async function openAndPickReason() {
  const user = userEvent.setup({ delay: null });
  renderUi(<PhiUnmaskModal />);
  act(() => PhiUnmaskModal.open());
  await user.click(await screen.findByPlaceholderText("Select a reason..."));
  await user.click(await screen.findByText("Data quality validation"));
  return user;
}

describe("PhiUnmaskModal", () => {
  // Must run first: before any mount, the static handles are inert no-ops.
  it("open/close are safe no-ops before the modal mounts", () => {
    expect(() => {
      PhiUnmaskModal.open();
      PhiUnmaskModal.close();
    }).not.toThrow();
  });

  it("is closed until opened, and names the active connection's env", async () => {
    renderUi(<PhiUnmaskModal />);
    expect(screen.queryByText("De-tokenize PHI Data")).toBeNull();
    act(() => PhiUnmaskModal.open());
    expect(await screen.findByText("De-tokenize PHI Data")).toBeTruthy();
    expect(screen.getByText("QA")).toBeTruthy();
    // No reason → confirm is disabled.
    expect(
      screen.getByRole("button", { name: "De-tokenize PHI" }),
    ).toHaveProperty("disabled", true);
  });

  it("refuses to unmask without a reason even if confirm fires while disabled", async () => {
    renderUi(<PhiUnmaskModal />);
    act(() => PhiUnmaskModal.open());
    const confirm = await screen.findByRole("button", {
      name: "De-tokenize PHI",
    });
    await fireReactHandler(confirm);
    expect(localStorage.getItem("phi_unmask_reason")).toBeNull();
    expect(logPhiUnmask).not.toHaveBeenCalled();
    expect(useStore.getState().phiEnabled).toBe(true);
  });

  it("falls back to PRODUCTION when no connection is active", async () => {
    useStore.setState({ activeConnectionId: null });
    renderUi(<PhiUnmaskModal />);
    act(() => PhiUnmaskModal.open());
    expect(await screen.findByText("PRODUCTION")).toBeTruthy();
  });

  it("unmasks, stores the reason and notes for headers, and audits", async () => {
    localStorage.setItem("phi_unmask_notes", "stale");
    const user = await openAndPickReason();
    await user.type(
      screen.getByPlaceholderText(/Describe the specific need/),
      "ticket 42",
    );
    await user.click(screen.getByRole("button", { name: "De-tokenize PHI" }));
    expect(useStore.getState().phiEnabled).toBe(false);
    expect(localStorage.getItem("phi_unmask_reason")).toBe(
      "Data quality validation",
    );
    expect(localStorage.getItem("phi_unmask_notes")).toBe("ticket 42");
    expect(logPhiUnmask).toHaveBeenCalledWith({
      reason: "Data quality validation",
      notes: "ticket 42",
      connectionId: "c1",
    });
    await waitFor(() =>
      expect(screen.queryByText("De-tokenize PHI Data")).toBeNull(),
    );
  });

  it("clears stale notes, and an audit failure doesn't block the unmask", async () => {
    localStorage.setItem("phi_unmask_notes", "stale");
    useStore.setState({ activeConnectionId: null });
    logPhiUnmask.mockRejectedValue(new Error("audit down"));
    const user = await openAndPickReason();
    await user.click(screen.getByRole("button", { name: "De-tokenize PHI" }));
    expect(localStorage.getItem("phi_unmask_notes")).toBeNull();
    expect(logPhiUnmask).toHaveBeenCalledWith({
      reason: "Data quality validation",
      notes: undefined,
      connectionId: undefined,
    });
    expect(useStore.getState().phiEnabled).toBe(false);
  });

  it("cancel keeps PHI masked and resets the form", async () => {
    const user = await openAndPickReason();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useStore.getState().phiEnabled).toBe(true);
    expect(logPhiUnmask).not.toHaveBeenCalled();
    act(() => PhiUnmaskModal.open());
    expect(
      await screen.findByRole("button", { name: "De-tokenize PHI" }),
    ).toHaveProperty("disabled", true);
  });
});
