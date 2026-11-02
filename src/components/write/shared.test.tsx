// @vitest-environment jsdom
import { useEffect } from "react";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import type { QueryResult, WriteAiReview } from "../../types";
import {
  AiReviewCard,
  CodeBlock,
  EnvBadge,
  PreviewTable,
  SqlBlock,
  StatusBadge,
  STATUS_META,
  VerdictBadge,
  fmtDateTime,
} from "./shared";

const sizeListeners: (() => void)[] = [];
let contentHeight = 100;

vi.mock("@monaco-editor/react", () => ({
  default: function Editor(props: {
    value: string;
    language: string;
    height: number;
    onMount: (e: unknown) => void;
  }) {
    useEffect(() => {
      props.onMount({
        getContentHeight: () => contentHeight,
        onDidContentSizeChange: (cb: () => void) => sizeListeners.push(cb),
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return (
      <pre
        data-testid="editor"
        data-lang={props.language}
        data-height={props.height}
      >
        {props.value}
      </pre>
    );
  },
}));

vi.mock("../query/results-json-view", () => ({
  ResultsJsonView: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="json-view">{rows.length} docs</div>
  ),
}));

const review = (over: Partial<WriteAiReview> = {}): WriteAiReview => ({
  verdict: "SAFE",
  risks: [],
  summary: "Updates one order.",
  recommendation: "Approve",
  ...over,
});

describe("SqlBlock / SqlView", () => {
  it("renders a stepped block with hint, amber bar and footer, sizing the editor to its content", async () => {
    contentHeight = 1000;
    renderUi(
      <SqlBlock
        label="Write statement"
        code="UPDATE orders SET status = 'x'"
        dbType="postgres"
        step={2}
        hint="runs on approval"
        barLabel="WRITES DATA"
        barTone="amber"
        footer={<span>footer here</span>}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("runs on approval")).toBeTruthy();
    expect(screen.getByText("WRITES DATA")).toBeTruthy();
    expect(screen.getByText("footer here")).toBeTruthy();
    const editor = screen.getByTestId("editor");
    expect(editor.dataset.lang).toBe("sql");
    // capped at 360
    expect(editor.dataset.height).toBe("360");
    contentHeight = 5;
    const { act } = await import("@testing-library/react");
    act(() => sizeListeners.forEach((cb) => cb()));
    // floored at 40
    expect(screen.getByTestId("editor").dataset.height).toBe("40");
  });

  it("uses an uppercase label, neutral bar and (empty) placeholder", () => {
    renderUi(
      <SqlBlock label="Verify select" code="   " barLabel="READS ONLY" />,
    );
    expect(screen.getByText("Verify select")).toBeTruthy();
    expect(screen.getByText("READS ONLY")).toBeTruthy();
    expect(screen.getByText("(empty)")).toBeTruthy();
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("picks the editor language from the database type", () => {
    renderUi(
      <>
        <SqlBlock label="a" code="db.orders.find()" dbType="mongodb" />
        <SqlBlock label="b" code='{"query":{}}' dbType="elasticsearch" />
      </>,
    );
    const langs = screen.getAllByTestId("editor").map((e) => e.dataset.lang);
    expect(langs).toEqual(["javascript", "plaintext"]);
  });
});

describe("badges", () => {
  it("labels known and unknown statuses", () => {
    renderUi(
      <>
        <StatusBadge status="PENDING" />
        <StatusBadge status={"WEIRD" as never} />
      </>,
    );
    expect(screen.getByText(STATUS_META.PENDING.label)).toBeTruthy();
    expect(screen.getByText("WEIRD")).toBeTruthy();
  });

  it("shows the environment name", () => {
    renderUi(<EnvBadge env="QA" />);
    expect(screen.getByText("QA")).toBeTruthy();
  });

  it("renders nothing without a verdict, and falls back to Caution for an unknown one", () => {
    const { container } = renderUi(<VerdictBadge />);
    expect(container.querySelector(".mantine-Badge-root")).toBeNull();
    renderUi(
      <>
        <VerdictBadge verdict="DANGEROUS" />
        <VerdictBadge verdict="MAYBE" />
      </>,
    );
    expect(screen.getByText("Dangerous")).toBeTruthy();
    expect(screen.getByText("Caution")).toBeTruthy();
  });
});

describe("AiReviewCard", () => {
  it("shows a minimal review with no extras", () => {
    renderUi(<AiReviewCard review={review()} />);
    expect(screen.getByText("Safe")).toBeTruthy();
    expect(screen.getByText("Updates one order.")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.queryByText(/Blast radius/)).toBeNull();
    expect(screen.queryByText(/SELECT/)).toBeNull();
    expect(screen.queryByText("Suggested correction")).toBeNull();
  });

  it("shows blast radius, select match, model, risks and both suggestions, and applies them", () => {
    const onApply = vi.fn();
    renderUi(
      <AiReviewCard
        review={review({
          verdict: "UNKNOWN" as never,
          estimatedBlastRadius: "Unbounded",
          selectMatchesWrite: false,
          model: "gpt-x",
          risks: ["No WHERE clause", "Touches customers"],
          suggestedWriteSql: "UPDATE orders SET a=1 WHERE id=1",
          suggestedSelectSql: "SELECT * FROM orders WHERE id=1",
        })}
        onApply={onApply}
      />,
    );
    expect(screen.getByText("Caution")).toBeTruthy();
    expect(screen.getByText("Blast radius: Unbounded")).toBeTruthy();
    expect(screen.getByText("SELECT may not match WRITE")).toBeTruthy();
    expect(screen.getByText("gpt-x")).toBeTruthy();
    expect(screen.getByText("No WHERE clause")).toBeTruthy();
    expect(screen.getByText("Touches customers")).toBeTruthy();
    expect(screen.getByText("Write statement")).toBeTruthy();
    expect(screen.getByText("Verify SELECT")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Apply suggestion/ }));
    expect(onApply).toHaveBeenCalledWith({
      writeSql: "UPDATE orders SET a=1 WHERE id=1",
      selectSql: "SELECT * FROM orders WHERE id=1",
    });
  });

  it("shows a bounded radius, a matching select and a single suggestion without an apply button", () => {
    renderUi(
      <>
        <AiReviewCard
          review={review({
            estimatedBlastRadius: "1 row",
            selectMatchesWrite: true,
            suggestedWriteSql: "DELETE FROM orders WHERE id=2",
          })}
        />
        <AiReviewCard
          review={review({ suggestedSelectSql: "SELECT 1 FROM customers" })}
        />
      </>,
    );
    expect(screen.getByText("Blast radius: 1 row")).toBeTruthy();
    expect(screen.getByText("SELECT matches WRITE")).toBeTruthy();
    expect(screen.getByText("DELETE FROM orders WHERE id=2")).toBeTruthy();
    expect(screen.getByText("SELECT 1 FROM customers")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Apply suggestion/ }),
    ).toBeNull();
  });
});

describe("PreviewTable", () => {
  const base: QueryResult = {
    columns: [
      { name: "id", type: "int", isMasked: false },
      { name: "email", type: "text", isMasked: true, maskingType: "EMAIL" },
      { name: "meta", type: "json", isMasked: false },
    ],
    rows: [{ id: 1, email: "x***", meta: { a: 1 } }],
    totalRows: 1,
    executionTimeMs: 7,
    truncated: false,
    masked: false,
  } as unknown as QueryResult;

  it("renders a table with cell values, masked columns and a singular row count", () => {
    renderUi(<PreviewTable result={base} dbType="postgres" />);
    expect(screen.getByText(/1 row · 7ms/)).toBeTruthy();
    expect(screen.queryByText(/truncated/)).toBeNull();
    expect(screen.queryByText("PHI masked")).toBeNull();
    expect(screen.getByText("x***")).toBeTruthy();
    expect(screen.getByText('{"a":1}')).toBeTruthy();
    expect(screen.getByText("email")).toBeTruthy();
  });

  it("renders null/undefined cells empty and reports truncation and masking", () => {
    renderUi(
      <PreviewTable
        result={
          {
            ...base,
            rows: [{ id: null, email: undefined, meta: "plain" }],
            totalRows: 2,
            truncated: true,
            masked: true,
          } as unknown as QueryResult
        }
      />,
    );
    expect(screen.getByText(/2 rows · 7ms · truncated/)).toBeTruthy();
    expect(screen.getByText("PHI masked")).toBeTruthy();
    expect(screen.getByText("plain")).toBeTruthy();
  });

  it("says when a table query returned no columns", () => {
    renderUi(
      <PreviewTable
        result={{ ...base, columns: [] } as unknown as QueryResult}
      />,
    );
    expect(screen.getByText("Query returned no columns.")).toBeTruthy();
  });

  it("opens document stores in the JSON view", () => {
    renderUi(
      <PreviewTable
        result={{ ...base, columns: [] } as unknown as QueryResult}
        dbType="mongodb"
      />,
    );
    expect(screen.getByTestId("json-view").textContent).toBe("1 docs");
  });
});

describe("CodeBlock", () => {
  it("shows code, or (empty) when there is none", () => {
    renderUi(
      <>
        <CodeBlock label="Before" code="SELECT 1" color="red" />
        <CodeBlock label="After" code="" />
      </>,
    );
    expect(screen.getByText("SELECT 1")).toBeTruthy();
    expect(screen.getByText("(empty)")).toBeTruthy();
  });
});

describe("fmtDateTime", () => {
  it("formats stored UTC timestamps and passes through junk", () => {
    expect(fmtDateTime()).toBe("—");
    const expected = new Date("2026-01-02T03:04:05Z").toLocaleString();
    expect(fmtDateTime("2026-01-02 03:04:05")).toBe(
      new Date("2026-01-02 03:04:05Z").toLocaleString(),
    );
    expect(fmtDateTime("2026-01-02T03:04:05Z")).toBe(expected);
    expect(fmtDateTime("2026-01-02T03:04:05+00:00")).toBe(expected);
    expect(fmtDateTime("not a date")).toBe("not a date");
  });
});
