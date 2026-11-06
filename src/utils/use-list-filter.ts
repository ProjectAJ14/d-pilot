import { useState } from "react";

/** Client-side search + paging over a fully loaded list. */
export function useListFilter<T>(
  items: T[],
  text: (item: T) => string,
  pageSize = 25,
) {
  const [query, setQueryState] = useState("");
  const [requested, setPage] = useState(1);
  const q = query.trim().toLowerCase();
  const matches = q
    ? items.filter((i) => text(i).toLowerCase().includes(q))
    : items;
  const totalPages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(requested, totalPages);
  return {
    query,
    setQuery: (v: string) => {
      setQueryState(v);
      setPage(1);
    },
    page,
    setPage,
    pageItems: matches.slice((page - 1) * pageSize, page * pageSize),
    total: matches.length,
    totalPages,
  };
}
