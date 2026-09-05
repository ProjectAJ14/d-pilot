import { SegmentedControl, Tooltip, Center } from "@mantine/core";
import { useMantineColorScheme } from "@mantine/core";
import { IconSun, IconMoon, IconDeviceDesktop } from "@tabler/icons-react";

/**
 * Light / Dark / System picker.
 *
 * `auto` is the default and means "follow the OS" — Mantine resolves it against
 * `prefers-color-scheme` and keeps following it if the OS flips mid-session, so
 * there is nothing to persist for that case beyond the choice itself. The value
 * is stored under `mantine-color-scheme-value`, which the pre-paint script in
 * index.html reads to set the scheme before the first frame.
 */
export function ColorSchemeToggle() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();

  return (
    <SegmentedControl
      fullWidth
      size="xs"
      radius="sm"
      value={colorScheme}
      onChange={(value) =>
        setColorScheme(value as "light" | "dark" | "auto")
      }
      data={[
        {
          value: "light",
          label: (
            <Tooltip label="Light" openDelay={400}>
              <Center aria-label="Light theme">
                <IconSun size={14} />
              </Center>
            </Tooltip>
          ),
        },
        {
          value: "dark",
          label: (
            <Tooltip label="Dark" openDelay={400}>
              <Center aria-label="Dark theme">
                <IconMoon size={14} />
              </Center>
            </Tooltip>
          ),
        },
        {
          value: "auto",
          label: (
            <Tooltip label="Match system" openDelay={400}>
              <Center aria-label="Match system theme">
                <IconDeviceDesktop size={14} />
              </Center>
            </Tooltip>
          ),
        },
      ]}
    />
  );
}
