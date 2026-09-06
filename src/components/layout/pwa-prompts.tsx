import { useCallback, useEffect, useState } from "react";
import { Button, Group, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconDownload, IconRefresh } from "@tabler/icons-react";
import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * The two pieces of PWA-specific UI. Everything else about the installed app is
 * identical to the browser build by design — same layout, same routes, same
 * behavior — so these stay deliberately unobtrusive.
 */

const UPDATE_NOTIFICATION_ID = "pwa-update";

/**
 * Tells the user when a new build is waiting, and reloads only when they say so.
 * An unattended reload would drop open editor tabs and any running query, which
 * is why the worker is registered with `registerType: "prompt"`.
 */
export function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError(error) {
      // Registration fails on http:// origins other than localhost. The app
      // works normally without a worker, so this is logged, not surfaced.
      console.warn("[pwa] service worker registration failed", error);
    },
  });

  const reloadNow = useCallback(async () => {
    notifications.update({
      id: UPDATE_NOTIFICATION_ID,
      title: "Reloading\u2026",
      message: null,
      loading: true,
      autoClose: false,
      withCloseButton: false,
    });

    // `updateServiceWorker` only *asks* the waiting worker to activate — the
    // reload is left to vite-plugin-pwa's `controlling` listener, which never
    // fires when there is no waiting worker to activate (another tab already
    // took the update, or the worker never took control), so the button reads
    // as dead. Wait for control to change, then reload regardless.
    const controllerChanged = new Promise<void>((resolve) => {
      navigator.serviceWorker?.addEventListener(
        "controllerchange",
        () => resolve(),
        { once: true },
      );
    });
    await updateServiceWorker(true);
    await Promise.race([
      controllerChanged,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);

    window.location.reload();
  }, [updateServiceWorker]);

  useEffect(() => {
    if (!needRefresh) return;

    notifications.show({
      id: UPDATE_NOTIFICATION_ID,
      title: "New version available",
      color: "primary",
      icon: <IconRefresh size={18} />,
      autoClose: false,
      withCloseButton: true,
      onClose: () => setNeedRefresh(false),
      message: (
        <Group gap={10} align="center" mt={4} wrap="nowrap">
          <Text size="xs" c="var(--muted2)" style={{ flex: 1 }}>
            Reload to pick it up. Open tabs are restored; unsaved results are
            not.
          </Text>
          <Button size="compact-xs" onClick={() => void reloadNow()}>
            Reload
          </Button>
        </Group>
      ),
    });

    return () => {
      // notifications.hide returns the id, which is not a valid cleanup value.
      notifications.hide(UPDATE_NOTIFICATION_ID);
    };
  }, [needRefresh, setNeedRefresh, reloadNow]);

  return null;
}

// Not in lib.dom yet, and Safari/Firefox never fire it — the hook below simply
// stays idle there and the browser's own install affordance takes over.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function useInstallPrompt() {
  const [promptEvent, setPromptEvent] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const capture = (event: Event) => {
      // Suppress the browser's own mini-infobar so the footer button is the
      // single, predictable place this is offered from.
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const clear = () => setPromptEvent(null);

    window.addEventListener("beforeinstallprompt", capture);
    window.addEventListener("appinstalled", clear);
    return () => {
      window.removeEventListener("beforeinstallprompt", capture);
      window.removeEventListener("appinstalled", clear);
    };
  }, []);

  const install = useCallback(async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    // The event is single-use whether accepted or dismissed; the browser fires
    // a fresh one on a later visit if the app is still not installed.
    setPromptEvent(null);
  }, [promptEvent]);

  return { canInstall: promptEvent !== null, install };
}

/**
 * Footer affordance, rendered only while the browser says the app is
 * installable — so it disappears once installed, and never shows in the
 * installed window itself.
 */
export function InstallAppButton() {
  const { canInstall, install } = useInstallPrompt();

  if (!canInstall) return null;

  return (
    <>
      <div style={{ width: 1, height: 16, background: "var(--border)" }} />
      <Tooltip label="Install as a desktop app">
        <button
          type="button"
          onClick={() => void install()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: "none",
            border: "none",
            padding: 0,
            font: "inherit",
            color: "inherit",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <IconDownload size={13} />
          Install
        </button>
      </Tooltip>
    </>
  );
}
