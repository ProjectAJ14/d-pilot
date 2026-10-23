import { useEffect, useSyncExternalStore } from "react";
import { Group, Text } from "@mantine/core";
import { IconPlugConnectedX } from "@tabler/icons-react";
import { useStore } from "../../store";
import { api } from "../../utils/api-client";
import {
  bannerMessage,
  startReachabilityWatch,
} from "../../utils/server-reachability";

const RETRY_MS = 10_000;

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};

/**
 * One sticky line while the D-Pilot server can't be reached (api-client raises
 * `serverUnreachable`), in place of a toast per failed call. It retries
 * /api/health every few seconds and on the browser's `online` event; the first
 * answer lowers the flag and the banner goes away on its own.
 */
export function ServerUnreachableBanner() {
  const unreachable = useStore((s) => s.serverUnreachable);
  const hint = useStore((s) => s.config.networkHint);
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine);

  useEffect(() => {
    if (!unreachable) return;
    // api.ping goes through the client, which clears the flag on any response.
    return startReachabilityWatch({
      ping: api.ping,
      intervalMs: RETRY_MS,
      addOnline: (cb) => window.addEventListener("online", cb),
      removeOnline: (cb) => window.removeEventListener("online", cb),
    });
  }, [unreachable]);

  // The live region is always mounted, so screen readers announce the text
  // when it appears rather than missing a region that arrived with it.
  return (
    <div role="status" aria-live="polite" style={{ flexShrink: 0 }}>
      {unreachable && (
        <Group
          gap="xs"
          wrap="nowrap"
          px="md"
          py={6}
          style={{
            position: "sticky",
            top: 0,
            zIndex: 200,
            background: "var(--mantine-color-orange-light)",
            borderBottom: "1px solid var(--mantine-color-orange-outline)",
          }}
        >
          <IconPlugConnectedX
            size={16}
            aria-hidden
            style={{ color: "var(--warning)", flexShrink: 0 }}
          />
          <Text size="sm" c="var(--text)">
            {bannerMessage(online, hint)}
          </Text>
        </Group>
      )}
    </div>
  );
}
