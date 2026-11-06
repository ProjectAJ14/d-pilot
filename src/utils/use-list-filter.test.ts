// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useListFilter } from "./use-list-filter";

const nums = Array.from({ length: 30 }, (_, i) => `item-${i + 1}`);

describe("useListFilter", () => {
  it("pages and filters case-insensitively, resetting the page on search", () => {
    const { result } = renderHook(() => useListFilter(nums, (s) => s, 10));
    expect(result.current.pageItems).toHaveLength(10);
    expect(result.current.totalPages).toBe(3);
    act(() => result.current.setPage(3));
    expect(result.current.pageItems[0]).toBe("item-21");
    act(() => result.current.setQuery("  ITEM-2 "));
    expect(result.current.page).toBe(1);
    expect(result.current.total).toBe(11);
    expect(result.current.pageItems[0]).toBe("item-2");
    act(() => result.current.setQuery("nope"));
    expect(result.current.total).toBe(0);
    expect(result.current.totalPages).toBe(1);
    expect(result.current.pageItems).toEqual([]);
  });

  it("clamps the page when the list shrinks", () => {
    const { result, rerender } = renderHook(
      ({ items }) => useListFilter(items, (s) => s, 10),
      { initialProps: { items: nums } },
    );
    act(() => result.current.setPage(3));
    rerender({ items: nums.slice(0, 12) });
    expect(result.current.page).toBe(2);
    expect(result.current.pageItems).toEqual(["item-11", "item-12"]);
  });

  it("defaults to 25 per page", () => {
    const { result } = renderHook(() => useListFilter(nums, (s) => s));
    expect(result.current.pageItems).toHaveLength(25);
  });
});
