// @vitest-environment jsdom
import type { ReactNode } from "react";
import { MantineProvider } from "@mantine/core";
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "./dom.testing";
import { baseSqlEditorOptions, useEditorTheme } from "./monaco-editor-options";

const themeFor = (scheme: "light" | "dark") =>
  renderHook(useEditorTheme, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MantineProvider forceColorScheme={scheme}>{children}</MantineProvider>
    ),
  }).result.current;

describe("useEditorTheme", () => {
  it("maps the computed colour scheme to a Monaco theme", () => {
    expect(themeFor("dark")).toBe("d-pilot-dark");
    expect(themeFor("light")).toBe("d-pilot-light");
  });
});

describe("baseSqlEditorOptions", () => {
  it("keeps keyword completions visible and only highlights the gutter", () => {
    expect(baseSqlEditorOptions.suggest?.showKeywords).toBe(true);
    expect(baseSqlEditorOptions.renderLineHighlight).toBe("gutter");
  });
});
