// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CopyFormat } from "../types";
import { copyFormatIcon } from "./copy-format-icons";

const iconClass = (f: Partial<CopyFormat>, size?: number) => {
  const { container } = render(copyFormatIcon(f as CopyFormat, size));
  const svg = container.querySelector("svg")!;
  return {
    cls: svg.getAttribute("class"),
    width: svg.getAttribute("width"),
  };
};

describe("copyFormatIcon", () => {
  it.each([
    [{ builtin: "csv" }, "file-type-csv"],
    [{ builtin: "tsv" }, "table-export"],
    [{ builtin: "json" }, "json"],
    [{ builtin: "markdown" }, "markdown"],
    [{ builtin: "sql-insert" }, "database-import"],
    [{ template: { quote: "single" } }, "quote"],
    [{ template: { quote: "double" } }, "blockquote"],
    [{ template: { quote: "none" } }, "list"],
    [{}, "clipboard-copy"],
  ])("%j → %s", (format, name) => {
    const { cls } = iconClass(format as Partial<CopyFormat>);
    expect(cls).toContain(`tabler-icon-${name} `);
  });

  it("defaults to 14px and honours an explicit size", () => {
    expect(iconClass({}).width).toBe("14");
    expect(iconClass({}, 20).width).toBe("20");
  });
});
