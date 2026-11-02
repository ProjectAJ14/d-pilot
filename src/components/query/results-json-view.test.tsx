// @vitest-environment jsdom
import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderUi } from "../../utils/dom.testing";
import { ResultsJsonView } from "./results-json-view";

const handle = {
  search: vi.fn(function (this: unknown) {
    return this;
  }),
  scrollToPaths: vi.fn(function (this: unknown) {
    return this;
  }),
};
const viewProps: Record<string, unknown>[] = [];
const searchProps: Record<string, unknown>[] = [];

vi.mock("react-obj-view/dist/react-obj-view.css", () => ({}));
vi.mock("react-obj-view", () => ({
  extendTheme: (base: object, extra: object) => ({ ...base, ...extra }),
  themeGitHubLight: {},
  ObjectView: (props: { ref: { current: unknown }; [k: string]: unknown }) => {
    props.ref.current = handle;
    viewProps.push(props);
    return <div data-testid="object-view" />;
  },
  SearchComponent: (props: Record<string, unknown>) => {
    searchProps.push(props);
    return props.active ? (
      <button onClick={props.onClose as () => void}>close search</button>
    ) : null;
  },
}));

const last = <T,>(a: T[]) => a[a.length - 1];

beforeEach(() => {
  viewProps.length = 0;
  searchProps.length = 0;
});

describe("ResultsJsonView", () => {
  it("hands the rows to the viewer and counts documents", () => {
    const rows = [{ id: 1 }, { id: 2 }];
    renderUi(<ResultsJsonView rows={rows} />);
    expect(screen.getByText("2 documents")).toBeTruthy();
    expect((last(viewProps).valueGetter as () => unknown)()).toBe(rows);
    expect(last(viewProps).expandLevel).toBe(1);
    // The ref is not populated during the first render.
    expect(searchProps[0].handleSearch).toBeUndefined();
  });

  it("uses the singular for one document", () => {
    renderUi(<ResultsJsonView rows={[{ id: 1 }]} />);
    expect(screen.getByText("1 document")).toBeTruthy();
  });

  it("expands and collapses all levels", () => {
    const { container } = renderUi(<ResultsJsonView rows={[]} />);
    const buttons = container.querySelectorAll("button");
    fireEvent.click(buttons[1]);
    expect(last(viewProps).expandLevel).toBe(3);
    fireEvent.click(buttons[2]);
    expect(last(viewProps).expandLevel).toBe(1);
  });

  it("opens search from the toolbar and binds it to the viewer", () => {
    const { container } = renderUi(<ResultsJsonView rows={[]} />);
    fireEvent.click(container.querySelectorAll("button")[0]);
    const props = last(searchProps);
    expect(props.active).toBe(true);
    expect((props.handleSearch as () => unknown)()).toBe(handle);
    expect((props.scrollToPaths as () => unknown)()).toBe(handle);
    fireEvent.click(screen.getByText("close search"));
    expect(last(searchProps).active).toBe(false);
  });

  it("opens search on Ctrl/Cmd+F only", () => {
    const { container } = renderUi(<ResultsJsonView rows={[]} />);
    const root = container.querySelector("[tabindex='-1']")!;
    act(() => {
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "f" }));
    });
    expect(last(searchProps).active).toBe(false);
    act(() => {
      root.dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", ctrlKey: true }),
      );
    });
    expect(last(searchProps).active).toBe(true);
    fireEvent.click(screen.getByText("close search"));
    const ev = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      cancelable: true,
    });
    act(() => {
      root.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(last(searchProps).active).toBe(true);
  });
});
