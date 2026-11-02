// @vitest-environment jsdom
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { ColorSchemeToggle } from "./color-scheme-toggle";

describe("ColorSchemeToggle", () => {
  it("switches the Mantine color scheme", () => {
    renderUi(<ColorSchemeToggle fullWidth />);
    const dark = screen.getByRole("radio", { name: "Dark theme" });
    expect((dark as HTMLInputElement).checked).toBe(false);
    fireEvent.click(dark);
    expect((dark as HTMLInputElement).checked).toBe(true);
    expect(
      document.documentElement.getAttribute("data-mantine-color-scheme"),
    ).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "Light theme" }));
    expect(
      document.documentElement.getAttribute("data-mantine-color-scheme"),
    ).toBe("light");
  });
});
