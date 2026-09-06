import { SegmentedControl, Tooltip, Center, useMantineColorScheme } from "@mantine/core";
import { IconSun, IconMoon, IconDeviceDesktop } from "@tabler/icons-react";

/**
 * Light / Dark / System picker.
 *
 * `auto` is the default and means "follow the OS" — Mantine resolves it against
 * `prefers-color-scheme` and keeps following it if the OS flips mid-session, so
 * there is nothing to persist for that case beyond the choice itself. The value
 * is stored under `mantine-color-scheme-value`, which the pre-paint script in
 * index.html reads to set the scheme before the first frame.
 *
 * Lives in the top bar rather than inside a menu: switching theme is something
 * people do by eye, and a control you have to open a dropdown to find gets used
 * once and forgotten.
 */
export function ColorSchemeToggle({ fullWidth = false }: { fullWidth?: boolean }) {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  const option = (
    value: "light" | "dark" | "auto",
    label: string,
    Icon: typeof IconSun,
  ) => ({
    value,
    label: (
      <Tooltip label={label} openDelay={400}>
        <Center aria-label={label}>
          <Icon size={14} />
        </Center>
      </Tooltip>
    ),
  });

  return (
    <SegmentedControl
      fullWidth={fullWidth}
      size="xs"
      radius="sm"
      value={colorScheme}
      onChange={(value) => setColorScheme(value as "light" | "dark" | "auto")}
      styles={{
        root: { background: "var(--surface2)", border: "1px solid var(--border)" },
        // The thumb is the only opaque surface in the control, so it has to be
        // --surface (not Mantine's default white) to read in both schemes.
        indicator: { background: "var(--surface)" },
      }}
      data={[
        option("light", "Light theme", IconSun),
        option("dark", "Dark theme", IconMoon),
        option("auto", "Match system", IconDeviceDesktop),
      ]}
    />
  );
}
