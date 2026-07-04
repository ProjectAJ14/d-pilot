/**
 * Helpers for recognizing ISO-8601 datetime values and rendering them in the
 * viewer's local time zone — so a stored UTC value like
 * "2026-07-04T11:20:01.850Z" can be shown as the wall-clock time the user
 * actually reads it in.
 */

// ISO-8601 with a time component. Date-only strings ("2026-07-04") are
// deliberately excluded: converting them across zones would shift the calendar
// day, which is misleading rather than helpful.
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function isIsoDateTime(value: unknown): value is string {
  return typeof value === "string" && ISO_DATETIME_RE.test(value.trim());
}

/** True when the string carries an explicit zone (Z or ±hh:mm) — i.e. its
 *  absolute instant is unambiguous and converting to local time is meaningful. */
function hasExplicitZone(value: string): boolean {
  return /(Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

// One formatter for the session; the browser's zone doesn't change mid-session.
let localFormatter: Intl.DateTimeFormat | null = null;
function formatter(): Intl.DateTimeFormat {
  if (!localFormatter) {
    // Combining explicit components (not dateStyle/timeStyle) so timeZoneName
    // is allowed — the latter combination throws in some engines.
    localFormatter = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  }
  return localFormatter;
}

export interface DateTimeParts {
  /** Human-readable local time, e.g. "Jul 4, 2026, 10:24:20 AM GMT+5:30". */
  local: string;
  /** The original source value, unchanged. */
  source: string;
  /** Label for the source line — "Source (UTC)" for Z, "Source" for offsets. */
  sourceLabel: string;
  /** True when the source carried no zone, so no real conversion happened. */
  naive: boolean;
}

/**
 * Converts an ISO datetime into structured parts for display in the browser's
 * local time zone. Returns null when the value isn't a recognizable datetime,
 * so callers can fall back to default behavior.
 */
export function datetimeParts(value: unknown): DateTimeParts | null {
  if (!isIsoDateTime(value)) return null;
  const raw = value.trim();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;

  return {
    local: formatter().format(d),
    source: raw,
    // Label as UTC only when the source actually ends in Z.
    sourceLabel: /Z$/.test(raw) ? "Source (UTC)" : "Source",
    naive: !hasExplicitZone(raw),
  };
}
