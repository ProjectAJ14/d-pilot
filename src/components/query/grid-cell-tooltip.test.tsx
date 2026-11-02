// @vitest-environment jsdom
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { GridCellTooltip } from "./grid-cell-tooltip";

describe("GridCellTooltip", () => {
  it("shows a UTC datetime as the viewer's time with its source", () => {
    renderUi(<GridCellTooltip value="2024-03-05T10:20:30Z" />);
    expect(screen.getByText("Your time")).toBeTruthy();
    expect(screen.getByText("Source (UTC)")).toBeTruthy();
    expect(screen.getByText("2024-03-05T10:20:30Z")).toBeTruthy();
    expect(screen.queryByText(/No time zone/)).toBeNull();
  });

  it("flags a zone-less datetime as local", () => {
    renderUi(<GridCellTooltip value="2024-03-05T10:20:30" />);
    expect(screen.getByText("Local time")).toBeTruthy();
    expect(screen.getByText(/No time zone in source/)).toBeTruthy();
  });

  it("falls back to plain text, with NULL for missing values", () => {
    const { unmount } = renderUi(<GridCellTooltip value={42} />);
    expect(screen.getByText("42")).toBeTruthy();
    unmount();
    renderUi(<GridCellTooltip value={null} />);
    expect(screen.getByText("NULL")).toBeTruthy();
    renderUi(<GridCellTooltip />);
    expect(screen.getAllByText("NULL")).toHaveLength(2);
  });
});
