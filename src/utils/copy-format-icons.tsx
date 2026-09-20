import {
  IconFileTypeCsv,
  IconTableExport,
  IconJson,
  IconMarkdown,
  IconDatabaseImport,
  IconList,
  IconQuote,
  IconBlockquote,
  IconClipboardCopy,
} from "@tabler/icons-react";
import type { CopyFormat } from "../types";

/**
 * The icon for a "Copy as" format.
 *
 * Derived rather than stored. A deployment can define its own formats through
 * the `COPY_FORMATS` env var (see `server/config/copy-formats.ts`), and that
 * catalogue arrives as JSON over `/api/config` — so there is nowhere in the
 * data for a React component to live, and any format the code has never seen
 * still has to render something sensible.
 *
 * So the mapping keys off what a format *is*: its `builtin` formatter, or for
 * the separator-based ones, how it quotes. Everything else falls back to the
 * generic clipboard glyph, which is the honest answer for a custom extractor
 * this build knows nothing about.
 *
 * Both copy menus in `results-grid.tsx` read this, so a format looks the same
 * in the toolbar dropdown and in the per-column right-click menu.
 *
 * This returns an element rather than a component type on purpose: picking a
 * component during render remounts it on every pass, which `react-hooks`
 * rightly rejects.
 */
export function copyFormatIcon(format: CopyFormat, size = 14) {
  const props = { size, stroke: 1.6 };
  switch (format.builtin) {
    case "csv":
      return <IconFileTypeCsv {...props} />;
    case "tsv":
      return <IconTableExport {...props} />;
    case "json":
      return <IconJson {...props} />;
    case "markdown":
      return <IconMarkdown {...props} />;
    case "sql-insert":
      return <IconDatabaseImport {...props} />;
  }
  // Separator-based (DataGrip-style) extractors: the quoting is the thing that
  // distinguishes them in the menu, so it is what the glyph should show.
  switch (format.template?.quote) {
    case "single":
      return <IconQuote {...props} />;
    case "double":
      return <IconBlockquote {...props} />;
    case "none":
      return <IconList {...props} />;
  }
  return <IconClipboardCopy {...props} />;
}
