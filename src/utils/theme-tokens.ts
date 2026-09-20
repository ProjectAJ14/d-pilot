/**
 * Read the design system's resolved values back out of CSS, for the one kind of
 * surface that cannot consume a CSS variable.
 *
 * Almost everything in the app reads `var(--token)` and follows the ground for
 * free: our own components, Mantine, AG Grid (via the `--ag-*` properties in
 * global.css) and react-obj-view all do. Monaco does not — it parses its theme
 * colours into a canvas-ish renderer at `defineTheme()` time and wants literal
 * hex. That used to mean a hand-maintained copy of the whole palette in
 * `monaco-setup.ts`, which is exactly the kind of second source of truth that
 * makes a re-theme a scavenger hunt.
 *
 * So instead of copying the values, read them. `readGround()` mounts a hidden
 * probe element carrying `data-mantine-color-scheme`, which is why the ground
 * blocks in tokens.css match on a bare attribute selector as well as on `:root`
 * — the probe resolves whichever ground you ask for, including the one that is
 * not currently active. That is how both Monaco themes get defined up front,
 * with no re-definition when the user flips the toggle.
 *
 * Only tokens whose value is a plain colour can come back through here.
 * `--spot-soft` and friends are `color-mix()` expressions, which compute to the
 * unevaluated expression string; use `withAlpha()` on a flat token instead.
 */

export type Ground = "light" | "dark";

/**
 * Resolve a set of custom properties against one ground.
 *
 * The probe must be in the document for the cascade to apply to it, but it is
 * `display: none` and removed synchronously, so it never paints and never
 * triggers layout of anything else.
 */
export function readGround(
  ground: Ground,
  names: readonly string[],
): Record<string, string> {
  const probe = document.createElement("div");
  probe.setAttribute("data-mantine-color-scheme", ground);
  probe.style.display = "none";
  document.body.appendChild(probe);
  try {
    const computed = getComputedStyle(probe);
    return Object.fromEntries(
      names.map((name) => [name, computed.getPropertyValue(name).trim()]),
    );
  } finally {
    probe.remove();
  }
}

/** `#79d5c4` → `79d5c4`. Monaco's token rules want the hex without its hash. */
export function bare(color: string): string {
  return color.replace(/^#/, "");
}

/**
 * `#79d5c4` + 0.18 → `#79d5c42e`. Monaco accepts 8-digit hex for the handful of
 * colours that need to sit translucently over the text (selection, highlights).
 */
export function withAlpha(color: string, alpha: number): string {
  const byte = Math.round(Math.min(Math.max(alpha, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${byte}`;
}
