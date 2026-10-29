import { useStore } from "../store";
import { api } from "./api-client";

/** The browser tab title: the app name, plus the login tagline when set. */
export const tabTitle = (appName: string, tagline?: string | null): string =>
  tagline ? `${appName} — ${tagline}` : appName;

/**
 * (Re)load the public `/api/config` into the store and apply the branding that
 * lives outside React (favicon, iOS home-screen title). Called on boot and again
 * after an admin saves settings or connections, so changes show without a reload.
 */
export async function loadAppConfig(): Promise<void> {
  const cfg = await api.getConfig();
  useStore.getState().setConfig(cfg);
  if (cfg.faviconUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = cfg.faviconUrl;
  }
  // The tab title follows the branding; index.html's static title is only
  // the first-paint fallback. The iOS name below stays the bare app name.
  document.title = tabTitle(cfg.appName, cfg.loginTagline);
  // iOS takes the home-screen name from this tag rather than the
  // manifest, so branding has to be applied to it at runtime too.
  if (cfg.appName) {
    document
      .querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-title"]')
      ?.setAttribute("content", cfg.appName);
  }
}

/**
 * Reload the connection list, keeping the active one if it still exists, else
 * the first — or none once the last one is gone, so the UI shows its empty
 * state rather than a deleted connection.
 */
export async function loadConnections(): Promise<void> {
  const conns = await api.getConnections();
  const { setConnections, activeConnectionId, setActiveConnection } =
    useStore.getState();
  setConnections(conns);
  if (!conns.some((c) => c.id === activeConnectionId))
    setActiveConnection(conns[0]?.id ?? null);
}

/**
 * Runs `reload` each time the D-Pilot server comes back (serverUnreachable
 * true → false), so an app that booted with the VPN off fills itself in
 * without a manual reload. Returns the unsubscribe, for an effect's cleanup.
 */
export function reloadOnRecovery(reload: () => void): () => void {
  return useStore.subscribe((s, prev) => {
    if (prev.serverUnreachable && !s.serverUnreachable) reload();
  });
}
