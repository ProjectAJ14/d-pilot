// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { FkBadge } from "./fk-badge";

const copyToClipboard = vi.fn();
vi.mock("../../utils/clipboard", () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

beforeEach(() => copyToClipboard.mockReset());

describe("FkBadge", () => {
  it("toggles the details on click without bubbling to the row", async () => {
    const rowClick = vi.fn();
    renderUi(
      <div onClick={rowClick}>
        <FkBadge column="customer_id" references="app_core.customers.id" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "FK" }));
    expect(rowClick).not.toHaveBeenCalled();
    expect(await screen.findByText("app_core.customers")).toBeTruthy();
    expect(screen.getByText("id")).toBeTruthy();

    fireEvent.click(screen.getByText("Foreign key"));
    expect(rowClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("Copy reference"));
    expect(copyToClipboard).toHaveBeenCalledWith(
      "app_core.customers.id",
      "reference",
    );
  });

  it("opens and closes from the keyboard, ignoring other keys", async () => {
    renderUi(<FkBadge column="region_id" />);
    const chip = screen.getByRole("button", { name: "FK" });
    fireEvent.keyDown(chip, { key: "a" });
    expect(screen.queryByText("Foreign key")).toBeNull();
    fireEvent.keyDown(chip, { key: "Enter" });
    expect(await screen.findByText(/Target unknown/)).toBeTruthy();
    expect(screen.queryByText("References table")).toBeNull();
    expect(screen.queryByLabelText("Copy reference")).toBeNull();
    fireEvent.keyDown(chip, { key: " " });
    await waitFor(() =>
      expect(screen.queryByText(/Target unknown/)).toBeNull(),
    );
  });

  it("omits table/column rows for a single-part reference", async () => {
    renderUi(<FkBadge column="ref" references="orphan" />);
    fireEvent.click(screen.getByRole("button", { name: "FK" }));
    expect(await screen.findByLabelText("Copy reference")).toBeTruthy();
    expect(screen.queryByText("References table")).toBeNull();
    expect(screen.queryByText("References column")).toBeNull();
  });
});
